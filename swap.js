const SteamTotp = require('steam-totp');
const cheerio = require('cheerio');
const proxy = require('./proxy');

// log(key, params) emits message keys; the UI translates them (RU/EN).
const libs = () => ({ SteamUser: require('steam-user'), SteamCommunity: require('steamcommunity'), SteamTotp });
const HOST = 'https://steamcommunity.com';
// Steam answers bursts of web requests with 429, so checks are spaced out and retried.
// The swap's own POSTs are not delayed on purpose: speed matters there.
const timing = { gap: 1500, settle: 2000, wait: 1000, rateWait: 10000, rateTries: 3, loginTimeout: 5 * 60 * 1000, totpStep: 30000, totpPad: 1000, fastOffset: 80, fastTries: 6 };
// Steam answers 429 to requests that have no Accept-Language header (found by testing: curl gets 200 with it, 429 without),
// so every web request carries one. Copied per request because steamcommunity adds headers to the object it gets.
const headers = () => ({ 'Accept-Language': 'en-US,en;q=0.9' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAt = 0;
async function pace() {
  const w = Math.max(0, nextAt - Date.now());
  nextAt = Date.now() + w + timing.gap;
  if (w) await sleep(w);
}

// Logs one account in and resolves once its web session (cookies) is ready.
function login(acc, n, log, askCode, L) {
  return new Promise((resolve, reject) => {
    const px = proxy.live(); // read once: the login is built this way, whatever the proxy does while it runs
    const user = new L.SteamUser(proxy.userOpts());
    const community = proxy.useOn(new L.SteamCommunity());
    // steam-user reconnects forever when Steam is unreachable, so without a limit the UI would hang
    const timer = setTimeout(() => fail(Object.assign(new Error('login timeout'), { key: 'loginTimeout', p: { n } })), timing.loginTimeout);
    let settled = false; // a Steam Guard answer that arrives after the login has ended must not start a new logon
    const fail = (e) => { settled = true; clearTimeout(timer); try { user.logOff(); } catch {} reject(e); };
    user.on('error', (e) => fail(Object.assign(new Error(e.message), { acc: n, eresult: e.eresult })));
    let auto = 0;
    user.on('steamGuard', (domain, cb, wrong) => {
      // Steam refuses an app code it has already seen (an account logging in again within 30 s), so the code is made again in the next window
      if (acc.secret && !domain && auto++ < 2) {
        const step = timing.totpStep;
        return void sleep(step - (Date.now() % step) + timing.totpPad).then(() => { if (!settled) cb(L.SteamTotp.generateAuthCode(acc.secret)); });
      }
      askCode(n, domain, wrong).then((code) => { if (!settled) cb(code); }, fail);
    });
    user.on('loggedOn', () => log('loggedIn', { n }));
    user.on('webSession', (_id, cookies) => {
      settled = true;
      clearTimeout(timer);
      community.setCookies(cookies);
      log('session', { n });
      resolve({ user, community, px }); // px: how it logged in; a session made the other way is not reused
    });
    const opts = { accountName: acc.login, password: acc.password };
    if (acc.secret) opts.twoFactorCode = L.SteamTotp.generateAuthCode(acc.secret);
    user.logOn(opts);
  });
}

// Sessions stay open for a few minutes so "load IDs" and "swap" log in only once.
// shortcut: 10 min TTL, expired sessions are re-created, not refreshed.
const TTL = 10 * 60 * 1000;
const cache = new Map();
const keyOf = (acc) => acc.login + '\0' + acc.password;

function drop(acc) {
  const s = cache.get(keyOf(acc));
  if (s) { try { s.user.logOff(); } catch {} cache.delete(keyOf(acc)); }
}

async function session(acc, n, log, askCode, L) {
  const hit = cache.get(keyOf(acc));
  if (hit && hit.px === proxy.live() && Date.now() - hit.at < TTL) { log('session', { n }); return hit; }
  drop(acc);
  const s = await login(acc, n, log, askCode, L);
  s.at = Date.now();
  s.readyAt = s.at + timing.settle; // Steam throttles web requests fired right after logon
  s.user.on('error', () => cache.delete(keyOf(acc)));
  cache.set(keyOf(acc), s);
  // Close idle sessions, steam-user would otherwise stay connected and reconnect by itself.
  setTimeout(() => { if (cache.get(keyOf(acc)) === s) drop(acc); }, TTL).unref();
  return s;
}

const closeAll = () => { [...cache.values()].forEach((s) => { try { s.user.logOff(); } catch {} }); cache.clear(); };

const cleanId = (v) => String(v || '').replace(/^.*\/id\//, '').replace(/\//g, '');

// GET with spacing. On 429 it waits (Retry-After if Steam sends it) and tries again a few
// times. Nothing has been changed at this point, so waiting is safe.
async function fetchPage(s, n, uri, log) {
  for (let i = 0; ; i++) {
    await pace();
    const r = await new Promise((resolve) =>
      s.community.httpRequest({ uri, headers: headers() }, (err, res, body) => resolve({ err, res, body }), 'steamcommunity')
    );
    const limited = (r.res && r.res.statusCode === 429) || (r.err && /\b429\b/.test(r.err.message));
    if (!limited) return r;
    const after = Number(r.res && r.res.headers && r.res.headers['retry-after']) * 1000;
    // what Steam says about the limit, to help find the cause (shown on every 429, not only the last)
    const h = (r.res && r.res.headers) || {};
    const text = String(r.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const d = [after ? 'Retry-After: ' + after / 1000 : '', h['x-eresult'] ? 'eresult ' + h['x-eresult'] : '',
      h.server ? 'server ' + h.server : '', text].filter(Boolean).join('; ') || '—';
    if (i >= timing.rateTries) throw Object.assign(new Error('HTTP error 429'), { key: 'rateLimit', p: { n, d } });
    const ms = Math.min(after || timing.rateWait, 60000);
    log('waitRate', { n, s: Math.round(ms / 1000), d });
    await sleep(ms);
  }
}

// Loads the profile edit form. Done right before the swap so that a 429 or an unusable
// profile is found while both IDs are still untouched. Afterwards the swap needs only
// one POST per account, with no further lookups.
async function prepare(s, n, log) {
  await sleep(Math.max(0, s.readyAt - Date.now()));
  const id = cleanId(s.user.vanityURL);
  const base = id ? '/id/' + id : '/profiles/' + s.user.steamID.getSteamID64();
  const { err, res, body } = await fetchPage(s, n, HOST + base + '/edit/info', log);
  if (err) throw Object.assign(new Error(err.message || String(err)), { acc: n });
  if (res.statusCode !== 200) throw Object.assign(new Error('HTTP error ' + res.statusCode), { acc: n });
  const $ = cheerio.load(body);
  const el = $('#profile_edit_config');
  const cfg = el.data('profile-edit');
  // An empty profile name is allowed here: only a missing form means the page is unusable.
  if (!cfg || typeof cfg !== 'object') {
    // what the page looked like, to find the cause when it is not the edit form
    const d = [el.length ? 'form found but unreadable' : 'no form', $('title').text().trim(),
      $('body').text().replace(/\s+/g, ' ').trim().slice(0, 100)].filter(Boolean).join('; ');
    throw Object.assign(new Error('profile edit page unavailable'), { key: 'noProfile', p: { n, d } });
  }
  const loc = cfg.LocationData || {};
  // same form the steamcommunity library submits in editProfile()
  s.edit = {
    base,
    current: cleanId(cfg.strCustomURL), // the ID Steam itself says this account has
    values: {
      sessionID: s.community.getSessionID(), type: 'profileSave',
      weblink_1_title: '', weblink_1_url: '', weblink_2_title: '', weblink_2_url: '', weblink_3_title: '', weblink_3_url: '',
      personaName: cfg.strPersonaName, real_name: cfg.strRealName, summary: cfg.strSummary,
      country: loc.locCountryCode, state: loc.locStateCode, city: loc.locCityCode,
      customURL: cfg.strCustomURL, json: 1,
    },
  };
}

// One POST that changes the custom ID; uses the form loaded by prepare().
const setId = (s, customURL) =>
  new Promise((resolve, reject) =>
    s.community.httpRequest(
      { uri: HOST + s.edit.base + '/edit', method: 'POST', headers: headers(), form: { ...s.edit.values, customURL }, followAllRedirects: true },
      (err, res, body) => {
        if (err) return reject(err);
        if (res.statusCode !== 200) { s.lastReply = { http: res.statusCode }; return reject(new Error('HTTP error ' + res.statusCode)); }
        let j;
        try { j = JSON.parse(body); } catch (e) { return reject(e); }
        s.lastReply = j; // kept for the fast swap's log
        if (j.success != 1) return reject(new Error(String(j.errmsg || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || 'Request was not successful')); // Steam's text carries <br />
        s.edit.base = customURL ? '/id/' + customURL : '/profiles/' + s.user.steamID.getSteamID64(); // the profile now lives under the new ID, or only under its number
        resolve();
      },
      'steamcommunity'
    )
  );

// The ID the profile shows right now, read by SteamID64 (the old /id/ may no longer be ours). One plain request: no pause
// and no waiting on 429, because it is used while an ID may be free. null when it could not be read.
async function peek(s, base = '/profiles/' + s.user.steamID.getSteamID64()) {
  const r = await new Promise((resolve) =>
    s.community.httpRequest({ uri: HOST + base + '/edit/info', headers: headers() }, (err, res, body) => resolve({ err, res, body }), 'steamcommunity'));
  if (r.err || !r.res || r.res.statusCode !== 200) return null;
  const cfg = cheerio.load(r.body)('#profile_edit_config').data('profile-edit');
  return cfg && typeof cfg === 'object' ? cleanId(cfg.strCustomURL) : null;
}
// after the move has failed for good there is no hurry any more: a profile that could not be read is tried again
async function peekAgain(s) {
  for (let i = 0, v; i < 3; i++) { if (i) await sleep(timing.wait); if ((v = await peek(s)) !== null) return v; }
  return null;
}
const same = (a, b) => !!a && String(a).toLowerCase() === String(b).toLowerCase();

// setId, trusting the profile page over Steam's answer: Steam sometimes replies with "An error occurred while setting
// account details" although the ID was set. After an error the page is read; the change counts if it shows the new ID.
// An error that could not be checked is marked `unverified`: the ID may have been set anyway.
async function setIdChecked(s, customURL) {
  try { return await setId(s, customURL); } catch (e) {
    const now = await peek(s);
    if (now === null) throw Object.assign(e, { unverified: true });
    if (!same(now, customURL)) throw e;
    s.edit.base = customURL ? '/id/' + customURL : '/profiles/' + s.user.steamID.getSteamID64();
  }
}

// Reads each account's current custom ID. It is known right after logon, so no web requests are needed.
async function loadIds({ a1, a2 }, { log, askCode }, L = libs()) {
  log('start');
  const ss = await Promise.all([session(a1, 1, log, askCode, L), session(a2, 2, log, askCode, L)]);
  const ids = {};
  ss.forEach((s, i) => {
    const id = cleanId(s.user.vanityURL);
    ids[i + 1] = id;
    log(id ? 'loaded' : 'noId', { n: i + 1, id });
  });
  return ids;
}

// Account 1's current ID moves to account 2. Account 1 goes to `temp` meanwhile.
// The ID is read from account 1 itself, so a wrong ID cannot be typed in.
// The very last step, after a successful swap: account 1 takes the ID account 2 just gave up (it replaces the temporary one).
// It never touches the swap itself: a failure is only logged. Both profile addresses are tried and only the profile page is trusted.
async function takeOld(s1, old, log) {
  if (!old) return log('takeNone');
  const bases = [s1.edit.base, '/profiles/' + s1.user.steamID.getSteamID64()];
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(timing.wait);
    s1.edit.base = bases[i % 2];
    try { await setId(s1, old); } catch (e) { last = e; }
    if (same(await peek(s1, '/id/' + old), old) || same(await peek(s1), old)) return log('taken', { id: old });
  }
  log('takeFail', { id: old, msg: last ? last.message : 'the profile does not show the ID' });
}

async function runSwap({ a1, a2, temp, takeOld: take }, { log, askCode }, L = libs()) {
  temp = cleanId(temp) || 'vs' + Math.random().toString(36).slice(2, 10);
  // Steam's own rule for custom IDs; checked first so a bad one fails before anything is changed
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(temp)) throw Object.assign(new Error('bad temporary ID'), { key: 'badTemp' });
  log('start');
  const [s1, s2] = await Promise.all([
    session(a1, 1, log, askCode, L),
    session(a2, 2, log, askCode, L),
  ]);
  // Nothing has changed yet, so a failure here leaves both IDs untouched.
  await prepare(s1, 1, log);
  await prepare(s2, 2, log);
  const target = s1.edit.current, old = s2.edit.current;
  if (!target) throw Object.assign(new Error('account 1 has no custom ID'), { key: 'noId1' });
  log('ready', { target });
  try {
    // The ID moves first, with nothing in between: the target is free only for the moment between the two requests.
    // Nobody looks at the profiles until the move is over or has failed for good.
    let err1 = null;
    try { await setId(s1, temp); log('moved', { temp, target }); }
    catch (e) { err1 = e; } // an error answer may hide a change that went through: the second request shows it
    let err = null;
    for (let i = 1; i <= 3; i++) {
      if (i > 1) await sleep(timing.wait);
      try { await setId(s2, target); err = null; break; }
      catch (e) { err = e; log('retry', { i, msg: e.message }); }
    }
    if (err) await recover(s1, s2, target, err, err1 && (() => err1), log, temp, err1);
    log('done', { target });
    if (take) await takeOld(s1, old, log);
  } finally {
    drop(a1); drop(a2); // IDs changed, so the cached state is stale
  }
}

// The claim on account 2 failed for good. Only now the profiles are read, to learn what really happened (Steam's error answers
// are not reliable): returns when account 2 has the ID after all, otherwise throws `err` (or what onKept gives) after a rollback.
// onKept: when set and account 1 still shows the ID, nothing moved and its error is thrown instead of a rollback.
async function recover(s1, s2, target, err, onKept, log, temp, err1) {
  const [c1, c2] = await Promise.all([peekAgain(s1), peekAgain(s2)]);
  if (same(c2, target)) return; // an error answer, but account 2 has the ID
  if (err1) log('firstFail', { msg: err1.message });
  if (onKept && same(c1, target)) throw onKept(); // nothing moved: account 1 still has its ID (a page that says so after a successful change would be stale)
  // put the ID back, trying both addresses of the profile (the old /id/ page may not be ours now), and trust only the profile page: an answer of Steam is not enough
  const bases = [s1.edit.base, '/profiles/' + s1.user.steamID.getSteamID64()];
  const there = async () => same(await peek(s1, '/id/' + target), target) || same(await peek(s1), target);
  let back = false, last;
  for (let i = 0; i < 3 && !back; i++) {
    if (i) await sleep(timing.wait);
    s1.edit.base = bases[i % 2];
    try { await setId(s1, target); } catch (e) { last = e; }
    if (await there()) back = true;
    else last = last || new Error('Steam accepted it, but the profile does not show the ID: ' + JSON.stringify(s1.lastReply));
  }
  if (back) log('rollback', { target });
  else log('rollbackFail', { msg: last.message, target, temp });
  throw err;
}

// Fast swap (test build): the ID is removed from account 1 and POST 2 follows after a few ms without waiting for Steam's answer to
// POST 1, so the ID is free only for the time Steam needs between the two requests. A refusal of POST 2 (the clear had not landed
// yet) is retried at once. Every request and answer is logged with its time in ms from the moment POST 1 was sent.
async function runFastSwap({ a1, a2, offset, temp, takeOld: take }, { log, askCode }, L = libs()) {
  const off = Number.isFinite(+offset) ? Math.max(+offset, timing.fastOffset) : timing.fastOffset; // below the minimum Steam refuses POST 1 (seen on the real service)
  const first = cleanId(temp) || 'vs' + Math.random().toString(36).slice(2, 10); // account 1 is set to a temporary ID: clearing it does not release the ID at once
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(first)) throw Object.assign(new Error('bad temporary ID'), { key: 'badTemp' });
  log('start');
  const [s1, s2] = await Promise.all([session(a1, 1, log, askCode, L), session(a2, 2, log, askCode, L)]);
  await prepare(s1, 1, log); // the checks run as usual, before anything changes
  await prepare(s2, 2, log);
  const target = s1.edit.current, old = s2.edit.current;
  if (!target) throw Object.assign(new Error('account 1 has no custom ID'), { key: 'noId1' });
  log('ready', { target });
  try {
    const t0 = performance.now(), at = () => Math.round(performance.now() - t0);
    const note = (m) => log('fastLog', { m });
    note(`target “${target}”, offset ${off} ms, account 1 is set to “${first}”`);
    let p1done = false, err1 = null;
    note(`POST 1 (temporary ID of account 1) sent at 0 ms`);
    const p1 = setId(s1, first).then(() => { p1done = true; note(`POST 1 answered at ${at()} ms: ok, reply ${JSON.stringify(s1.lastReply)}`); },
      (e) => { err1 = e; p1done = true; note(`POST 1 answered at ${at()} ms: ${e.message}, reply ${JSON.stringify(s1.lastReply)}`); }); // never rejects: an error answer is normal
    await sleep(off);
    let err = null, after = 0;
    for (let i = 1; i <= timing.fastTries; i++) {
      if (p1done && ++after > 3) break; // POST 1 has answered: a few more tries, then the profiles decide
      note(`POST 2 #${i} (claim on account 2) sent at ${at()} ms${p1done ? ', POST 1 had answered' : ', POST 1 not answered yet'}`);
      try { await setId(s2, target); err = null; note(`POST 2 #${i} answered at ${at()} ms: ok, reply ${JSON.stringify(s2.lastReply)}`); break; }
      catch (e) {
        err = e; note(`POST 2 #${i} answered at ${at()} ms: ${e.message}, reply ${JSON.stringify(s2.lastReply)}`);
        if (/\b429\b/.test(e.message)) await sleep(timing.wait); // rate limit: hurrying makes it worse
      }
    }
    await p1;
    if (err) await recover(s1, s2, target, err, () => Object.assign(new Error('ID kept'), { key: 'fastKept', p: { target, msg: (err1 || err).message } }), log, first, err1);
    note(`finished at ${at()} ms`);
    log('done', { target });
    if (take) await takeOld(s1, old, log);
  } finally {
    drop(a1); drop(a2);
  }
}

module.exports = { runSwap, runFastSwap, loadIds, closeAll, timing, libs, session, prepare, setId, setIdChecked, drop, cleanId };
