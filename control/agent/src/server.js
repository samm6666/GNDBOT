'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { keyMatches, bearer, clientIp, Limiter } = require('./auth');
const envfile = require('./envfile');
const report = require('./report');

const VERSION = require('../package.json').version;
const BOT_ACTIONS = new Set(['start', 'stop', 'restart']);
const COMMANDS = new Set(['setPresence', 'setUsername', 'setAvatar', 'ping', 'reloadConfig', 'stats']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

function createServer(ctx) {
  const { config, control, redactor, settings, github, updater, watch, system } = ctx;
  const limiter = ctx.limiter || new Limiter();
  const startedAt = Date.now();
  const sweep = setInterval(() => limiter.sweep(), 60_000);
  sweep.unref();

  const botOr404 = (id) => {
    const bot = control.bot(id);
    if (!bot) throw new HttpError(404, `unknown bot "${id}"`);
    return bot;
  };

  const buildReport = (opts = {}) => report.build({ config, control, redactor, system: () => system(config), ...opts });

  // [method, regex, handler(match, body, req)]
  const routes = [
    ['GET', /^\/api\/overview$/, async () => ({
      agent: { version: VERSION, uptime: Date.now() - startedAt, node: process.version },
      bots: await control.overview(),
      system: await system(config),
      settings: settings.get(),
      github: { enabled: github.enabled, repo: config.github.repo },
      update: { running: updater.running, last: updater.last },
    })],

    ['POST', /^\/api\/bots\/all\/restart$/, async () => {
      const results = {};
      for (const bot of config.bots.filter((b) => b.kind === 'bot')) {
        try {
          await control.action(bot, 'restart');
          results[bot.id] = 'ok';
        } catch (err) {
          results[bot.id] = redactor.redact(err.message);
        }
      }
      return { results };
    }],

    ['POST', /^\/api\/bots\/([\w-]+)\/(start|stop|restart)$/, async (m) => {
      const bot = botOr404(m[1]);
      if (!BOT_ACTIONS.has(m[2])) throw new HttpError(400, 'unknown action');
      await control.action(bot, m[2]);
      return { ok: true };
    }],

    ['GET', /^\/api\/bots\/([\w-]+)\/logs$/, async (m, _b, _req, url) => {
      const bot = botOr404(m[1]);
      const lines = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('lines') || '200', 10) || 200));
      const stream = ['out', 'err', 'all'].includes(url.searchParams.get('stream')) ? url.searchParams.get('stream') : 'all';
      const entries = await control.history(bot, lines, stream);
      return { entries: entries.map((e) => ({ ...e, line: redactor.redact(e.line) })) };
    }],

    ['POST', /^\/api\/bots\/([\w-]+)\/command$/, async (m, body) => {
      const bot = botOr404(m[1]);
      if (bot.kind !== 'bot') throw new HttpError(400, `${bot.label} does not accept commands`);
      if (!COMMANDS.has(body.action)) throw new HttpError(400, 'unknown command');
      const reply = await control.command(bot, body.action, body.payload || {});
      if (!reply.ok) throw new HttpError(502, redactor.redact(reply.error || 'command failed'));
      return { ok: true, result: reply.result ?? null };
    }],

    ['GET', /^\/api\/bots\/([\w-]+)\/env$/, async (m) => {
      const bot = botOr404(m[1]);
      const file = envfile.resolveEnvPath(config, bot);
      if (!file) throw new HttpError(404, `${bot.label} has no .env file`);
      return { file: bot.env, ...envfile.describe(file) };
    }],

    ['PUT', /^\/api\/bots\/([\w-]+)\/env$/, async (m, body) => {
      const bot = botOr404(m[1]);
      const file = envfile.resolveEnvPath(config, bot);
      if (!file) throw new HttpError(404, `${bot.label} has no .env file`);
      if (typeof body.key !== 'string') throw new HttpError(400, 'key is required');
      const value = body.value === null ? null : String(body.value ?? '');
      let change;
      try {
        change = envfile.setKey(file, body.key, value);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      if (value) redactor.addSecrets([value]);
      if (body.restart) await control.action(bot, 'restart');
      return { ok: true, change, restarted: !!body.restart };
    }],

    ['GET', /^\/api\/report$/, async (_m, _b, _req, url) => ({
      markdown: await buildReport({ reason: 'manual (desktop app)', focus: url.searchParams.get('focus') || null }),
    })],

    ['POST', /^\/api\/report\/github$/, async (_m, body) => {
      if (!github.enabled) throw new HttpError(400, 'GITHUB_TOKEN is not set in control/agent/.env');
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
      let markdown = await buildReport({ reason: 'manual (desktop app)', focus: body.focus || null });
      if (note) markdown = `> **Note from the owner:** ${redactor.redact(note).replace(/\n/g, '\n> ')}\n\n${markdown}`;
      const title = `[GND report] ${body.focus ? `${body.focus}: ` : ''}${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      return github.report({ title, body: markdown });
    }],

    ['GET', /^\/api\/settings$/, async () => settings.get()],
    ['PUT', /^\/api\/settings$/, async (_m, body) => {
      try {
        return settings.set(body);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }],

    ['POST', /^\/api\/update$/, async () => {
      if (updater.running) throw new HttpError(409, 'an update is already running');
      updater.start().then((result) => {
        if (result.restartAgent) setTimeout(() => process.exit(0), 3000); // pm2 brings the agent back
      });
      return { started: true };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://agent.local');
    const ip = clientIp(req, config.trustProxy);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    const wait = limiter.check(ip);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return send(res, 429, { error: 'too many requests' });
    }
    if (!keyMatches(bearer(req), config.apiKey)) {
      limiter.fail(ip);
      return send(res, 401, { error: 'invalid API key' });
    }
    limiter.succeed(ip);

    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'not found' });
    try {
      const limit = /\/command$/.test(url.pathname) ? 12 * 1024 * 1024 : 256 * 1024;
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, limit) : {};
      const result = await route[2](url.pathname.match(route[1]), body, req, url);
      send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      send(res, status, { error: redactor.redact(err.message) });
    }
  });

  // Live channel: logs, pm2 events, bot stats, alerts and update output.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://agent.local');
    const ip = clientIp(req, config.trustProxy);
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (limiter.check(ip)) return reject(429, 'Too Many Requests');
    if (!keyMatches(bearer(req), config.apiKey)) {
      limiter.fail(ip);
      return reject(401, 'Unauthorized');
    }
    limiter.succeed(ip);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
  };

  control.on('log', (e) => broadcast('log', { ...e, line: redactor.redact(e.line) }));
  control.on('event', (e) => broadcast('event', e));
  control.on('stats', (e) => broadcast('stats', e));
  watch.on('alert', (a) => broadcast('alert', a));
  updater.on('line', (line) => broadcast('update', { line }));
  updater.on('state', (s) => broadcast('update-state', s));

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', () => {}); // the channel is server -> client only
    ws.send(JSON.stringify({ type: 'hello', data: { version: VERSION } }));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    wss.close();
  });

  return { server, wss, broadcast };
}

module.exports = { createServer, VERSION };
