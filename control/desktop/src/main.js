'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, safeStorage, Notification, dialog, clipboard, shell, Tray, Menu, nativeImage,
} = require('electron');
const WebSocket = require('ws');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const BOT_NAMES = { music: 'بوت الموسيقى', games: 'بوت الألعاب', system: 'بوت السيستم', lavalink: 'Lavalink' };

let win = null;
let tray = null;
let quitting = false;

// ---------- config (API key encrypted with Windows DPAPI through safeStorage) ----------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  } catch {
    return { notifications: true, closeToTray: true };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
}

function getKey(cfg) {
  if (!cfg.key) return '';
  try {
    if (cfg.keyEncrypted) return safeStorage.decryptString(Buffer.from(cfg.key, 'base64'));
    return Buffer.from(cfg.key, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return { key: safeStorage.encryptString(key).toString('base64'), keyEncrypted: true };
  }
  return { key: Buffer.from(key, 'utf8').toString('base64'), keyEncrypted: false };
}

function normalizeServer(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new Error('رابط السيرفر غير صحيح');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('لازم يكون الرابط https:// (عشان المفتاح ينرسل مشفّر)');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// ---------- API ----------

async function request(server, key, method, apiPath, body) {
  if (!/^\/api\/[\w\-/]*(\?[\w=&%.\-]*)?$/.test(apiPath)) throw new Error('bad path');
  let res;
  try {
    res = await fetch(server + apiPath, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 20_000 : 60_000),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'السيرفر ما رد (timeout)' : `ما قدرت أتصل بالسيرفر: ${err.cause ? err.cause.code || err.cause.message : err.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401) throw new Error('مفتاح API غلط');
  if (res.status === 429) throw new Error('محاولات كثيرة، انتظر شوي وجرب مرة ثانية');
  if (!res.ok) throw new Error((json && json.error) || `خطأ ${res.status}`);
  return json;
}

// ---------- live channel ----------

const live = { ws: null, timer: null, attempt: 0, state: 'off' };

function sendToWindow(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function setLiveState(state) {
  live.state = state;
  sendToWindow('live:state', state);
}

function notify(title, body) {
  const cfg = readConfig();
  if (cfg.notifications === false || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => showWindow());
  n.show();
}

function connectLive() {
  clearTimeout(live.timer);
  if (live.ws) {
    live.ws.removeAllListeners();
    live.ws.terminate();
    live.ws = null;
  }
  const cfg = readConfig();
  const key = getKey(cfg);
  if (!cfg.server || !key) return setLiveState('off');

  setLiveState('connecting');
  const url = cfg.server.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15_000 });
  live.ws = ws;

  ws.on('open', () => {
    live.attempt = 0;
    setLiveState('online');
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    sendToWindow('live:message', msg);
    if (msg.type === 'alert') {
      notify(`تنبيه: ${BOT_NAMES[msg.data.bot] || msg.data.bot}`, msg.data.reason);
    } else if (msg.type === 'event' && msg.data.event === 'exit' && !msg.data.manually) {
      notify(`${BOT_NAMES[msg.data.bot] || msg.data.bot} طاح`, 'pm2 بيرجّعه تلقائياً. شوف السجلات لو تكرر.');
    }
  });
  const retry = () => {
    if (live.ws !== ws) return;
    setLiveState('offline');
    live.attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(live.attempt, 5));
    live.timer = setTimeout(connectLive, delay);
  };
  ws.on('close', retry);
  ws.on('error', () => {}); // "close" follows and handles the retry
}

// ---------- window + tray ----------

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'GND Control',
    icon: ICON,
    backgroundColor: '#0b0b12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!quitting && readConfig().closeToTray !== false && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('GND Control');
  const restartAll = async () => {
    const cfg = readConfig();
    try {
      await request(cfg.server, getKey(cfg), 'POST', '/api/bots/all/restart');
      notify('GND Control', 'تم ريستارت البوتات');
    } catch (err) {
      notify('GND Control', err.message);
    }
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'فتح GND Control', click: showWindow },
    { label: 'ريستارت كل البوتات', click: restartAll },
    { type: 'separator' },
    { label: 'خروج', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

handle('config:get', () => {
  const cfg = readConfig();
  return {
    server: cfg.server || '',
    hasKey: Boolean(getKey(cfg)),
    keyEncrypted: Boolean(cfg.keyEncrypted),
    notifications: cfg.notifications !== false,
    closeToTray: cfg.closeToTray !== false,
    liveState: live.state,
    version: app.getVersion(),
  };
});

handle('config:connect', async ({ server, key }) => {
  const cfg = readConfig();
  const url = normalizeServer(server);
  const apiKey = key ? String(key).trim() : getKey(cfg);
  if (!apiKey) throw new Error('حط مفتاح API');
  const overview = await request(url, apiKey, 'GET', '/api/overview');
  writeConfig({ ...cfg, server: url, ...encodeKey(apiKey) });
  connectLive();
  return { agent: overview.agent };
});

handle('config:prefs', (prefs) => {
  const cfg = readConfig();
  if (typeof prefs.notifications === 'boolean') cfg.notifications = prefs.notifications;
  if (typeof prefs.closeToTray === 'boolean') cfg.closeToTray = prefs.closeToTray;
  writeConfig(cfg);
  return true;
});

handle('config:forget', () => {
  const cfg = readConfig();
  delete cfg.key;
  delete cfg.keyEncrypted;
  writeConfig(cfg);
  connectLive();
  return true;
});

handle('api', ({ method, path: apiPath, body }) => {
  const cfg = readConfig();
  if (!cfg.server) throw new Error('ما ربطت السيرفر للحين');
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error('bad method');
  return request(cfg.server, getKey(cfg), method, apiPath, body);
});

handle('live:reconnect', () => {
  connectLive();
  return live.state;
});

handle('report:save', async ({ markdown, name }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'حفظ التقرير',
    defaultPath: name || 'gnd-report.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, markdown, 'utf8');
  return res.filePath;
});

handle('clipboard:write', (text) => {
  clipboard.writeText(String(text));
  return true;
});

handle('open:external', (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(u.hostname)) throw new Error('blocked');
  return shell.openExternal(u.toString());
});

handle('avatar:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'اختر صورة البوت',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  const buf = fs.readFileSync(file);
  if (buf.length > 8 * 1024 * 1024) throw new Error('الصورة أكبر من 8MB');
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return { name: path.basename(file), dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` };
});

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('com.gnd.control');
  app.whenReady().then(() => {
    createWindow();
    createTray();
    connectLive();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
