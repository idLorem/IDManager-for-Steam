const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, nativeImage } =require('electron');
const fs = require('fs');
const path = require('path');
const { runSwap, runFastSwap, loadIds, closeAll } = require('./swap');
const { makeAsker } = require('./prompt');
const { runHunt, stopHunt, initFiles, readIds, tune, FILES } = require('./hunt');
const acc = require('./accounts');
const proxy = require('./proxy');

// The portable exe unpacks itself to a temp folder, so the files go next to the exe it was started from.
const dir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : __dirname);

// a covered window or a locked remote session must not make Chromium stop drawing: a long search keeps updating the journal
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// settings.json next to the exe: {tray}. Start with the system is kept by Windows itself (the Run entry of the exe).
const settingsFile = path.join(dir, 'settings.json');
const readSettings = () => { try { return { tray: !!JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tray }; } catch { return { tray: false }; } };
const settings = readSettings();
const exeFile = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; // the portable exe unpacks to a temp folder: the Run entry must point at the exe itself
const loginOpts = { path: exeFile, args: ['--autostart'] };
let win, tray = null, quitting = false;
const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };
const syncTray = () => {
  if (settings.tray && !tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('IDManager for Steam');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open / Открыть', click: showWin }, { label: 'Exit / Выход', click: () => app.quit() }]));
    tray.on('click', showWin);
  } else if (!settings.tray && tray) { tray.destroy(); tray = null; }
};
// one window: a second start (the exe again) brings the hidden one back instead of opening another copy
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', showWin);
app.whenReady().then(() => {
  if (!gotLock) return;
  win = new BrowserWindow({
    show: !(settings.tray && process.argv.includes('--autostart')), // started by the system with the tray on: stays in the tray
    width: 960, height: 900, minWidth: 720, minHeight: 640,
    autoHideMenuBar: true, backgroundColor: '#0b0b0c', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }, // a long search must keep drawing when the window is covered or the remote session is locked
  });
  win.loadFile('index.html');
  syncTray();
  // with the tray on, the close button hides the window; the search goes on in the background
  win.on('close', (e) => { if (settings.tray && !quitting) { e.preventDefault(); win.hide(); } });
  win.on('session-end', () => { quitting = true; }); // a closed-to-tray window must not hold up the shutdown of Windows
  try { initFiles(dir); } catch {} // ids.txt, available.txt and accounts.txt are made on start; existing ones stay as they are (e.g. a read-only folder just skips this)
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; closeAll(); });

const askCode = makeAsker({
  ask: (n, domain, wrong) => win.webContents.send('ask-code', n, domain, wrong),
  onCode: (h) => {
    const f = (_e, code) => h(code);
    ipcMain.on('code', f);
    return () => ipcMain.removeListener('code', f);
  },
});

ipcMain.on('code-cancel', () => askCode.skip());
// copy to the clipboard in the main process: the password does not have to travel through the window
ipcMain.handle('acc-copy', (_e, { login, what }) => {
  try { const a = acc.reveal(dir, login); clipboard.writeText(what === 'login' ? login : a.password); return { ok: true }; } catch (e) { return { error: { key: e.key, p: e.p, msg: e.message } }; }
});

