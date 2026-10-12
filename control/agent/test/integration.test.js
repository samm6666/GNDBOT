'use strict';

// Runs a real pm2 daemon (isolated PM2_HOME) with two fake bots and drives the agent's HTTP + WS API.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-ctl-'));
process.env.PM2_HOME = path.join(root, '.pm2');

const WebSocket = require('ws');
const pm2 = require('pm2');
const configLib = require('../src/config');
const { Redactor } = require('../src/redact');
const { Pm2Control } = require('../src/pm2');
const { Settings } = require('../src/settings');
const { GitHubReporter } = require('../src/github');
const { CrashWatch } = require('../src/watch');
const { Updater } = require('../src/updater');
const { createServer } = require('../src/server');
const system = require('../src/system');
const envfile = require('../src/envfile');

const KEY = 'test-key-'.padEnd(48, 'x');
const LITERAL_SECRET = 'literal-secret-abcdef';
const FAKEBOT = path.join(__dirname, 'fixtures', 'fakebot.js');

let ctx;
let base;
let ghCalls = [];
let ghServer;

function writeProject() {
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'games'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), `DISCORD_TOKEN=${LITERAL_SECRET}\nPREFIX=!\n`);
  fs.writeFileSync(path.join(root, 'games', '.env'), 'DISCORD_TOKEN=games-secret-123456\n');
  const app = (name, botName, token) => ({
    name,
    script: FAKEBOT,
    cwd: root,
    autorestart: true,
    env: { BOT_NAME: botName, DISCORD_TOKEN: token },
  });
  fs.writeFileSync(
    path.join(root, 'deploy', 'ecosystem.config.js'),
    `module.exports = ${JSON.stringify({ apps: [app('t-music', 'music', LITERAL_SECRET), app('t-games', 'games', 'games-secret-123456')] }, null, 2)};\n`,
  );
  fs.writeFileSync(
    path.join(root, 'bots.json'),
    JSON.stringify([
      { id: 'music', label: 'Music', pm2: 't-music', dir: '.', env: '.env' },
      { id: 'games', label: 'Games', pm2: 't-games', dir: 'games', env: 'games/.env' },
    ]),
  );
}

function api(method, p, body, key = KEY) {
  return fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function waitFor(fn, timeoutMs = 15_000, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('timed out waiting for condition');
}

test.before(async () => {
  writeProject();

  ghServer = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      ghCalls.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ number: 1, html_url: 'https://github.test/o/r/issues/1' }));
    });
  });
  await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));

  const config = configLib.load({
    envFile: '/nonexistent',
    botsFile: path.join(root, 'bots.json'),
    env: {
      CONTROL_API_KEY: KEY,
      PROJECT_ROOT: root,
      CONTROL_DATA_DIR: path.join(root, 'data'),
      GITHUB_TOKEN: 'gh-test-token',
      GITHUB_REPO: 'o/r',
      GITHUB_API_URL: `http://127.0.0.1:${ghServer.address().port}`,
    },
  });
  const redactor = new Redactor();
  redactor.addEnv(envfile.read(path.join(root, '.env')));
  redactor.addEnv(envfile.read(path.join(root, 'games', '.env')));
  const control = new Pm2Control(config);
  await control.connect();
  const watch = new CrashWatch(config.autoReport);
  control.on('event', (e) => watch.onEvent(e));
  ctx = {
    config,
    control,
    redactor,
    settings: new Settings(config.dataDir, { autoReport: true }),
    github: new GitHubReporter(config.github),
    updater: new Updater(config, control, redactor),
    watch,
    system: system.snapshot,
  };
  const { server } = createServer(ctx);
  ctx.server = server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (ctx) {
    ctx.server.close();
    await new Promise((r) => pm2.delete('all', () => r()));
    ctx.control.disconnect();
    // pm2.killDaemon() leaves timers behind that keep the test process alive, so signal the daemon directly.
    try {
      process.kill(parseInt(fs.readFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), 'utf8'), 10), 'SIGTERM');
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ghServer) ghServer.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects requests without the right key', async () => {
  const res = await api('GET', '/api/overview', null, 'wrong-key');
  assert.strictEqual(res.status, 401);
  const health = await fetch(`${base}/healthz`);
  assert.strictEqual(health.status, 200);
});

test('starts bots from the ecosystem file and reports them online', async () => {
  let res = await api('GET', '/api/overview');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.bots.map((b) => b.status), ['missing', 'missing']);

  assert.strictEqual((await api('POST', '/api/bots/music/start')).status, 200);
  assert.strictEqual((await api('POST', '/api/bots/games/start')).status, 200);

  res = await waitFor(async () => {
    const r = await api('GET', '/api/overview');
    return r.body.bots.every((b) => b.status === 'online' && b.stats) ? r : null;
  });
  const music = res.body.bots.find((b) => b.id === 'music');
  assert.strictEqual(music.stats.guilds, 2);
  assert.strictEqual(music.stats.users, 12);
  assert.strictEqual(music.stats.players, 2);
  assert.strictEqual(music.stats.ping, 42);
  assert.ok(!JSON.stringify(res.body).includes(LITERAL_SECRET), 'overview must not leak env values');
  assert.ok(res.body.system.memory.total > 0);
});

