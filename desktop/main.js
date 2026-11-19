'use strict';
// Desktop app: a native window around the same UI and routes as browser mode. The page talks to
// lib/routes.js over Electron IPC, so there is no local port and no token.
//   npm run desktop                  run from a checkout
//   "Harness Config Manager.exe" x.mcpb   open the installer for a bundle (Open with, drag onto the icon)
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const R = require('../lib/routes');

const APP_ID = 'com.jakemctigue.harness-config-manager';
const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const PAGE_URL = pathToFileURL(INDEX).href;
const ICON = path.join(__dirname, 'icon.png');
const BUNDLE_RE = /\.(mcpb|dxt)$/i;

// The first .mcpb / .dxt on a command line, resolved against the directory it was given in.
function bundleArg(argv, cwd) {
  const a = argv.find((x) => !x.startsWith('-') && BUNDLE_RE.test(x));
  return a ? path.resolve(cwd || process.cwd(), a) : null;
}

let win = null;

function openBundle(file) {
  if (!file) return;
  if (!win) return R.setOpenFile(file); // picked up by the first scan
  if (win.isMinimized()) win.restore();
  win.focus();
  const send = () => win.webContents.send('skm:open-file', file);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function contextMenu(params) {
  const f = params.editFlags;
  const items = params.isEditable
    ? [{ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' },
      { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
      { type: 'separator' }, { role: 'selectAll' }]
    : params.selectionText ? [{ role: 'copy' }] : [];
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 560,
    title: 'Harness Config Manager',
    icon: ICON,
    show: false,
    autoHideMenuBar: true, // Alt shows the menu (reload, zoom, developer tools)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  // The page never navigates; links to the web open in the default browser instead.
  win.webContents.on('will-navigate', (e, url) => { if (url !== PAGE_URL) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('context-menu', (e, params) => contextMenu(params));
  win.on('closed', () => { win = null; });
  win.loadFile(INDEX);
}

// One action from the page. Results go back as JSON text so the page sees exactly what the HTTP
// server would have sent.
// Only the app's own window, top frame, showing the bundled page may call (it cannot navigate away).
const fromPage = (e) => !!(win && e.sender.id === win.webContents.id && e.senderFrame && !e.senderFrame.parent
  && e.senderFrame.url.startsWith('file:'));

ipcMain.handle('skm:api', async (e, method, url, body) => {
  if (!fromPage(e)) return { error: 'unknown sender' };
  try {
    const data = await R.dispatch(String(method), String(url), body);
    return { json: JSON.stringify(data === undefined ? null : data) };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
});

// macOS hands files to a running app through this event, not argv.
app.on('open-file', (e, file) => { e.preventDefault(); if (BUNDLE_RE.test(file)) openBundle(file); });

const launchBundle = bundleArg(process.argv.slice(1));
if (!app.requestSingleInstanceLock({ bundle: launchBundle })) {
  app.quit(); // the running window opens the bundle (second-instance below)
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  R.setOpenFile(launchBundle);
  app.on('second-instance', (e, argv, cwd, extra) => {
    const file = (extra && extra.bundle) || bundleArg(argv.slice(1), cwd);
    if (file) openBundle(file);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
