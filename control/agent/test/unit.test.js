'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Redactor } = require('../src/redact');
const { keyMatches, Limiter, clientIp } = require('../src/auth');
const envfile = require('../src/envfile');
const { CrashWatch } = require('../src/watch');
const { GitHubReporter } = require('../src/github');
const configLib = require('../src/config');
const { activityFrom } = require('../../bot-link');

// Fake tokens are assembled at runtime so secret scanners do not flag the test file.
const FAKE_DISCORD_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz12345'].join('.');
const FAKE_GITHUB_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

test('redactor removes discord tokens, github tokens, webhooks and registered secrets', () => {
  const r = new Redactor();
  r.addEnv({ DISCORD_TOKEN: 'super-secret-value', PREFIX: '!', MONGO_URI: 'mongodb://u:p4ss@host/db' });
  const text = [
    `login ${FAKE_DISCORD_TOKEN}`,
    `gh ${FAKE_GITHUB_TOKEN}`,
    'hook https://discord.com/api/webhooks/123456/abcDEF-ghi_jkl',
    'value super-secret-value here',
    'url mongodb://u:p4ss@host/db',
    'header Bearer abcdefghijklmnopqrstuvwxyz',
    'prefix is !',
  ].join('\n');
  const out = r.redact(text);
  assert.ok(!out.includes(FAKE_DISCORD_TOKEN));
  assert.ok(!out.includes(FAKE_GITHUB_TOKEN));
  assert.ok(!out.includes('abcDEF-ghi_jkl'));
  assert.ok(!out.includes('super-secret-value'));
  assert.ok(!out.includes('p4ss'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(out.includes('prefix is !'), 'non-secret text stays');
});

test('keyMatches compares keys of any length safely', () => {
  assert.strictEqual(keyMatches('a'.repeat(40), 'a'.repeat(40)), true);
  assert.strictEqual(keyMatches('a'.repeat(40), 'b'.repeat(40)), false);
  assert.strictEqual(keyMatches('short', 'a'.repeat(40)), false);
  assert.strictEqual(keyMatches('', 'a'.repeat(40)), false);
});

test('limiter locks an IP after repeated bad keys', () => {
  let t = 0;
  const l = new Limiter({ maxFailures: 3, lockMs: 1000, now: () => t });
  assert.strictEqual(l.check('1.1.1.1'), 0);
  l.fail('1.1.1.1');
  l.fail('1.1.1.1');
  assert.strictEqual(l.check('1.1.1.1'), 0);
  l.fail('1.1.1.1');
  assert.ok(l.check('1.1.1.1') > 0);
  assert.strictEqual(l.check('2.2.2.2'), 0, 'other IPs are not affected');
  t = 2000;
  assert.strictEqual(l.check('1.1.1.1'), 0);
});

test('limiter caps requests per minute', () => {
  let t = 0;
  const l = new Limiter({ perMinute: 2, now: () => t });
  assert.strictEqual(l.check('ip'), 0);
  assert.strictEqual(l.check('ip'), 0);
  assert.ok(l.check('ip') > 0);
  t = 60_000;
  assert.strictEqual(l.check('ip'), 0);
});

test('clientIp trusts X-Forwarded-For only from localhost', () => {
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.strictEqual(clientIp(req('127.0.0.1', '9.9.9.9, 1.1.1.1'), true), '9.9.9.9');
  assert.strictEqual(clientIp(req('5.5.5.5', '9.9.9.9'), true), '5.5.5.5');
  assert.strictEqual(clientIp(req('127.0.0.1', '9.9.9.9'), false), '127.0.0.1');
});

test('envfile.setKey updates one key and keeps the rest of the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnd-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comment\nTOKEN=abc\r\nPREFIX=!\r\n');
  assert.strictEqual(envfile.setKey(file, 'PREFIX', '?'), 'updated');
  assert.strictEqual(envfile.setKey(file, 'NEW_KEY', 'hello world'), 'added');
  assert.strictEqual(envfile.setKey(file, 'TOKEN', null), 'removed');
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text, "# comment\r\nPREFIX=?\r\nNEW_KEY='hello world'\r\n");
  assert.deepStrictEqual(envfile.read(file), { PREFIX: '?', NEW_KEY: 'hello world' });
  assert.throws(() => envfile.setKey(file, 'BAD KEY', 'x'));
  assert.throws(() => envfile.setKey(file, 'K', 'two\nlines'));
  const info = envfile.describe(file);
  assert.deepStrictEqual(info.keys.map((k) => k.key), ['PREFIX', 'NEW_KEY']);
  assert.ok(!JSON.stringify(info).includes('hello world'), 'values are never returned');
});