test('sends commands to a bot and gets the reply', async () => {
  const res = await api('POST', '/api/bots/music/command', { action: 'setPresence', payload: { status: 'dnd', activity: { type: 'listening', name: 'GND' } } });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.result, { status: 'dnd', activity: { type: 'listening', name: 'GND' } });
  const name = await api('POST', '/api/bots/music/command', { action: 'setUsername', payload: { username: 'x' } });
  assert.strictEqual(name.status, 502);
  assert.match(name.body.error, /2-32/);
  const unknown = await api('POST', '/api/bots/music/command', { action: 'rm -rf' });
  assert.strictEqual(unknown.status, 400);
});

test('streams logs over the websocket with secrets removed', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Authorization: `Bearer ${KEY}` } });
  const seen = [];
  ws.on('message', (m) => seen.push(JSON.parse(m.toString())));
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  await api('POST', '/api/bots/music/restart');
  await waitFor(async () => seen.some((m) => m.type === 'log' && m.data.bot === 'music' && /ready, token/.test(m.data.line)));
  const ready = seen.find((m) => m.type === 'log' && /ready, token/.test(m.data.line));
  assert.ok(!ready.data.line.includes(LITERAL_SECRET));
  assert.ok(ready.data.line.includes('[REDACTED]'));
  assert.ok(seen.some((m) => m.type === 'event' && m.data.bot === 'music'));
  ws.close();

  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Authorization: 'Bearer nope' } });
  const err = await new Promise((r) => bad.on('error', r));
  assert.match(String(err.message), /401/);
});

test('returns log history with secrets removed', async () => {
  const res = await api('GET', '/api/bots/music/logs?lines=50&stream=all');
  assert.strictEqual(res.status, 200);
  const text = res.body.entries.map((e) => e.line).join('\n');
  assert.match(text, /fake error line/);
  assert.ok(!text.includes(LITERAL_SECRET));
});

test('lists and edits .env keys without returning values', async () => {
  let res = await api('GET', '/api/bots/music/env');
  assert.deepStrictEqual(res.body.keys.map((k) => k.key), ['DISCORD_TOKEN', 'PREFIX']);
  assert.ok(!JSON.stringify(res.body).includes(LITERAL_SECRET));
  res = await api('PUT', '/api/bots/music/env', { key: 'PREFIX', value: '?' });
  assert.strictEqual(res.body.change, 'updated');
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /PREFIX=\?/);
  res = await api('PUT', '/api/bots/music/env', { key: 'BAD KEY', value: '1' });
  assert.strictEqual(res.status, 400);
});

test('stops and starts a bot', async () => {
  await api('POST', '/api/bots/games/stop');
  await waitFor(async () => (await api('GET', '/api/overview')).body.bots.find((b) => b.id === 'games').status === 'stopped');
  await api('POST', '/api/bots/games/start');
  await waitFor(async () => (await api('GET', '/api/overview')).body.bots.find((b) => b.id === 'games').status === 'online');
  assert.strictEqual((await api('POST', '/api/bots/nope/start')).status, 404);
});

test('builds a report and files it on GitHub without secrets', async () => {
  const res = await api('GET', '/api/report?focus=music');
  assert.strictEqual(res.status, 200);
  const md = res.body.markdown;
  assert.match(md, /# GND bot report/);
  assert.match(md, /\| music \| t-music \| online/);
  assert.match(md, /fake error line/);
  assert.match(md, /\.env keys \(\.env\):\*\* DISCORD_TOKEN, PREFIX/);
  assert.ok(!md.includes(LITERAL_SECRET) && !md.includes('games-secret-123456'));

  const gh = await api('POST', '/api/report/github', { focus: 'music', note: 'music stops after 5 minutes' });
  assert.strictEqual(gh.status, 200, JSON.stringify(gh.body));
  assert.strictEqual(gh.body.url, 'https://github.test/o/r/issues/1');
  const call = ghCalls.find((c) => c.method === 'POST');
  assert.strictEqual(call.url, '/repos/o/r/issues');
  assert.deepStrictEqual(call.body.labels, ['claude-report']);
  assert.match(call.body.body, /music stops after 5 minutes/);
  assert.ok(!call.body.body.includes(LITERAL_SECRET));
});

test('settings round-trip', async () => {
  let res = await api('PUT', '/api/settings', { autoReport: false });
  assert.deepStrictEqual(res.body, { autoReport: false });
  res = await api('PUT', '/api/settings', { autoReport: 'yes' });
  assert.strictEqual(res.status, 400);
  res = await api('PUT', '/api/settings', { other: true });
  assert.strictEqual(res.status, 400);
});
