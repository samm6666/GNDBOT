'use strict';

// End-to-end: the real agent entrypoint + pm2 with fake bots + the real Electron app.
// Needs the Electron binary (npm install), the "playwright" package, and a display
// (on Linux: xvfb-run -a node test/e2e.js [screenshot-dir]).

const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const OUT = path.resolve(process.argv[2] || os.tmpdir());
const REPO = path.resolve(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-e2e-'));
process.env.PM2_HOME = path.join(root, '.pm2');
const pm2 = require(REPO + '/agent/node_modules/pm2');
const { _electron } = require('playwright');
const KEY = 'e2e-key-'.padEnd(48, 'e');
const PORT = 7000 + Math.floor(Math.random() * 900);
const FAKEBOT = REPO + '/agent/test/fixtures/fakebot.js';
const p = (fn, ...a) => new Promise((res, rej) => fn.call(pm2, ...a, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.writeFileSync(path.join(root, '.env'), 'DISCORD_TOKEN=e2e-music-secret\n');
  const app = (name, bn) => ({ name, script: FAKEBOT, cwd: root, env: { BOT_NAME: bn, DISCORD_TOKEN: 'e2e-music-secret' } });
  fs.writeFileSync(path.join(root, 'deploy/ecosystem.config.js'), `module.exports=${JSON.stringify({ apps: [app('gnd-music', 'GND Music'), app('gnd-games', 'GND Games'), app('gnd-system', 'GND System')] })}`);
  await p(pm2.connect);
  await p(pm2.start, path.join(root, 'deploy/ecosystem.config.js'), {});
  const agent = spawn(process.execPath, [REPO + '/agent/src/index.js'], {
    env: { ...process.env, CONTROL_API_KEY: KEY, CONTROL_PORT: String(PORT), PROJECT_ROOT: root, CONTROL_DATA_DIR: path.join(root, 'data'), BOTS_FILE: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.on('exit', () => agent.kill('SIGTERM'));
  agent.stdout.on('data', (d) => process.stdout.write('[agent] ' + d));
  agent.stderr.on('data', (d) => process.stdout.write('[agent!] ' + d));
  await new Promise((r) => setTimeout(r, 2500));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-home-'));
  const electronApp = await _electron.launch({
    executablePath: require(REPO + '/desktop/node_modules/electron'),
    args: [REPO + '/desktop', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  });
  const win = await electronApp.firstWindow();
  win.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  win.on('console', (m) => console.log('console.' + m.type(), m.text()));
  await win.waitForSelector('#page-connection.active', { timeout: 15000 });
  console.log('connection page shown on first run: OK');
  const hasNode = await win.evaluate(() => typeof require !== 'undefined' || typeof process !== 'undefined');
  console.log('renderer has node access:', hasNode);
  if (hasNode) throw new Error('renderer must not have Node access');
  await win.fill('#conn-server', `http://127.0.0.1:${PORT}`);
  await win.fill('#conn-key', 'wrong-key-wrong-key-wrong-key-wrong-key');
  await win.click('#conn-save');
  await win.waitForSelector('.toast.bad', { timeout: 10000 });
  console.log('wrong key toast:', await win.textContent('.toast.bad'));
  await win.fill('#conn-key', KEY);
  await win.click('#conn-save');
  await win.waitForSelector('#page-home.active', { timeout: 15000 });
  await win.waitForFunction(() => document.querySelectorAll('.card.online').length === 3, null, { timeout: 15000 });
  console.log('home shows 3 online bots: OK');
  await win.waitForFunction(() => document.querySelector('#live-state').classList.contains('online'), null, { timeout: 15000 });
  console.log('live channel: online');
  await win.screenshot({ path: path.join(OUT, 'electron-home.png') });

  // stop the games bot from its card
  const gamesCard = win.locator('.card', { hasText: 'GND Games' });
  await gamesCard.locator('button', { hasText: 'إيقاف' }).click();
  await win.waitForSelector('#modal:not(.hidden)');
  await win.screenshot({ path: path.join(OUT, 'electron-modal.png') });
  await win.click('#modal-ok');
  await win.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('GND Games') && c.classList.contains('stopped')), null, { timeout: 15000 });
  console.log('stop from card: OK');
  await gamesCard.locator('button', { hasText: 'تشغيل' }).click();
  await win.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('GND Games') && c.classList.contains('online')), null, { timeout: 15000 });
  console.log('start from card: OK');

  // logs page gets live lines, secrets redacted
  await win.click('.nav-item[data-page="logs"]');
  await win.waitForFunction(() => document.querySelector('#logs-console').textContent.includes('tick'), null, { timeout: 10000 });
  const logsText = await win.textContent('#logs-console');
  console.log('logs contain secret:', logsText.includes('e2e-music-secret'), '| contain [REDACTED]:', logsText.includes('[REDACTED]'));
  if (logsText.includes('e2e-music-secret')) throw new Error('secret leaked into the log view');

  // presence command round trip
  await win.click('.nav-item[data-page="settings"]');
  await win.selectOption('#presence-status', 'idle');
  await win.selectOption('#presence-type', 'listening');
  await win.fill('#presence-text', 'GND e2e');
  await win.click('#presence-save');
  await win.waitForSelector('.toast.ok', { timeout: 10000 });
  console.log('presence toast:', await win.locator('.toast.ok').last().textContent());

  // report preview
  await win.click('.nav-item[data-page="report"]');
  await win.click('#report-preview');
  await win.waitForFunction(() => document.querySelector('#report-text').textContent.includes('# GND bot report'), null, { timeout: 10000 });
  const reportText = await win.textContent('#report-text');
  console.log('report preview: OK, has secret:', reportText.includes('e2e-music-secret'));
  if (reportText.includes('e2e-music-secret')) throw new Error('secret leaked into the report');

  // config on disk: key encrypted or at least not plain text
  const cfgFile = path.join(home, '.config', 'GND Control', 'config.json');
  const cfgText = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '(missing ' + cfgFile + ')';
  console.log('config stores key in plain text:', cfgText.includes(KEY), '| keyEncrypted:', /"keyEncrypted": true/.test(cfgText));
  if (cfgText.includes(KEY)) throw new Error('API key stored in plain text');

  await electronApp.evaluate(({ app }) => { app.exit(0); }).catch(() => {});
  agent.kill('SIGTERM');
  await p(pm2.delete, 'all').catch(() => {});
  pm2.disconnect();
  try { process.kill(parseInt(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), 'utf8'), 10), 'SIGTERM'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  console.log('E2E DONE');
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); try { process.kill(parseInt(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), 'utf8'), 10), 'SIGTERM'); } catch {} process.exit(1); });
