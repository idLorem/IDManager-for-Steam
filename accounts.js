const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const swap = require('./swap');

// The accounts live in accounts.txt (login:password or login:password:shared_secret, plain text, as before).
// What the program learns about them (SteamID64, custom ID, whether they are used in the search) is kept
// in accounts_info.json, which holds no passwords. The window never gets a password or a secret back.
const FILES = { accounts: 'accounts.txt', info: 'accounts_info.json' };
const HEADER = '# One account per line: login:password or login:password:shared_secret (for automatic Steam Guard codes).\n# Stored as plain text, do not share this file.\n';
const SECRET = /^(.*):([A-Za-z0-9+/]{27}=)$/; // a shared_secret is 20 bytes in base64: 28 characters ending in "="
const timing = { gap: 2000 }; // pause between two logins of a check: Steam limits logins too
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseLine(l) {
  const i = l.indexOf(':');
  if (i < 1) return null;
  const login = l.slice(0, i).trim();
  let password = l.slice(i + 1).replace(/\r$/, ''), secret = '';
  const m = SECRET.exec(password.trimEnd()); // a space after a pasted secret must not turn it into part of the password
  if (m) { password = m[1]; secret = m[2]; }
  return login && password ? { login, password, secret } : null;
}

const rawLines = (dir) => {
  try { return fs.readFileSync(path.join(dir, FILES.accounts), 'utf8').replace(/^﻿/, '').split(/\r?\n/); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } // only a missing file is "empty": any other read error must stop add/remove, which would rewrite the file from nothing
};
const isData = (l) => l.trim() && !l.trim().startsWith('#');
// a half-written file must never replace a good one
const writeAtomic = (file, text) => { fs.writeFileSync(file + '.tmp', text, 'utf8'); fs.renameSync(file + '.tmp', file); };
const saveLines = (dir, ls) => writeAtomic(path.join(dir, FILES.accounts), ls.join('\n').replace(/\n*$/, '\n'));

// { accounts: [{login, password, secret}], bad: lines that are not login:password, repeated logins are ignored }
function loadAccounts(dir) {
  const seen = new Set(), accounts = [];
  let bad = 0;
  for (const l of rawLines(dir).filter(isData)) {
    const a = parseLine(l);
    if (!a) { bad++; continue; }
    if (seen.has(a.login)) continue;
    seen.add(a.login); accounts.push(a);
  }
  return { accounts, bad };
}

const readInfo = (dir) => {
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, FILES.info), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
function patch(dir, login, fields) {
  const info = readInfo(dir);
  info[login] = { ...info[login], ...fields };
  writeAtomic(path.join(dir, FILES.info), JSON.stringify(info, null, 1));
}

// what the window shows: no passwords, no secrets
function list(dir) {
  const info = readInfo(dir);
  return loadAccounts(dir).accounts.map(({ login, secret }) => {
    const m = info[login] || {};
    return { login, secret: !!secret, use: !!m.stale || m.use !== false, steamId: m.steamId || '', id: m.id || '', guard: !!m.guard, err: m.err || '', stale: !!m.stale };
  });
}
const selected = (dir) => list(dir).filter((a) => a.use && !a.stale).map((a) => a.login);
const toCheck = (dir) => list(dir).filter((a) => a.use || a.stale).map((a) => a.login); // an account that needs a check can only be selected by the check itself

// Adds accounts from pasted text. A known login gets its password (and secret) replaced.
function add(dir, text) {
  const incoming = new Map();
  let bad = 0;
  for (const l of String(text).split(/\r?\n/).filter(isData)) {
    const a = parseLine(l);
    if (a) incoming.set(a.login, a); else bad++;
  }
  let ls = rawLines(dir);
  if (!ls.some((l) => l.trim())) ls = HEADER.split('\n');
  const known = new Set();
  const out = ls.map((l) => {
    const a = isData(l) && parseLine(l);
    if (!a || !incoming.has(a.login) || known.has(a.login)) return l;
    known.add(a.login);
    const n = incoming.get(a.login);
    return n.login + ':' + n.password + (n.secret ? ':' + n.secret : '');
  });
  let added = 0;
  for (const n of incoming.values()) if (!known.has(n.login)) { out.push(n.login + ':' + n.password + (n.secret ? ':' + n.secret : '')); added++; }
  if (incoming.size) saveLines(dir, out);
  return { added, updated: known.size, bad };
}

