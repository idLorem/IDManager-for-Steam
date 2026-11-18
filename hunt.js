const fs = require('fs');
const path = require('path');
const swap = require('./swap');
const proxy = require('./proxy');
const { loadAccounts, list: listAccounts, rateLimited, HEADER } = require('./accounts');

// Files live next to the program: ids.txt (what to look for), available.txt (free IDs found),
// accounts.txt (login:password[:shared_secret]) and claimed.txt (which account took which ID).
const FILES = { ids: 'ids.txt', available: 'available.txt', accounts: 'accounts.txt', claimed: 'claimed.txt', resume: 'hunt-progress.json' }; // resume: the ID a stopped search was on
const ID_RE = /^[A-Za-z0-9_-]{3,32}$/; // Steam custom URL: 3-32 chars; the case is kept exactly as typed
// shortcut: one request at a time, about 1.5 per second (Steam answers 429 faster than that); raise only if lists get huge
// stale: swap.js closes sessions after 10 minutes, so a ready account older than this is logged in again before it claims
const timing = { gap: 667, maxGap: 8000, timeout: 8000, tries: 2, rateWait: 5000, swapAfter: 0, retryWait: 600, stale: 8 * 60 * 1000, cooldown: 10 * 60 * 1000, perId: 3, loginPause: 60 * 1000, netFails: 5, proxyProbe: 5 * 60 * 1000 };
// netFails: this many requests in a row without any answer mean the proxy is dead; proxyProbe: how often a dead proxy is asked again while the search goes on without it
// loginPause: after Steam limits sign-ins, no new sign-in is tried for this long
// cooldown: Steam refuses an ID change on an account that changed it recently, so that account rests this long; perId: accounts tried for one ID
const COOLDOWN_RE = /error occurred while setting account details/i;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9', // Steam answers in the visitor's language, and the "not found" text is matched in English
  Cookie: 'Steam_Language=english',
};
const TEMPLATES = {
  ids: '# IDs to look for: one per line or separated by commas. The case is kept: AAA and AaA are checked separately.\n# Example: AAA, ABC, 321, _2d, -2d\n',
  available: '',
  accounts: HEADER,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// cur: the settings of the run in progress (timing plus the sliders); the sliders may change while it runs
const RANGE = { gap: [200, 10000], timeout: [2000, 60000], rateWait: [1000, 120000], swapAfter: [0, 20] }; // swapAfter: 429 answers before the next account logs in (0 = never)
const clean = (c = {}) => {
  const o = {};
  for (const k in RANGE) { const v = Number(c[k]); if (c[k] != null && Number.isFinite(v)) o[k] = Math.min(RANGE[k][1], Math.max(RANGE[k][0], v)); }
  return o;
};
let cur = { ...timing };
const tune = (c) => Object.assign(cur, clean(c));
let n429 = 0, cookie = '', netFails = 0, stop = false, nextAt = 0, gap = cur.gap, calm = true; // gap: the pause between requests. It doubles on a 429 that follows a good answer (calm), not on repeated 429s in a row, and shrinks back
// waits in small steps so the Stop button works during long pauses
async function wait(ms) { for (let t = 0; t < ms && !stop; t += 250) await sleep(Math.min(250, ms - t)); }
async function throttle() {
  const w = Math.max(0, nextAt - Date.now());
  nextAt = Date.now() + w + Math.max(gap, cur.gap); // the base may be raised by the slider during a run
  if (w) await wait(w);
}

const lines = (file, trim = true) => {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((s) => (trim ? s.trim() : s)).filter((s) => s.trim() && !s.trim().startsWith('#'));
  } catch { return []; }
};

// 'available' only on Steam's own "could not be found" page; anything unclear is 'unknown', never 'available'.
async function check(id, deps, log) {
  for (let i = 0; i <= cur.tries; i++) {
    await throttle();
    if (stop) return 'stopped';
    let res;
    try {
      res = await deps.fetch('https://steamcommunity.com/id/' + id + '/', { headers: cookie ? { ...HEADERS, Cookie: HEADERS.Cookie + '; ' + cookie } : HEADERS, signal: AbortSignal.timeout(cur.timeout) });
    } catch {
      // no answer at all: a proxy that keeps failing is given up, the search goes on without it (unless the proxy itself still answers: then Steam is slow)
      if (++netFails >= cur.netFails && proxy.live()) { netFails = 0; if (!(await deps.ping())) { proxy.setDown(true); log('proxyDown'); } }
      await wait(cur.retryWait); continue;
    }
    netFails = 0;
    if (res.status === 429) {
      n429++;
      const after = Number(res.headers.get('retry-after')) * 1000;
      const ms = Math.min(after || cur.rateWait * (i + 1), 300000);
      if (calm) gap = Math.min(gap * 2, Math.max(cur.maxGap, cur.gap));
      calm = false;
      log('huntWait', { s: Math.round(ms / 1000), g: (gap / 1000).toFixed(1) });
      await wait(ms);
      continue;
    }
    if (res.status !== 200) { await wait(cur.retryWait); continue; }
    calm = true;
    gap = Math.max(cur.gap, gap * 0.95); // calm again: speed back up slowly
    const text = await res.text();
    if (/could not be found/i.test(text)) return 'available';
    // 'taken' only for a real profile page (also private ones); any other 200 page (maintenance, consent, soft block) is unclear
    return /profile_header|g_rgProfileData/i.test(text) ? 'taken' : 'unknown';
  }
  return 'unknown';
}