test('envfile refuses paths outside the project', () => {
  const config = { projectRoot: '/srv/gnd' };
  assert.strictEqual(envfile.resolveEnvPath(config, { id: 'a', env: 'games/.env' }), '/srv/gnd/games/.env');
  assert.throws(() => envfile.resolveEnvPath(config, { id: 'a', env: '../../etc/passwd' }));
  assert.strictEqual(envfile.resolveEnvPath(config, { id: 'a', env: null }), null);
});

test('crash watch alerts once after N unexpected exits in the window', () => {
  let t = 0;
  const w = new CrashWatch({ crashes: 3, windowMs: 10_000, cooldownMs: 60_000, now: () => t });
  assert.strictEqual(w.onEvent({ bot: 'music', event: 'exit', manually: true }), null, 'manual stops do not count');
  w.onEvent({ bot: 'music', event: 'exit' });
  t = 1000;
  w.onEvent({ bot: 'music', event: 'exit' });
  t = 2000;
  const alert = w.onEvent({ bot: 'music', event: 'exit' });
  assert.ok(alert && alert.bot === 'music');
  t = 3000;
  assert.strictEqual(w.onEvent({ bot: 'music', event: 'exit' }), null, 'cooldown');
  t = 100_000;
  assert.strictEqual(w.onEvent({ bot: 'music', event: 'exit' }), null, 'old exits fall out of the window');
});

test('github reporter files an issue, or comments on an open one when deduping', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body && JSON.parse(opts.body), auth: opts.headers.Authorization });
    const json = (o) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(o) });
    if (opts.method === 'GET') return json([{ title: 'same', number: 7, html_url: 'https://x/7' }]);
    if (url.endsWith('/comments')) return json({});
    return json({ number: 9, html_url: 'https://x/9' });
  };
  const gh = new GitHubReporter({ token: 't0k', repo: 'o/r', api: 'https://api.test', label: 'claude-report' }, fakeFetch);
  const created = await gh.report({ title: 'new', body: 'b' });
  assert.deepStrictEqual(created, { url: 'https://x/9', number: 9, updated: false });
  assert.deepStrictEqual(calls[0].body, { title: 'new', body: 'b', labels: ['claude-report'] });
  assert.strictEqual(calls[0].auth, 'Bearer t0k');
  const deduped = await gh.report({ title: 'same', body: 'b2', dedupe: true });
  assert.deepStrictEqual(deduped, { url: 'https://x/7', number: 7, updated: true });
  assert.ok(calls.at(-1).url.endsWith('/repos/o/r/issues/7/comments'));
});

test('config validation requires a long API key', () => {
  const short = configLib.load({ env: { CONTROL_API_KEY: 'short' }, envFile: '/nonexistent', botsFile: '/nonexistent' });
  assert.ok(configLib.validate(short).length > 0);
  const ok = configLib.load({ env: { CONTROL_API_KEY: 'k'.repeat(43) }, envFile: '/nonexistent', botsFile: '/nonexistent' });
  assert.deepStrictEqual(configLib.validate(ok), []);
  assert.deepStrictEqual(ok.bots.map((b) => b.id), ['music', 'games', 'system', 'lavalink']);
});

test('bot-link maps activity names to discord activity types', () => {
  assert.deepStrictEqual(activityFrom({ type: 'listening', name: 'Quran' }), [{ type: 2, name: 'Quran' }]);
  assert.deepStrictEqual(activityFrom({ type: 'custom', name: 'hi' }), [{ type: 4, name: 'hi', state: 'hi' }]);
  assert.deepStrictEqual(activityFrom({ type: 'streaming', name: 's', url: 'https://twitch.tv/x' }), [{ type: 1, name: 's', url: 'https://twitch.tv/x' }]);
  assert.deepStrictEqual(activityFrom(null), []);
});