function remove(dir, logins) {
  const gone = new Set(logins);
  saveLines(dir, rawLines(dir).filter((l) => { const a = isData(l) && parseLine(l); return !(a && gone.has(a.login)); }));
  const info = readInfo(dir);
  logins.forEach((l) => delete info[l]);
  writeAtomic(path.join(dir, FILES.info), JSON.stringify(info, null, 1));
}

// logins: which accounts, or null for all
function setUse(dir, logins, use) {
  const info = readInfo(dir);
  for (const { login } of loadAccounts(dir).accounts) if ((!logins || logins.includes(login)) && !(info[login] && info[login].stale)) info[login] = { ...info[login], use: !!use }; // a marked account stays ticked for the check until it is checked
  writeAtomic(path.join(dir, FILES.info), JSON.stringify(info, null, 1));
}

// The one place where a password goes to the window, and only when the user clicks an account.
const reveal = (dir, login) => {
  const a = loadAccounts(dir).accounts.find((x) => x.login === login);
  if (!a) throw Object.assign(new Error('unknown account'), { key: 'accMissing', p: { login } });
  return { password: a.password, secret: a.secret };
};

// Encrypted config: "VSA1." + base64(salt 16 | iv 12 | GCM tag 16 | data). The key comes from the password the user types (scrypt).
// The data is the account lines, as in accounts.txt. A wrong password or a changed file fails the GCM check.
const MAGIC = 'VSA1.';
const keyOf = (pw, salt) => crypto.scryptSync(String(pw), salt, 32);
const bad = (key) => Object.assign(new Error(key), { key });

function exportText(dir, password) {
  const pw = String(password || '');
  if (pw.length < 5 || !/\d/.test(pw) || !/\p{Lu}/u.test(pw)) throw bad('passWeak'); // 5+ characters with a digit and a capital letter: the file holds passwords and 2FA secrets
  const lines = loadAccounts(dir).accounts.map((a) => a.login + ':' + a.password + (a.secret ? ':' + a.secret : ''));
  if (!lines.length) throw bad('noAccounts');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(password, salt), iv);
  const data = Buffer.concat([c.update(lines.join('\n'), 'utf8'), c.final()]);
  return MAGIC + Buffer.concat([salt, iv, c.getAuthTag(), data]).toString('base64');
}

function importText(dir, text, password) {
  const t = String(text).replace(/\s+/g, '');
  if (!t.startsWith(MAGIC)) throw bad('badConfig');
  const b = Buffer.from(t.slice(MAGIC.length), 'base64');
  if (b.length < 45) throw bad('badConfig');
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(password, b.subarray(0, 16)), b.subarray(16, 28));
    d.setAuthTag(b.subarray(28, 44));
    plain = Buffer.concat([d.update(b.subarray(44)), d.final()]).toString('utf8');
  } catch { throw bad('badPass'); }
  return add(dir, plain);
}

let stopped = false;
const rateLimited = (e) => [84, 87].includes(e.eresult) || /RateLimitExceeded|Throttle/i.test(e.message); // EResult 84 RateLimitExceeded, 87 AccountLoginDeniedThrottle
let wake = () => {};