const noGuard = async () => { throw new Error('Steam Guard is required, such accounts are not supported here'); };

// The IDs a search would check: valid ones from ids.txt without repeats and without those already in claimed.txt.
// bad: how many entries are not valid IDs. The same rule serves the search and the "count IDs" button.
function readIds(dir) {
  const f = (k) => path.join(dir, FILES[k]);
  const words = lines(f('ids')).flatMap((l) => l.split(/[\s,;]+/)).filter(Boolean);
  const bad = new Set(words.filter((w) => !ID_RE.test(w)));
  const claimedBefore = new Set(lines(f('claimed')).map((l) => l.split(':')[0]));
  const todo = [...new Set(words.filter((w) => ID_RE.test(w)))].filter((w) => !claimedBefore.has(w));
  return { todo, bad: bad.size };
}

// Looks for free IDs from ids.txt; each free one is saved to available.txt and taken by the next
// unused account from accounts.txt. An account that already has a custom ID is skipped (it would lose it).
async function runHunt(cfg, { log, progress = () => {}, dir, askCode = noGuard }, L = swap.libs(), deps = { fetch: proxy.search, ping: proxy.ping }) {
  cur = { ...timing, ...clean(cfg) };
  stop = false; nextAt = 0; gap = cur.gap; calm = true; netFails = 0; n429 = 0; cookie = '';
  const f = (k) => path.join(dir, FILES[k]);
  const { todo, bad } = readIds(dir);
  if (bad) log('badIds', { n: bad });
  if (!todo.length) throw Object.assign(new Error('no IDs to check'), { key: 'noIds' });
  // after Stop the next run goes on from the ID it stopped at (if that ID is still in the list)
  let from = 0;
  try { const r = JSON.parse(fs.readFileSync(f('resume'), 'utf8')); from = Math.max(0, todo.indexOf(r.id)); if (from) log('huntResume', { id: r.id, n: from }); } catch {}

  // cfg.logins: the accounts chosen in the manager; without it every account of accounts.txt is used
  const loaded = loadAccounts(dir);
  const chosen = loaded.accounts.filter((a) => !Array.isArray(cfg && cfg.logins) || cfg.logins.includes(a.login));
  // accounts already known to own an ID are not logged in at all (that would only cost sign-ins); "Check" in the manager refreshes what is known
  const owns = new Set(listAccounts(dir).filter((a) => a.id).map((a) => a.login));
  const accounts = chosen.filter((a) => !owns.has(a.login));
  if (chosen.length > accounts.length) log('huntSkipId', { n: chosen.length - accounts.length });
  if (loaded.bad) log('badAccounts', { n: loaded.bad });
  const availSet = new Set(lines(f('available')));
  // a file error (read-only folder, disk full, locked file) is reported with the line to add by hand; it never stops or undoes a claim
  const save = (k, line) => { try { fs.appendFileSync(f(k), line + '\n'); } catch (e) { log('fileFail', { file: FILES[k], line, msg: e.message }); } };
  log('huntStart', { t: todo.length, a: accounts.length });

  // One account is always logged in and checked ahead, so a find is claimed at once; the next one is prepared after each claim.
  let limitedUntil = 0;
  const queue = [...accounts], bench = []; // bench: accounts resting after the "setting account details" error
  const prepareNext = async () => {
    for (let i = bench.length - 1; i >= 0; i--) if (bench[i].until <= Date.now()) queue.push(bench.splice(i, 1)[0].acc);
    while (queue.length && Date.now() >= limitedUntil) {
      const acc = queue.shift();
      try {
        const s = await swap.session(acc, acc.login, log, askCode, L);
        await swap.prepare(s, acc.login, log);
        if (!s.edit.current) return { acc, s };
        log('accHasId', { login: acc.login, id: s.edit.current });
      } catch (e) {
        log(e.key === 'loginCancelled' ? 'accCancelled' : 'accFail', { login: acc.login, msg: e.message });
        // Steam limits sign-ins or page requests from this address: more attempts would only fail and use up the accounts; the next find tries again
        if (rateLimited(e) || e.key === 'rateLimit') { swap.drop(acc); queue.unshift(acc); limitedUntil = Date.now() + cur.loginPause; log('huntLoginLimit'); return null; }
      }
      swap.drop(acc);
    }
    return null;
  };
  let ready = prepareNext(); // the account waiting for the next find (a promise)
  const st = { checked: from, total: todo.length, found: 0, claimed: 0 };
  let last = ''; // the ID being checked when Stop came
  try {
    let probeAt = Date.now() + cur.proxyProbe;
    const queue2 = todo.slice(from), again = new Set(); // IDs Steam did not answer clearly get one more try at the end
    for (const id of queue2) {
      last = again.has(id) ? todo[todo.length - 1] : id; // in the second pass the first pass is over: only the end of the list is left
      if (stop) break;
      if (proxy.get() && !proxy.live() && Date.now() >= probeAt) { // the proxy is down: asked again every few minutes
        probeAt = Date.now() + cur.proxyProbe;
        if (await deps.ping()) { proxy.setDown(false); netFails = 0; log('proxyBack'); }
      }
      if (cur.swapAfter && n429 >= cur.swapAfter) { // Steam keeps answering 429: the next account logs in and the checks go on with its session
        n429 = 0;
        const old = await ready;
        if (old) { swap.drop(old.acc); queue.push(old.acc); }
        ready = prepareNext();
        const slot = await ready;
        cookie = slot ? (slot.s.cookies || []).map((c) => c.split(';')[0]).join('; ') : '';
        if (slot) log('huntSwap', { login: slot.acc.login });
      }
      const r = await check(id, deps, log);
      if (r === 'stopped') break;
      if (r === 'unknown' && !again.has(id)) { again.add(id); queue2.push(id); continue; }
      st.checked++;
      if (st.checked % 50 === 0 && !again.has(id)) try { fs.writeFileSync(f('resume'), JSON.stringify({ id })); } catch {} // a crash or a closed window keeps the place too
      if (r === 'unknown') log('huntUnknown', { id });
      if (r === 'available') {
        st.found++;
        if (!availSet.has(id)) { save('available', id); availSet.add(id); }
        log('found', { id });
        for (let tried = 0; tried < cur.perId; tried++) { // the cooldown error moves the same ID to the next account
          let slot = await ready;
          if (!slot) { ready = prepareNext(); slot = await ready; } // an account may have finished resting meanwhile
          if (slot && (slot.s.px !== proxy.live() || Date.now() - slot.s.at > cur.stale)) { // it waited long (its session may be closed) or the proxy went down or came back: it logs in again the other way
            swap.drop(slot.acc); queue.unshift(slot.acc);
            ready = prepareNext(); slot = await ready;
          }
          if (!slot) { log('noSpare', { id }); break; }
          const login = slot.acc.login;
          let next = false;
          let err = null;
          try { await swap.setIdChecked(slot.s, id); } catch (e) { err = e; } // checks the profile page after an error answer
          if (!err) {
            st.claimed++;
            log('claimed', { id, login });
            save('claimed', id + ':' + login);
          } else {
            const e = err;
            log('claimFail', { id, login, msg: e.message + (e.unverified ? ' (could not be checked)' : '') });
            if (!e.unverified && COOLDOWN_RE.test(e.message)) { // nothing was set: the account just rests, the ID goes to another one
              bench.push({ acc: slot.acc, until: Date.now() + cur.cooldown });
              log('accCooldown', { login, m: Math.round(cur.cooldown / 60000) });
              next = true;
            } else queue.unshift(slot.acc); // a lost answer may hide a claim that went through: the account is checked again, never reused as is
          }
          swap.drop(slot.acc);
          ready = prepareNext();
          if (!next) break;
        }
      }
      progress({ ...st });
    }
  } finally {
    ready.then((slot) => slot && swap.drop(slot.acc)); // do not wait: a slow login must not hold Stop
    proxy.setDown(false); // the next operation tries the proxy again
  }
  try { if (stop && last) fs.writeFileSync(f('resume'), JSON.stringify({ id: last })); else fs.rmSync(f('resume'), { force: true }); } catch {} // a finished search starts from the top next time
  log(stop ? 'huntStopped' : 'huntDone', st);
  return st;
}

// Creates the three input/output files next to the program if they are missing.
function initFiles(dir) {
  const created = [];
  for (const k of ['ids', 'available', 'accounts']) {
    const p = path.join(dir, FILES[k]);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, TEMPLATES[k], 'utf8'); created.push(FILES[k]); }
  }
  return created;
}

module.exports = { runHunt, stopHunt: () => { stop = true; }, initFiles, readIds, FILES, timing, tune };
