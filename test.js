const assert = require('assert');
const { EventEmitter } = require('events');
const { runSwap, loadIds, timing } = require('./swap');
const swapTiming = timing;
const { makeAsker } = require('./prompt');
const hunt = require('./hunt');
const fs = require('fs');
const os = require('os');
const path = require('path');

Object.assign(timing, { gap: 1, settle: 1, wait: 1, rateWait: 1 }); // no real waiting in tests

const posts = [];
let failTarget = 0, logins = 0, gets = 0, noProfile = false, rate = 0, noLang = 0, emptyName = false;
const pws = {}, owned = {}, postBy = []; // owned: IDs an account got on the fake Steam
let quirk = false, track = false; // track: a successful change really moves the ID on the fake Steam (only the tests that read the page afterwards need it)
let lost = ''; // an ID whose claim goes through on the fake Steam but the answer is lost
const uris = [];
const limited = new Set(), guardFirst = new Set(), keep = new Set(), codes = []; // logins Steam rate-limits / asks a code from / ignores an ID clear for
let dark = false, blind = false; // the profile page cannot be read (after a change that Steam answered with an error)
const half = new Set(); // accounts whose ID change goes through although Steam answers with the "setting account details" error
const deaf = new Set(); // accounts Steam refuses to change an ID on ("An error occurred while setting account details")
const page = (id) => `<div id="profile_edit_config" data-profile-edit='{"strPersonaName":"${emptyName ? '' : 'x'}","strCustomURL":"${id}","LocationData":{}}'></div>`;

class U extends EventEmitter {
  logOn(o) {
    logins++;
    pws[o.accountName] = o.password;
    this.vanityURL = o.accountName === 'a' ? 'cool' : owned[o.accountName] || '';
    this.steamID = { getSteamID64: () => '7656119' };
    const ready = () => { this.emit('loggedOn'); this.emit('webSession', 'x', [this.vanityURL, o.accountName]); };
    if (limited.has(o.accountName)) return setImmediate(() => this.emit('error', U.throttle ? Object.assign(new Error('AccountLoginDeniedThrottle'), { eresult: 87 }) : Object.assign(new Error('RateLimitExceeded'), { eresult: 84 })));
    if (guardFirst.has(o.accountName)) return setImmediate(() => this.emit('steamGuard', null, (code) => { codes.push(code); setImmediate(ready); }, true));
    setImmediate(ready);
  }
  logOff() {}
}
class C {
  setCookies(c) { this.id = c[0]; this.acct = c[1]; } // the fake "cookie" is the account's own ID and login
  getSessionID() { return 'sid'; }
  httpRequest(o, cb) {
    if (!(o.headers && o.headers['Accept-Language'])) noLang++; // Steam answers 429 without it
    if (o.method !== 'POST') { // profile edit page
      gets++; uris.push(o.uri);
      if (dark) return cb(null, { statusCode: 500 }, '');
      if (rate-- > 0) return cb(new Error('HTTP error 429'), { statusCode: 429, headers: {} }, '');
      return cb(null, { statusCode: 200 }, noProfile ? '<html></html>' : page(this.acct in owned ? owned[this.acct] : this.id));
    }
    const url = o.form.customURL;
    posts.push(url);
    postBy.push(this.acct);
    if (half.has(this.acct)) { if (blind) dark = true; owned[this.acct] = url; return cb(null, { statusCode: 200 }, JSON.stringify({ success: 2, errmsg: 'An error occurred while setting account details<br />' })); }
    if (deaf.has(this.acct)) return cb(null, { statusCode: 200 }, JSON.stringify({ success: 2, errmsg: 'The profile URL specified is already in use<br />An error occurred while setting account details<br />' }));
    if (url === '' && !keep.has(this.acct)) { // an empty ID removes the custom ID
      owned[this.acct] = '';
      if (quirk) return cb(null, { statusCode: 200 }, JSON.stringify({ success: 2, errmsg: 'An error occurred while setting account details<br />' })); // seen on the real Steam: an error although the ID is gone
    }
    if (lost && url === lost) { owned[this.acct] = url; return cb(null, { statusCode: 500 }, ''); }
    const bad = url === 'cool' && failTarget-- > 0;
    if (track && !bad) owned[this.acct] = url;
    cb(null, { statusCode: 200 }, JSON.stringify(bad ? { success: 2, errmsg: 'taken' } : { success: 1 }));
  }
}
const L = { SteamUser: U, SteamCommunity: C, SteamTotp: { generateAuthCode: () => '12345' } };
const logs = [];
const io = { log: (k, p) => logs.push([k, p]), askCode: async () => '000' };
const cfg = { a1: { login: 'a', password: 'b' }, a2: { login: 'c', password: 'd', secret: 'zz' }, temp: 'tmp1' };