// Logs the accounts in one by one and stores each one's SteamID64 and custom ID. Both are known right after
// logon, so no web page is loaded. A login rate limit stops the whole batch: going on would only prolong it.
async function refresh(dir, logins, { log, askCode }, L = swap.libs()) {
  stopped = false;
  const stopP = new Promise((r) => { wake = r; });
  const todo = loadAccounts(dir).accounts.filter((a) => !logins || logins.includes(a.login));
  let ok = 0, fail = 0;
  for (const [i, acc] of todo.entries()) {
    if (stopped) break;
    if (i) await sleep(timing.gap);
    let guard = false;
    const t0 = Date.now();
    try {
      const p = swap.session(acc, acc.login, log, (...a) => { guard = true; return askCode(...a); }, L);
      // Stop must not wait for a login stuck in reconnects or in a code prompt: a session that finishes late is closed
      const s = await Promise.race([p, stopP.then(() => { p.then(() => swap.drop(acc), () => {}); throw Object.assign(new Error('stopped'), { stopped: true }); })]);
      const steamId = s.user.steamID.getSteamID64(), id = swap.cleanId(s.user.vanityURL);
      // "needs a code" is known only from a real login: a cached session says nothing about it
      patch(dir, acc.login, { steamId, id, err: '', stale: false, ...(s.at >= t0 ? { guard } : {}) });
      log('accChecked', { login: acc.login, steamId, id });
      ok++;
    } catch (e) {
      if (e.stopped) break;
      patch(dir, acc.login, { err: e.message, ...(guard ? { guard } : {}) });
      log(e.key === 'loginCancelled' ? 'accCancelled' : 'accCheckFail', { login: acc.login, msg: e.message });
      fail++;
      if (rateLimited(e)) { log('accRateLimit'); break; }
    } finally { swap.drop(acc); }
  }
  log('refreshDone', { ok, fail });
  return { ok, fail };
}

// Removes the custom ID of one account for good (the profile falls back to /profiles/<SteamID64>).
// `expect` is the ID the user confirmed: if the account has another one now, nothing is changed.
async function clearId(dir, { login, id: expect }, { log, askCode }, L = swap.libs()) {
  const acc = loadAccounts(dir).accounts.find((a) => a.login === login);
  if (!acc) throw Object.assign(new Error('unknown account'), { key: 'accMissing', p: { login } });
  try {
    const s = await swap.session(acc, login, log, askCode, L);
    await swap.prepare(s, login, log);
    const id = s.edit.current;
    if (!id) { patch(dir, login, { id: '' }); log('noIdToClear', { login }); return ''; }
    if (expect && id !== expect) {
      patch(dir, login, { id });
      throw Object.assign(new Error('ID changed'), { key: 'clearChanged', p: { login, id, expect } });
    }
    let setErr;
    try { await swap.setId(s, ''); } catch (e) { setErr = e; } // Steam answers "error setting account details" even when the ID is gone: only the page afterwards tells
    s.user.vanityURL = ''; // so that prepare() opens /profiles/<SteamID64>
    await swap.prepare(s, login, log);
    patch(dir, login, { id: s.edit.current });
    // an empty ID is only a request: success means Steam really shows none
    if (s.edit.current) throw setErr || Object.assign(new Error('ID kept'), { key: 'clearKept', p: { login, id: s.edit.current } });
    log('idCleared', { login, id });
    return id;
  } finally { swap.drop(acc); }
}

// Sets the custom ID of one account by hand. Success only when the profile page shows the new ID afterwards.
async function setOwnId(dir, { login, id }, { log, askCode }, L = swap.libs()) {
  id = swap.cleanId(id);
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(id)) throw Object.assign(new Error('bad ID'), { key: 'badId', p: { id } });
  const acc = loadAccounts(dir).accounts.find((a) => a.login === login);
  if (!acc) throw Object.assign(new Error('unknown account'), { key: 'accMissing', p: { login } });
  try {
    const s = await swap.session(acc, login, log, askCode, L);
    await swap.prepare(s, login, log);
    if (s.edit.current !== id) await swap.setIdChecked(s, id);
    patch(dir, login, { id });
    log('idSet', { login, id });
    return id;
  } finally { swap.drop(acc); }
}

module.exports = { loadAccounts, parseLine, list, selected, toCheck, add, remove, setUse, patch, refresh, clearId, setOwnId, reveal, exportText, importText, rateLimited, stop: () => { stopped = true; wake(); }, timing, FILES, HEADER };
