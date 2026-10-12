'use strict';

// Renders the app UI in Chromium against a real agent + pm2 with fake bots and saves screenshots.
// Needs the "playwright" package (npm i -g playwright) and a Chromium build.
//   node test/preview.js <output-dir>

const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.resolve(process.argv[2] || 'preview');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-prev-'));
process.env.PM2_HOME = path.join(root, '.pm2');

const AGENT = path.resolve(__dirname, '..', '..', 'agent');
const pm2 = require(path.join(AGENT, 'node_modules', 'pm2'));
const WebSocket = require('ws');
const { chromium } = require('playwright');
const configLib = require(path.join(AGENT, 'src', 'config'));
const { Redactor } = require(path.join(AGENT, 'src', 'redact'));
const { Pm2Control } = require(path.join(AGENT, 'src', 'pm2'));
const { Settings } = require(path.join(AGENT, 'src', 'settings'));
const { GitHubReporter } = require(path.join(AGENT, 'src', 'github'));
const { CrashWatch } = require(path.join(AGENT, 'src', 'watch'));
const { Updater } = require(path.join(AGENT, 'src', 'updater'));
const { createServer } = require(path.join(AGENT, 'src', 'server'));
const system = require(path.join(AGENT, 'src', 'system'));

const KEY = 'preview-key-'.padEnd(48, 'p');
const FAKEBOT = path.join(AGENT, 'test', 'fixtures', 'fakebot.js');

function setupProject() {
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  for (const d of ['games', 'system']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'DISCORD_TOKEN=music-token-value\nCLIENT_ID=123\nLAVALINK_PASSWORD=youshallnotpass\nPREFIX=!\n');
  fs.writeFileSync(path.join(root, 'games', '.env'), 'DISCORD_TOKEN=games-token-value\nCLIENT_ID=456\n');
  fs.writeFileSync(path.join(root, 'system', '.env'), 'DISCORD_TOKEN=system-token-value\nOWNER_ID=789\nLOG_WEBHOOK=\n');
  fs.writeFileSync(path.join(root, 'lavalink.js'), "setInterval(() => console.log('[Lavalink] player update'), 1500);\n");
  const app = (name, botName) => ({ name, script: FAKEBOT, cwd: root, env: { BOT_NAME: botName, DISCORD_TOKEN: `${name}-token` } });
  fs.writeFileSync(path.join(root, 'deploy', 'ecosystem.config.js'), `module.exports = ${JSON.stringify({
    apps: [app('gnd-music', 'GND Music'), app('gnd-games', 'GND Games'), app('gnd-system', 'GND System'), { name: 'lavalink', script: path.join(root, 'lavalink.js') }],
  })};`);
}

(async () => {
  setupProject();
  fs.mkdirSync(out, { recursive: true });
  const config = configLib.load({
    envFile: '/nonexistent',
    botsFile: '/nonexistent',
    env: { CONTROL_API_KEY: KEY, PROJECT_ROOT: root, CONTROL_DATA_DIR: path.join(root, 'data'), GITHUB_TOKEN: 'x', GITHUB_REPO: 'samm6666/GNDBOT-v2' },
  });
  const redactor = new Redactor();
  const control = new Pm2Control(config);
  await control.connect();
  const watch = new CrashWatch(config.autoReport);
  const { server } = createServer({
    config, control, redactor, watch, system: system.snapshot,
    settings: new Settings(config.dataDir, { autoReport: true }),
    github: new GitHubReporter(config.github),
    updater: new Updater(config, control, redactor),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const b of config.bots) await control.action(b, 'start');
  await new Promise((r) => setTimeout(r, 2500));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));

  await page.exposeFunction('__gndCall', async (channel, arg) => {
    switch (channel) {
      case 'config':
        return { ok: true, data: { server: 'https://control.gnd.example', hasKey: true, notifications: true, closeToTray: true, liveState: 'online', version: '1.0.0' } };
      case 'api': {
        const res = await fetch(base + arg.path, {
          method: arg.method,
          headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: arg.body ? JSON.stringify(arg.body) : undefined,
        });
        const json = await res.json();
        return res.ok ? { ok: true, data: json } : { ok: false, error: json.error };
      }
      default:
        return { ok: true, data: null };
    }
  });
  await page.addInitScript(() => {
    const listeners = { live: [], state: [] };
    const call = async (channel, arg) => {
      const r = await window.__gndCall(channel, arg);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    window.__gndEmit = (msg) => listeners.live.forEach((fn) => fn(msg));
    window.gnd = {
      config: () => call('config'),
      connect: () => call('connect'),
      setPrefs: () => call('prefs'),
      forgetKey: () => call('forget'),
      api: (method, p, body) => call('api', { method, path: p, body }),
      reconnect: () => call('reconnect'),
      saveReport: () => call('save'),
      copy: () => call('copy'),
      openExternal: () => call('open'),
      pickAvatar: () => call('pick'),
      onLive: (fn) => listeners.live.push(fn),
      onLiveState: (fn) => listeners.state.push(fn),
    };
  });

  await page.goto('file://' + path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'));
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Authorization: `Bearer ${KEY}` } });
  ws.on('message', (m) => page.evaluate((msg) => window.__gndEmit(msg), JSON.parse(m.toString())).catch(() => {}));

  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log('saved', path.join(out, `${name}.png`));
  };
  const nav = (p) => page.click(`.nav-item[data-page="${p}"]`);

  await page.waitForSelector('.card');
  await shot('1-home');
  await nav('logs');
  await shot('2-logs');
  await nav('settings');
  await shot('3-settings');
  await nav('server');
  await shot('4-server');
  await nav('report');
  await page.selectOption('#report-focus', 'music');
  await page.fill('#report-note', 'بوت الموسيقى يوقف بعد 5 دقايق');
  await page.click('#report-preview');
  await shot('5-report');
  await nav('connection');
  await shot('6-connection');

  ws.close();
  await browser.close();
  server.close();
  await new Promise((r) => pm2.delete('all', () => r()));
  control.disconnect();
  try {
    process.kill(parseInt(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), 'utf8'), 10), 'SIGTERM');
  } catch {
    // gone
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