(async () => {
  await runSwap(cfg, io, L);
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool']); // happy path order; the ID comes from account 1, not from the caller
  assert.strictEqual(logins, 2);
  assert.strictEqual(gets, 2); // one fresh check per account, right before the swap
  assert.deepStrictEqual(logs.find(([k]) => k === 'ready')[1], { target: 'cool' });

  failTarget = 3; track = true; // acc2 fails 3 times -> the profiles are read -> rollback (acc1 POST succeeds as failTarget is spent)
  await assert.rejects(runSwap(cfg, io, L), /taken/);
  track = false; delete owned.a; delete owned.c;
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool', 'cool', 'cool', 'cool']); // temp, 3 tries, rollback
  assert.strictEqual(logins, 4); // swaps drop their sessions, so each swap logs in again

  const ids = await loadIds(cfg, io, L); // reads current IDs, keeps sessions open
  assert.deepStrictEqual(ids, { 1: 'cool', 2: '' });
  assert.strictEqual(logins, 6);
  const g = gets;
  assert.strictEqual(g, 6); // loading IDs makes no web requests (4 checks of two swaps + the 2 profile reads after the failed change)
  await runSwap(cfg, io, L); // reuses the sessions from loadIds but still checks fresh
  assert.strictEqual(logins, 6);
  assert.strictEqual(gets, g + 2);
  posts.length = 0;

  // account 1 without an ID: nothing to move, nothing may change
  const swapped = { ...cfg, a1: cfg.a2, a2: cfg.a1 };
  await assert.rejects(runSwap(swapped, io, L), (e) => e.key === 'noId1');
  assert.deepStrictEqual(posts, []);

  noProfile = true; // accounts without a profile -> nothing may change
  await assert.rejects(runSwap(cfg, io, L), (e) => e.key === 'noProfile');
  assert.deepStrictEqual(posts, []);
  noProfile = false;

  rate = 2; // two 429 answers, then fine -> waits and goes on
  await runSwap(cfg, io, L);
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool']);
  assert.strictEqual(logs.filter(([k]) => k === 'waitRate').length, 2);

  rate = Infinity; // Steam keeps answering 429 -> clear error, nothing may change
  await assert.rejects(runSwap(cfg, io, L), (e) => e.key === 'rateLimit' && e.p.d === '—');
  assert.deepStrictEqual(posts, []);
  rate = 0;
  emptyName = true; // a profile with an empty name is still editable
  await runSwap(cfg, io, L);
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool']);
  emptyName = false;
  assert.strictEqual(noLang, 0); // every GET and POST carried Accept-Language

  // Steam Guard prompts: one at a time, and a timeout does not block the next one
  const bus = new EventEmitter(), asked = [];
  const ask = makeAsker({ ask: (n) => asked.push(n), onCode: (h) => { bus.on('code', h); return () => bus.off('code', h); }, timeout: 30 });
  const c1 = ask(1, null), c2 = ask(2, null);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(asked, [1]); // second prompt waits for the first
  bus.emit('code', 'AAA');
  assert.strictEqual(await c1, 'AAA');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(asked, [1, 2]);
  await assert.rejects(c2, (e) => e.key === 'codeTimeout' && e.p.n === 2); // nobody answered
  assert.strictEqual(bus.listenerCount('code'), 0);
  const c3 = ask(1, null);
  await new Promise((r) => setTimeout(r, 5));
  bus.emit('code', 'BBB');
  assert.strictEqual(await c3, 'BBB'); // queue still works after a timeout

  // cancel() drops the open prompt and the queued ones (the operation already ended)
  const seen = [];
  const ask2 = makeAsker({ ask: (n, d, w) => seen.push([n, w]), onCode: (h) => { bus.on('code', h); return () => bus.off('code', h); }, timeout: 1000 });
  const q1 = ask2(1, null, true), q2 = ask2(2, null);
  await new Promise((r) => setTimeout(r, 5));
  ask2.cancel();
  await assert.rejects(q1, /cancelled/);
  await assert.rejects(q2, /cancelled/);
  assert.deepStrictEqual(seen, [[1, true]]); // "wrong code" flag passed on; the queued prompt never opened
  assert.strictEqual(bus.listenerCount('code'), 0);
  const q3 = ask2(1, null);
  await new Promise((r) => setTimeout(r, 5));
  bus.emit('code', 'CCC');
  assert.strictEqual(await q3, 'CCC'); // works again after a cancel

  // skip() gives up only the open prompt; the next queued one opens
  const seen3 = [];
  const ask3 = makeAsker({ ask: (n) => seen3.push(n), onCode: (h) => { bus.on('code', h); return () => bus.off('code', h); }, timeout: 1000 });
  const s1 = ask3(1, null), s2 = ask3(2, null);
  await new Promise((r) => setTimeout(r, 5));
  ask3.skip();
  await assert.rejects(s1, (e) => e.key === 'loginCancelled');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(seen3, [1, 2]);
  bus.emit('code', 'DDD');
  assert.strictEqual(await s2, 'DDD');

  // both the second change and the rollback fail: error is raised and rollbackFail is logged (the data-loss path)
  failTarget = Infinity; track = true;
  logs.length = 0;
  await assert.rejects(runSwap(cfg, io, L), /taken/);
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool', 'cool', 'cool', 'cool', 'cool', 'cool']);
  assert.deepStrictEqual(logs.find(([k]) => k === 'rollbackFail')[1], { msg: 'taken', target: 'cool', temp: 'tmp1' });
  failTarget = 0; delete owned.a; delete owned.c;

  // Steam answers with an error although the change went through (seen on the real one). The move goes first and is not
  // checked in between: account 1's error answer does not stop the second request, and no profile is read when it works
  half.add('a');
  logs.length = 0; const getsBefore = gets;
  await runSwap(cfg, io, L);
  half.clear();
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool']);
  assert.strictEqual(gets, getsBefore + 2); // only the two checks before the swap
  assert.ok(logs.some(([k]) => k === 'done') && !logs.some(([k]) => k === 'firstFail'));
  assert.deepStrictEqual([owned.a, owned.c], ['tmp1', 'cool']);
  delete owned.a; delete owned.c;
  half.add('c'); // the same for the second account: its retries fail, then the page shows it has the ID: no rollback, no false failure
  logs.length = 0;
  await runSwap(cfg, io, L);
  half.clear();
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool', 'cool', 'cool']);
  assert.ok(logs.some(([k]) => k === 'done') && !logs.some(([k]) => k === 'rollback'));
  assert.strictEqual(owned.c, 'cool');
  delete owned.a; delete owned.c; track = false;

  // account 1's change really fails and so does the second one: the profiles show account 1 still has its ID, no rollback
  deaf.add('a'); failTarget = Infinity; track = true; logs.length = 0;
  await assert.rejects(runSwap(cfg, io, L), /setting account details/);
  deaf.clear(); failTarget = 0; track = false; delete owned.a; delete owned.c;
  assert.deepStrictEqual(posts.splice(0), ['tmp1', 'cool', 'cool', 'cool']);
  assert.ok(logs.some(([k]) => k === 'firstFail') && !logs.some(([k]) => k === 'rollback' || k === 'rollbackFail'));

  // a bad temporary ID fails before anything changes; a pasted /id/ path is cleaned
  const loginsBefore = logins;
  await assert.rejects(runSwap({ ...cfg, temp: 'a b' }, io, L), (e) => e.key === 'badTemp');
  assert.strictEqual(logins, loginsBefore);
  await runSwap({ ...cfg, temp: 'steamcommunity.com/id/abc_def/' }, io, L);
  assert.deepStrictEqual(posts.splice(0), ['abc_def', 'cool']);

  // sign-in that never finishes ends with an error instead of hanging
  class Stuck extends U { logOn() { logins++; } }
  const saved = timing.loginTimeout;
  timing.loginTimeout = 20;
  await assert.rejects(runSwap(cfg, io, { ...L, SteamUser: Stuck }), (e) => e.key === 'loginTimeout');
  timing.loginTimeout = saved;

  // hunt: free IDs found in ids.txt are saved to available.txt and taken by unused accounts, with the exact case
  Object.assign(hunt.timing, { gap: 1, rateWait: 1, retryWait: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  assert.deepStrictEqual(hunt.initFiles(dir), ['ids.txt', 'available.txt', 'accounts.txt']);
  assert.deepStrictEqual(hunt.initFiles(dir), []); // existing files are left alone
  fs.writeFileSync(path.join(dir, 'ids.txt'), '# comment\nAAA, FreeOne,Free_Two\n-Dash7 bad!id RATE\nFreeOne\n');
  fs.writeFileSync(path.join(dir, 'accounts.txt'), '# accounts\na:pw\nh1:p:w:x\nh2:pw2\nbroken-line\nh3:pw3\n');
  const takenIds = new Set(['AAA']);
  const probed = [];
  let rl = 1;
  const fakeFetch = async (url) => {
    const id = url.split('/id/')[1].replace('/', '');
    probed.push(id);
    const res = (status, text = '') => ({ status, headers: { get: () => null }, text: async () => text });
    if (id === 'RATE' && rl-- > 0) return res(429);
    return res(200, takenIds.has(id) ? '<html><div class="profile_header"></div></html>' : '<html>The specified profile could not be found.</html>');
  };
  const hlogs = [];
  const hio = { log: (k, p) => hlogs.push([k, p]), dir };
  const st = await hunt.runHunt({}, hio, L, { fetch: fakeFetch });
  assert.deepStrictEqual(probed, ['AAA', 'FreeOne', 'Free_Two', '-Dash7', 'RATE', 'RATE']); // duplicates and bad IDs are not probed; 429 is retried
  assert.deepStrictEqual(st, { checked: 5, total: 5, found: 4, claimed: 3 });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'available.txt'), 'utf8'), 'FreeOne\nFree_Two\n-Dash7\nRATE\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'claimed.txt'), 'utf8'), 'FreeOne:h1\nFree_Two:h2\n-Dash7:h3\n');
  assert.deepStrictEqual(posts.splice(0), ['FreeOne', 'Free_Two', '-Dash7']); // claimed with the typed case
  assert.strictEqual(pws.h1, 'p:w:x'); // the password may contain ":"
  const keys = hlogs.map(([k]) => k);
  assert.ok(keys.includes('accHasId') && keys.includes('badIds') && keys.includes('badAccounts') && keys.includes('huntWait'));
  assert.deepStrictEqual(hlogs.find(([k]) => k === 'noSpare')[1], { id: 'RATE' }); // found, saved, but no account left

  // second run: claimed IDs are not probed again and available.txt gets no duplicates
  fs.writeFileSync(path.join(dir, 'accounts.txt'), '# none\n');
  probed.length = 0;
  await hunt.runHunt({}, hio, L, { fetch: fakeFetch });
  assert.deepStrictEqual(probed, ['AAA', 'RATE']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'available.txt'), 'utf8'), 'FreeOne\nFree_Two\n-Dash7\nRATE\n');

  // no free ID found -> only one account is logged in ahead, the rest stay untouched
  fs.writeFileSync(path.join(dir, 'accounts.txt'), 'x1:pw\nx2:pw\n');
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'AAA');
  const before = logins;
  await hunt.runHunt({}, hio, L, { fetch: fakeFetch });
  assert.strictEqual(logins, before + 1);

  // an ID Steam never answers clearly is tried again at the end, then reported once
  fs.writeFileSync(path.join(dir, 'accounts.txt'), '# none\n');
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'Zzz1');
  probed.length = 0; hlogs.length = 0;
  const bad500 = await hunt.runHunt({}, hio, L, { fetch: async (u) => { probed.push(u); return { status: 500, headers: { get: () => null }, text: async () => '' }; } });
  assert.strictEqual(probed.length, 6); // 3 attempts, then 3 more in the second pass
  assert.deepStrictEqual(bad500, { checked: 1, total: 1, found: 0, claimed: 0 });
  assert.strictEqual(hlogs.filter(([k]) => k === 'huntUnknown').length, 1);

  // 429 in a row doubles the pause only once; a new 429 after a good answer doubles it again
  hunt.timing.gap = 100;
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'Qqq1, Qqq2');
  const seq = [429, 429, 200, 429, 200, 200]; // Qqq1: two 429 in a row, then ok; Qqq2: a new 429 after ok, then ok
  hlogs.length = 0;
  await hunt.runHunt({}, hio, L, { fetch: async () => ({ status: seq.shift(), headers: { get: () => null }, text: async () => 'profile_header' }) });
  assert.deepStrictEqual(hlogs.filter(([k]) => k === 'huntWait').map(([, p]) => p.g), ['0.2', '0.2', '0.4']);
  hunt.timing.gap = 1;
  // sliders: values are clamped; the run starts from the chosen base and the 429 rule still doubles it (once per streak)
  assert.deepStrictEqual(hunt.tune({ gap: 1, timeout: 1e9, rateWait: 'x' }), { ...hunt.tune({}), gap: 200, timeout: 60000 });
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'Slid1, Slid2');
  const sq = [429, 200, 429, 429, 200], took = [];
  hlogs.length = 0;
  await hunt.runHunt({ gap: 200, timeout: 5000, rateWait: 3000 }, hio, L, { fetch: async (u, o) => { took.push(o.signal.aborted); return { status: sq.shift(), headers: { get: () => null }, text: async () => 'profile_header' }; } });
  const waits = hlogs.filter(([k]) => k === 'huntWait').map(([, p]) => p);
  assert.deepStrictEqual(waits.map((p) => p.g), ['0.4', '0.8', '0.8']); // base 0.2 s: doubles on a 429 after a good answer, not on the repeated one
  assert.deepStrictEqual(waits.map((p) => p.s), [3, 3, 6]); // the 429 pause starts from the slider and grows with the attempt
  hunt.timing.gap = 1;

  // a 200 page that is neither "not found" nor a profile is unclear, never "taken" or "free"
  hlogs.length = 0;
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'Soft1');
  const soft = await hunt.runHunt({}, hio, L, { fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html>maintenance</html>' }) });
  assert.strictEqual(soft.found, 0);
  assert.strictEqual(hlogs.filter(([k]) => k === 'huntUnknown').length, 1);

  // files saved by editors with a BOM still work: first ID and first account are read correctly
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  fs.writeFileSync(path.join(dirB, 'ids.txt'), '﻿BomOne');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), '﻿b1:pw');
  posts.length = 0; postBy.length = 0; hlogs.length = 0;
  const bom = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  assert.strictEqual(bom.claimed, 1);
  assert.deepStrictEqual(postBy.splice(0), ['b1']);
  assert.ok(!hlogs.some(([k]) => k === 'badIds'));

  // a claim whose answer was lost but went through: the account is checked again, found to own an ID, and not reused
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'LostA, LostB');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'l1:pw\nl2:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; lost = 'LostA';
  const lostRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  lost = '';
  assert.deepStrictEqual(posts.splice(0), ['LostA', 'LostB']);
  assert.deepStrictEqual(postBy.splice(0), ['l1', 'l2']); // LostB went to another account; l1 was not asked to replace LostA
  assert.strictEqual(owned.l1, 'LostA');
  assert.ok(!hlogs.some(([k]) => k === 'claimFail')); // the page shows LostA is set, so it counts as claimed
  assert.strictEqual(lostRun.claimed, 2);
  assert.ok(fs.readFileSync(path.join(dirB, 'claimed.txt'), 'utf8').includes('LostA:l1'));

  // the error text of a cooldown, but the ID was set: claimed, no rest, no second account
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'HalfA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'h1:pw\nh2:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; half.add('h1');
  const halfRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  half.clear();
  assert.deepStrictEqual(postBy.splice(0), ['h1']); posts.length = 0;
  assert.strictEqual(halfRun.claimed, 1);
  assert.ok(!hlogs.some(([k]) => k === 'accCooldown' || k === 'claimFail'));
  assert.ok(fs.readFileSync(path.join(dirB, 'claimed.txt'), 'utf8').includes('HalfA:h1'));

  // the cooldown error: the same ID goes to the next account, the resting account is not used again for the next ID
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'CoolA, CoolB');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'c1:pw\nc2:pw\nc3:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; deaf.add('c1');
  const coolRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  deaf.clear();
  assert.deepStrictEqual(posts.splice(0), ['CoolA', 'CoolA', 'CoolB']);
  assert.deepStrictEqual(postBy.splice(0), ['c1', 'c2', 'c3']);
  assert.strictEqual(coolRun.claimed, 2);
  assert.ok(hlogs.some(([k, p]) => k === 'accCooldown' && p.login === 'c1'));

  // Steam limits sign-ins from this address: no more logins in this run, the account stays for the next find
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'ThrA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 't1:pw\nt2:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; limited.add('t1'); logins = 0;
  const thrRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  limited.delete('t1');
  assert.strictEqual(logins, 1); // t1 tried once; during the pause nothing is tried again, t2 never
  assert.strictEqual(thrRun.claimed, 0);
  assert.ok(hlogs.some(([k]) => k === 'huntLoginLimit') && hlogs.some(([k, p]) => k === 'noSpare' && p.id === 'ThrA'));

  // a web 429 while an account is prepared is the same limit: the account is not lost for the run
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'WebA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'w1:pw' + String.fromCharCode(10) + 'w2:pw' + String.fromCharCode(10));
  posts.length = 0; postBy.length = 0; hlogs.length = 0; logins = 0; rate = Infinity;
  const webRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  rate = 0;
  assert.strictEqual(logins, 1);
  assert.strictEqual(webRun.claimed, 0);
  assert.ok(hlogs.some(([k]) => k === 'huntLoginLimit') && !hlogs.some(([k, p]) => k === 'accFail' && p.login === 'w2'));

  // accounts known to own an ID are not logged in
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'KnownA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'k1:pw\nk2:pw\n');
  require('./accounts').patch(dirB, 'k1', { id: 'Mine' });
  posts.length = 0; postBy.length = 0; hlogs.length = 0; logins = 0;
  const knownRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  assert.strictEqual(logins, 1);
  assert.deepStrictEqual(postBy.splice(0), ['k2']); posts.length = 0;
  assert.strictEqual(knownRun.claimed, 1);
  assert.deepStrictEqual(hlogs.find(([k]) => k === 'huntSkipId')[1], { n: 1 });

  // a claim that cannot be checked afterwards: the account does not rest, nothing is passed on as if it had failed for good
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'UnvA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'u1:pw\nu2:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; half.add('u1'); blind = true;
  const unvRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  half.clear(); blind = dark = false;
  assert.strictEqual(unvRun.claimed, 0);
  assert.ok(hlogs.some(([k, p]) => k === 'claimFail' && /could not be checked/.test(p.msg)) && !hlogs.some(([k]) => k === 'accCooldown'));
  delete owned.u1;

  // one ID tries at most `perId` accounts, the rest are kept
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'CapA');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'd1:pw\nd2:pw\nd3:pw\n');
  posts.length = 0; postBy.length = 0; hlogs.length = 0; ['d1', 'd2', 'd3'].forEach((a) => deaf.add(a));
  hunt.timing.perId = 2;
  const capRun = await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  hunt.timing.perId = 3; deaf.clear();
  assert.deepStrictEqual(postBy.splice(0), ['d1', 'd2']);
  assert.strictEqual(capRun.claimed, 0);
  posts.length = 0;

  // a ready account that waited too long is logged in again before it claims
  fs.writeFileSync(path.join(dirB, 'ids.txt'), 'Aged1');
  fs.writeFileSync(path.join(dirB, 'accounts.txt'), 'g1:pw\n');
  posts.length = 0; postBy.length = 0;
  const l0 = logins; hunt.timing.stale = -1;
  await hunt.runHunt({}, { log: hio.log, dir: dirB }, L, { fetch: fakeFetch });
  hunt.timing.stale = 8 * 60 * 1000;
  assert.strictEqual(logins - l0, 2); // the first login, then a fresh one right before the claim
  assert.deepStrictEqual(posts.splice(0), ['Aged1']);

  // a file error (here: the output files are folders) is reported with the line to add by hand, and the claim stands
  const dirF = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  fs.writeFileSync(path.join(dirF, 'ids.txt'), 'FileOne');
  fs.writeFileSync(path.join(dirF, 'accounts.txt'), 'f1:pw');
  fs.mkdirSync(path.join(dirF, 'available.txt'));
  fs.mkdirSync(path.join(dirF, 'claimed.txt'));
  hlogs.length = 0; posts.length = 0;
  const ff = await hunt.runHunt({}, { log: hio.log, dir: dirF }, L, { fetch: fakeFetch });
  assert.strictEqual(ff.claimed, 1);
  assert.deepStrictEqual(posts.splice(0), ['FileOne']);
  assert.deepStrictEqual(hlogs.filter(([k]) => k === 'fileFail').map(([, p]) => p.line), ['FileOne', 'FileOne:f1']);
  assert.ok(!hlogs.some(([k]) => k === 'claimFail'));
  [dirB, dirF].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

  // account manager: parsing, storage, no passwords in the list
  const acc = require('./accounts');
  Object.assign(acc.timing, { gap: 1 });
  const SEC = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 27 + "=": looks like a shared_secret
  assert.deepStrictEqual(acc.parseLine('u1:pa:ss'), { login: 'u1', password: 'pa:ss', secret: '' });
  assert.deepStrictEqual(acc.parseLine('u2:pw:' + SEC), { login: 'u2', password: 'pw', secret: SEC });
  assert.strictEqual(acc.parseLine('nocolon'), null);
  assert.deepStrictEqual(acc.parseLine('u3:pw:' + SEC + ' \t'), { login: 'u3', password: 'pw', secret: SEC }); // a space after a pasted secret
  const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-')); // an unreadable accounts.txt (here: a folder) must never be rewritten as empty
  fs.mkdirSync(path.join(dirX, 'accounts.txt'));
  assert.throws(() => acc.add(dirX, 'a:b'));
  assert.throws(() => acc.remove(dirX, ['a']));
  assert.ok(fs.statSync(path.join(dirX, 'accounts.txt')).isDirectory());
  fs.rmSync(dirX, { recursive: true, force: true });
  const dirM = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  fs.writeFileSync(path.join(dirM, 'accounts.txt'), '# note\n﻿m1:pw1\nm2:pw2\nm1:dup\nbroken\n');
  assert.deepStrictEqual(acc.loadAccounts(dirM).accounts.map((a) => a.login), ['m1', 'm2']);
  assert.strictEqual(acc.loadAccounts(dirM).bad, 1); // a repeated login is ignored silently, a broken line is counted
  const addRes = acc.add(dirM, 'm3:pw3:' + SEC + '\nm2:newpw\nbad line');
  assert.deepStrictEqual(addRes, { added: 1, updated: 1, bad: 1 });
  const txt = fs.readFileSync(path.join(dirM, 'accounts.txt'), 'utf8');
  assert.ok(txt.includes('# note') && txt.includes('m2:newpw') && txt.includes('m3:pw3:' + SEC) && !txt.includes('m2:pw2'));
  assert.ok(!JSON.stringify(acc.list(dirM)).match(/pw1|newpw|pw3|AAAAAAAA/)); // the window never gets passwords or secrets
  assert.deepStrictEqual(acc.list(dirM).map((a) => [a.login, a.secret, a.use]), [['m1', false, true], ['m2', false, true], ['m3', true, true]]);
  acc.setUse(dirM, ['m2'], false);
  assert.deepStrictEqual(acc.selected(dirM), ['m1', 'm3']);
  acc.setUse(dirM, null, true);
  assert.strictEqual(acc.selected(dirM).length, 3);

  // check: SteamID64 and custom ID are stored; a login rate limit stops the whole batch
  hlogs.length = 0; owned.m1 = 'OwnedOne';
  const ch = await acc.refresh(dirM, null, { log: hio.log, askCode: async () => '0' }, L);
  assert.deepStrictEqual(ch, { ok: 3, fail: 0 });
  assert.deepStrictEqual(acc.list(dirM).map((a) => [a.steamId, a.id]), [['7656119', 'OwnedOne'], ['7656119', ''], ['7656119', '']]);
  limited.add('m2'); hlogs.length = 0; U.throttle = true; // Steam's other login limit, EResult 87, stops the batch too
  const lim = await acc.refresh(dirM, null, { log: hio.log, askCode: async () => '0' }, L);
  limited.clear(); U.throttle = false;
  assert.deepStrictEqual(lim, { ok: 1, fail: 1 }); // m3 was not tried after the limit
  assert.ok(hlogs.some(([k]) => k === 'accRateLimit') && /Throttle/.test(acc.list(dirM)[1].err));

  // clearing an ID: needs the ID the user confirmed, and is successful only when Steam shows none afterwards
  hlogs.length = 0; posts.length = 0;
  await assert.rejects(acc.clearId(dirM, { login: 'm1', id: 'SomethingElse' }, { log: hio.log, askCode: async () => '0' }, L), (e) => e.key === 'clearChanged');
  assert.deepStrictEqual(posts, []); // nothing was changed
  assert.strictEqual(await acc.clearId(dirM, { login: 'm1', id: 'OwnedOne' }, { log: hio.log, askCode: async () => '0' }, L), 'OwnedOne');
  assert.deepStrictEqual(posts.splice(0), ['']);
  assert.ok(uris.pop().endsWith('/profiles/7656119/edit/info')); // the check afterwards opens the profile by its number
  assert.strictEqual(owned.m1, '');
  assert.strictEqual(acc.list(dirM)[0].id, '');
  assert.ok(hlogs.some(([k, p]) => k === 'idCleared' && p.id === 'OwnedOne'));
  assert.strictEqual(await acc.clearId(dirM, { login: 'm1', id: '' }, { log: hio.log, askCode: async () => '0' }, L), ''); // nothing to clear
  assert.deepStrictEqual(posts, []);
  owned.m2 = 'Stubborn'; keep.add('m2');
  await assert.rejects(acc.clearId(dirM, { login: 'm2', id: 'Stubborn' }, { log: hio.log, askCode: async () => '0' }, L), (e) => e.key === 'clearKept');
  keep.clear(); posts.length = 0;
  // Steam says "error" but the ID is gone: that is a success, because the page afterwards is what counts
  owned.m1 = 'Again'; quirk = true;
  assert.strictEqual(await acc.clearId(dirM, { login: 'm1', id: 'Again' }, { log: hio.log, askCode: async () => '0' }, L), 'Again');
  quirk = false; assert.strictEqual(owned.m1, '');
  // and when the ID really stays, the error is shown without HTML
  owned.m2 = 'Stubborn'; deaf.add('m2');
  await assert.rejects(acc.clearId(dirM, { login: 'm2', id: 'Stubborn' }, { log: hio.log, askCode: async () => '0' }, L), (e) => /setting account details/.test(e.message) && !/</.test(e.message));
  deaf.clear(); owned.m2 = ''; posts.length = 0;

  // only the ticked accounts are checked
  logins = 0;
  assert.deepStrictEqual(await acc.refresh(dirM, ['m2'], { log: hio.log, askCode: async () => '0' }, L), { ok: 1, fail: 0 });
  assert.strictEqual(logins, 1);
  // "cancel login" at a Guard prompt: that account is skipped and marked, the next one is still checked
  guardFirst.add('m1'); hlogs.length = 0;
  const cancelled = await acc.refresh(dirM, ['m1', 'm2'], { log: hio.log, askCode: async () => { throw Object.assign(new Error('Steam Guard login cancelled'), { key: 'loginCancelled' }); } }, L);
  guardFirst.clear();
  assert.deepStrictEqual(cancelled, { ok: 1, fail: 1 });
  assert.ok(hlogs.some(([k, p]) => k === 'accCancelled' && p.login === 'm1') && !hlogs.some(([k]) => k === 'accRateLimit'));
  assert.strictEqual(acc.list(dirM)[0].guard, true);

  // encrypted config: a click on an account shows its password; export/import round trip needs the right password
  assert.deepStrictEqual(acc.reveal(dirM, 'm3'), { password: 'pw3', secret: SEC });
  assert.throws(() => acc.exportText(dirM, 'abc'), (e) => e.key === 'passWeak');
  for (const weak of ['abcde', 'abcd1', 'Ab1x', '12345', 'abcdE']) assert.throws(() => acc.exportText(dirM, weak), (e) => e.key === 'passWeak', weak); // needs 5+ characters, a digit and a capital letter
  assert.ok(acc.exportText(dirM, 'Abcd1').startsWith('VSA1.'));
  const cfgText = acc.exportText(dirM, 'Open sesame1');
  assert.ok(cfgText.startsWith('VSA1.') && !cfgText.includes('m3:pw3') && !cfgText.includes(SEC)); // nothing readable in the file (a short substring could appear in random base64 by chance)
  const dirN = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  assert.throws(() => acc.importText(dirN, cfgText, 'wrong'), (e) => e.key === 'badPass');
  assert.throws(() => acc.importText(dirN, cfgText.slice(0, -4) + 'AAAA', 'Open sesame1'), (e) => e.key === 'badPass'); // a changed file
  assert.throws(() => acc.importText(dirN, 'hello', 'Open sesame1'), (e) => e.key === 'badConfig');
  assert.ok(!fs.existsSync(path.join(dirN, 'accounts.txt'))); // failed imports wrote nothing
  assert.deepStrictEqual(acc.importText(dirN, cfgText.replace(/(.{40})/g, '$1\n'), 'Open sesame1'), { added: 3, updated: 0, bad: 0 }); // line breaks from copying are fine
  assert.deepStrictEqual(acc.loadAccounts(dirN).accounts, acc.loadAccounts(dirM).accounts);
  fs.rmSync(dirN, { recursive: true, force: true });

  // the search uses only the chosen accounts and takes a Guard account with a secret without asking
  fs.writeFileSync(path.join(dirM, 'ids.txt'), 'ManA');
  acc.setUse(dirM, ['m1', 'm2'], false);
  owned.m3 = ''; postBy.length = 0; hlogs.length = 0;
  const pick = await hunt.runHunt({ logins: acc.selected(dirM) }, { log: hio.log, dir: dirM }, L, { fetch: fakeFetch });
  assert.strictEqual(pick.claimed, 1);
  assert.deepStrictEqual(postBy.splice(0), ['m3']);
  // a code Steam refuses (an account logging in again within the same 30 s) is made again, not asked for
  Object.assign(swapTiming, { totpStep: 20, totpPad: 1 });
  guardFirst.add('m3'); codes.length = 0; delete owned.m3; hlogs.length = 0;
  fs.writeFileSync(path.join(dirM, 'ids.txt'), 'ManB');
  let gAsked = 0;
  const gRun = await hunt.runHunt({ logins: ['m3'] }, { log: hio.log, dir: dirM, askCode: async () => { gAsked++; return '0'; } }, L, { fetch: fakeFetch });
  guardFirst.clear();
  assert.strictEqual(gRun.claimed, 1);
  assert.deepStrictEqual(codes, ['12345']);
  assert.strictEqual(gAsked, 0);
  // a Guard account whose code cannot be entered is cancelled; the search goes on with the next account
  guardFirst.add('m1'); owned.m1 = ''; owned.m2 = ''; hlogs.length = 0; postBy.length = 0;
  fs.writeFileSync(path.join(dirM, 'ids.txt'), 'ManC');
  const cRun = await hunt.runHunt({ logins: ['m1', 'm2'] }, { log: hio.log, dir: dirM, askCode: async () => { throw Object.assign(new Error('Steam Guard login cancelled'), { key: 'loginCancelled' }); } }, L, { fetch: fakeFetch });
  guardFirst.clear();
  assert.strictEqual(cRun.claimed, 1);
  assert.deepStrictEqual(postBy.splice(0), ['m2']);
  assert.ok(hlogs.some(([k, p]) => k === 'accCancelled' && p.login === 'm1') && !hlogs.some(([k]) => k === 'accFail'));
  acc.remove(dirM, ['m3']);
  assert.deepStrictEqual(acc.list(dirM).map((a) => a.login), ['m1', 'm2']);
  assert.ok(!fs.readFileSync(path.join(dirM, 'accounts.txt'), 'utf8').includes('m3:'));
  fs.rmSync(dirM, { recursive: true, force: true });

  // the ID count: valid, without repeats and without the claimed ones; wrong entries counted apart
  const dirR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  assert.deepStrictEqual(hunt.readIds(dirR), { todo: [], bad: 0 }); // no files yet
  fs.writeFileSync(path.join(dirR, 'ids.txt'), '# c\nAAA, bad!, AAA, BBB\nCCC;ab\n');
  fs.writeFileSync(path.join(dirR, 'claimed.txt'), 'BBB:acc\n');
  assert.deepStrictEqual(hunt.readIds(dirR), { todo: ['AAA', 'CCC'], bad: 2 }); // "bad!" and "ab" (too short)
  assert.deepStrictEqual(hunt.initFiles(dirR), ['available.txt', 'accounts.txt']); // only what is missing is made, ids.txt stays
  assert.strictEqual(fs.readFileSync(path.join(dirR, 'ids.txt'), 'utf8').includes('AAA, bad!'), true);
  fs.rmSync(dirR, { recursive: true, force: true });

  // empty list -> clear error; Stop ends the run early and says so
  fs.writeFileSync(path.join(dir, 'ids.txt'), '# nothing\n');
  await assert.rejects(hunt.runHunt({}, hio, L, { fetch: fakeFetch }), (e) => e.key === 'noIds');
  fs.writeFileSync(path.join(dir, 'ids.txt'), 'Aaa1, Bbb2, Ccc3');
  hlogs.length = 0;
  const stopped = await hunt.runHunt({}, hio, L, { fetch: async (u) => { hunt.stopHunt(); return fakeFetch(u); } });
  assert.strictEqual(stopped.checked, 1);
  assert.ok(hlogs.some(([k]) => k === 'huntStopped'));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