const REPO = 'https://github.com/idLorem/IDManager-for-Steam';
const LINKS = { github: REPO, update: REPO + '/releases/latest' };
// true when version a is newer than b (v1.2.3 style, numbers only)
const newer = (a, b) => {
  const n = (v) => String(v).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
ipcMain.handle('app-info', () => ({ version: app.getVersion() }));
ipcMain.handle('update-check', async () => {
  try {
    const r = await fetch(REPO.replace('github.com/', 'api.github.com/repos/') + '/releases/latest', { headers: { 'User-Agent': 'IDManager-for-Steam', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return { ok: true, result: { none: true } }; // no release published yet
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const tag = String((await r.json()).tag_name || '');
    return { ok: true, result: { tag, newer: newer(tag, app.getVersion()) } };
  } catch (e) { return failure(e); }
});
ipcMain.handle('open-link', async (_e, key) => {
  try {
    if (!LINKS[key]) return { error: { key: 'noLink' } };
    await shell.openExternal(LINKS[key]);
    return { ok: true };
  } catch (e) { return failure(e); }
});

// proxy.json next to the exe keeps the address
const proxyFile = path.join(dir, 'proxy.json');
// only the address is kept; the proxy itself is always off after a start
const readProxy = () => { try { return String(JSON.parse(fs.readFileSync(proxyFile, 'utf8')).url || ''); } catch { return ''; } };
// swap and the account manager do not run through a proxy: one more address for the accounts could get them flagged
const noProxy = (fn) => (e, a) => (proxy.get() ? { error: { key: 'proxyLocked' } } : fn(e, a));
let busy = false;
// Runs one operation at a time. Swap and load need both accounts filled in (needAccounts).
const op = (fn, needAccounts = true) => async (_e, cfg) => {
  if (busy) return;
  if (needAccounts) {
    const { a1, a2 } = cfg;
    if (![a1.login, a1.password, a2.login, a2.password].every(Boolean)) return { error: { key: 'fillAcc' } };
  }
  busy = true;
  const log = (key, p) => win.webContents.send('log', key, p);
  try { return { ok: true, result: await fn(cfg, { log, askCode, dir, progress: (st) => win.webContents.send('progress', st) }) }; }
  catch (e) { return { error: { key: e.key, p: e.p, msg: e.message, acc: e.acc } }; }
  finally { askCode.cancel(); busy = false; } // a login still waiting for a code must not prompt after the end
};

// an account the program changed is unticked and marked in the manager: what is known about it is out of date
const changed = (...logins) => { try { const known = acc.loadAccounts(dir).accounts.map((x) => x.login); for (const l of logins) if (known.includes(l)) acc.patch(dir, l, { use: false, stale: true }); } catch {} }; // only accounts of the manager (a login typed by hand is not in the list)
// marked once the checks passed, success or not: from then on the swap may have changed either account
const afterSwap = (run) => async (cfg, io) => {
  let went = false;
  try { return await run(cfg, { ...io, log: (k, p) => { if (k === 'ready') went = true; io.log(k, p); } }); } finally { if (went) changed(cfg.a1.login, cfg.a2.login); }
};
ipcMain.handle('proxy-get', () => ({ ok: true, result: { url: readProxy(), on: !!proxy.get() } }));
// a change takes effect for the next logins: open sessions are closed, and nothing may change while an operation runs
ipcMain.handle('proxy-set', (_e, { url, on }) => {
  try {
    if (busy) return { error: { key: 'proxyBusy' } };
    proxy.set(on ? url : '');
    closeAll();
    fs.writeFileSync(proxyFile, JSON.stringify({ url: String(url || '').trim() }));
    return { ok: true, result: proxy.get() };
  } catch (e) { return failure(e); }
});
ipcMain.handle('proxy-test', async () => { try { return { ok: true, result: await proxy.test() }; } catch (e) { return failure(e); } });
ipcMain.handle('settings-get', () => ({ ok: true, result: { tray: settings.tray, autostart: app.isPackaged && app.getLoginItemSettings(loginOpts).openAtLogin } }));
ipcMain.handle('settings-set', (_e, { tray: t, autostart }) => {
  try {
    settings.tray = !!t;
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    syncTray();
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!autostart, ...loginOpts });
    return { ok: true };
  } catch (e) { return failure(e); }
});
// "from the start": the next search forgets where the stopped one was
ipcMain.handle('hunt-reset', () => { try { fs.rmSync(path.join(dir, FILES.resume), { force: true }); return { ok: true }; } catch (e) { return failure(e); } });
ipcMain.handle('start', noProxy(op(afterSwap(runSwap))));
// everything the fast swap logs goes to a file next to the exe as well, with the final result
let fastRun = []; // the lines of the last fast swap, for the Log button
const fastFile = (line) => { const l = new Date().toISOString() + ' ' + line; fastRun.push(l); try { fs.appendFileSync(path.join(dir, 'fastswap-log.txt'), l + '\n'); } catch {} };
ipcMain.handle('fast-log', () => fastRun.join('\n'));
ipcMain.handle('start-fast', noProxy(op(afterSwap(async (cfg, io) => {
  fastRun = [];
  fastFile('--- fast swap, offset ' + cfg.offset + ' ms');
  try {
    const r = await runFastSwap(cfg, { ...io, log: (k, p) => { fastFile(k === 'fastLog' ? p.m : k + ' ' + JSON.stringify(p || {})); io.log(k, p); } });
    fastFile('RESULT ok');
    return r;
  } catch (e) { fastFile('RESULT error ' + (e.key || '') + ' ' + e.message + (e.p ? ' ' + JSON.stringify(e.p) : '')); throw e; }
}))));
ipcMain.handle('load-ids', noProxy(op(loadIds)));
// the search uses the accounts ticked in the manager; what it learns about them (own ID) is stored back
ipcMain.handle('hunt', op((cfg, io) => runHunt({ ...cfg, logins: acc.selected(dir) }, {
  ...io,
  log: (k, p) => {
    if (k === 'claimed' || k === 'accHasId') { try { acc.patch(dir, p.login, { id: p.id }); } catch {} }
    if (k === 'claimed') changed(p.login);
    io.log(k, p);
  },
}), false));
ipcMain.on('hunt-stop', () => { stopHunt(); acc.stop(); });
// account manager: the list never carries passwords
const failure = (e) => ({ error: { key: e.key, p: e.p, msg: e.message } });
const quick = (fn) => (_e, a) => { try { return { ok: true, result: fn(a) }; } catch (e) { return failure(e); } };
ipcMain.handle('acc-list', quick(() => acc.list(dir)));
ipcMain.handle('acc-add', quick((text) => acc.add(dir, text)));
ipcMain.handle('acc-remove', quick((logins) => acc.remove(dir, logins)));
ipcMain.handle('acc-use', quick(({ logins, use }) => acc.setUse(dir, logins, use)));
ipcMain.handle('acc-reveal', quick((login) => acc.reveal(dir, login)));
ipcMain.handle('acc-import', quick(({ text, password }) => acc.importText(dir, text, password)));
// the encrypted config is saved through the system dialog; nothing is written if the user cancels
ipcMain.handle('acc-export', async (_e, password) => {
  try {
    const text = acc.exportText(dir, password);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, 'idmanager-accounts.vsa'), filters: [{ name: 'IDManager', extensions: ['vsa'] }] });
    if (r.canceled || !r.filePath) return { ok: true, result: '' };
    fs.writeFileSync(r.filePath, text, 'utf8');
    return { ok: true, result: r.filePath };
  } catch (e) { return failure(e); }
});
// import: the user picks the .vsa file in the system dialog; nothing happens if the dialog is cancelled
ipcMain.handle('acc-import-file', async (_e, password) => {
  try {
    const r = await dialog.showOpenDialog(win, { defaultPath: dir, properties: ['openFile'], filters: [{ name: 'IDManager', extensions: ['vsa', 'txt'] }, { name: '*', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: true, result: null };
    if (fs.statSync(r.filePaths[0]).size > 1e6) throw Object.assign(new Error('badConfig'), { key: 'badConfig' }); // a config is a few KB, never read a huge file
    return { ok: true, result: acc.importText(dir, fs.readFileSync(r.filePaths[0], 'utf8'), password) };
  } catch (e) { return failure(e); }
});
// add accounts from a text file (login:password per line), picked in the system dialog
ipcMain.handle('acc-add-file', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { defaultPath: dir, properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt'] }, { name: '*', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: true, result: null };
    if (fs.statSync(r.filePaths[0]).size > 1e6) throw new Error('file is too big for an accounts list');
    return { ok: true, result: acc.add(dir, fs.readFileSync(r.filePaths[0], 'utf8')) };
  } catch (e) { return failure(e); }
});
// only the accounts ticked in the manager are checked
ipcMain.handle('acc-refresh', noProxy(op((_cfg, io) => acc.refresh(dir, acc.toCheck(dir), io), false)));
ipcMain.handle('acc-clear', noProxy(op((cfg, io) => acc.clearId(dir, cfg, io), false)));
ipcMain.on('hunt-tune', (_e, cfg) => tune(cfg)); // slider changes during a search
ipcMain.handle('files-open', () => shell.openPath(dir));
// open the list of IDs or the found ones in the default editor; a file the user deleted is made again first
const OPEN = { ids: 'ids.txt', found: 'available.txt', claimed: 'claimed.txt' };
ipcMain.handle('open-file', async (_e, key) => {
  try {
    if (!OPEN[key]) throw new Error('unknown file');
    initFiles(dir);
    const file = path.join(dir, OPEN[key]);
    if (!fs.existsSync(file)) fs.writeFileSync(file, ''); // claimed.txt appears with the first claim, so it may not exist yet
    const err = await shell.openPath(file);
    return err ? { error: { msg: err } } : { ok: true };
  } catch (e) { return failure(e); }
});
ipcMain.handle('ids-count', quick(() => { const r = readIds(dir); return { n: r.todo.length, bad: r.bad }; }));
