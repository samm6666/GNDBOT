'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const pm2 = require('pm2');

const LOG_BUFFER = 500;

function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn.call(pm2, ...args, (err, res) => (err ? reject(err instanceof Error ? err : new Error(String(err.message || err))) : resolve(res)));
  });
}

// Read the last `lines` lines of a file without loading all of it.
function tailFile(file, lines, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (len < size) all.shift(); // first line is probably cut
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

class Pm2Control extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.byPm2Name = new Map(config.bots.map((b) => [b.pm2, b]));
    this.byId = new Map(config.bots.map((b) => [b.id, b]));
    this.logs = new Map(config.bots.map((b) => [b.id, []]));
    this.stats = new Map();
    this.pending = new Map();
    this.connected = false;
  }

  bot(id) {
    return this.byId.get(id) || null;
  }

  async connect() {
    await call(pm2.connect);
    this.connected = true;
    const bus = await call(pm2.launchBus);
    this.bus = bus;
    bus.on('log:out', (p) => this._onLog(p, 'out'));
    bus.on('log:err', (p) => this._onLog(p, 'err'));
    bus.on('process:event', (p) => this._onEvent(p));
    bus.on('process:msg', (p) => this._onMsg(p));
  }

  disconnect() {
    if (this.bus && typeof this.bus.close === 'function') this.bus.close();
    if (this.connected) pm2.disconnect();
    this.connected = false;
  }

  _onLog(packet, stream) {
    const bot = packet.process && this.byPm2Name.get(packet.process.name);
    if (!bot) return;
    const at = packet.at || Date.now();
    const lines = String(packet.data || '').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const buf = this.logs.get(bot.id);
    for (const line of lines) {
      const entry = { bot: bot.id, stream, at, line };
      buf.push(entry);
      this.emit('log', entry);
    }
    if (buf.length > LOG_BUFFER) buf.splice(0, buf.length - LOG_BUFFER);
  }

  _onEvent(packet) {
    const name = packet.process && packet.process.name;
    const bot = name && this.byPm2Name.get(name);
    if (!bot) return;
    if (packet.event === 'exit' || packet.event === 'stop') this.stats.delete(bot.id);
    this.emit('event', { bot: bot.id, event: packet.event, manually: !!packet.manually, at: packet.at || Date.now() });
  }

  _onMsg(packet) {
    const bot = packet.process && this.byPm2Name.get(packet.process.name);
    const data = packet.data;
    if (!bot || !data || typeof data !== 'object') return;
    if (data.kind === 'gnd:stats') {
      this.stats.set(bot.id, { ...data, receivedAt: Date.now() });
      this.emit('stats', { bot: bot.id, stats: this.stats.get(bot.id) });
    } else if (data.kind === 'gnd:reply' && data.reqId && this.pending.has(data.reqId)) {
      const { resolve, timer } = this.pending.get(data.reqId);
      clearTimeout(timer);
      this.pending.delete(data.reqId);
      resolve({ ok: !!data.ok, result: data.result, error: data.error });
    }
  }

  async list() {
    return call(pm2.list);
  }

  async find(bot) {
    const all = await this.list();
    return all.find((p) => p.name === bot.pm2) || null;
  }

  // Only whitelisted fields: pm2_env also carries every env var of the process.
  static describe(bot, proc, stats) {
    const base = { id: bot.id, label: bot.label, kind: bot.kind, pm2: bot.pm2 };
    if (!proc) return { ...base, status: 'missing' };
    const env = proc.pm2_env || {};
    const online = env.status === 'online';
    return {
      ...base,
      status: env.status,
      pmId: proc.pm_id,
      pid: proc.pid || null,
      uptime: online && env.pm_uptime ? Date.now() - env.pm_uptime : 0,
      restarts: env.restart_time || 0,
      unstableRestarts: env.unstable_restarts || 0,
      memory: proc.monit ? proc.monit.memory : 0,
      cpu: proc.monit ? proc.monit.cpu : 0,
      version: env.version || null,
      node: env.node_version || null,
      execMode: env.exec_mode || null,
      stats: online && stats ? stats : null,
    };
  }

  async overview() {
    const all = await this.list();
    return this.config.bots.map((bot) => {
      const proc = all.find((p) => p.name === bot.pm2) || null;
      return Pm2Control.describe(bot, proc, this.stats.get(bot.id));
    });
  }

  async action(bot, action) {
    const proc = await this.find(bot);
    switch (action) {
      case 'restart':
      case 'start':
        if (proc) return call(pm2.restart, bot.pm2);
        if (!fs.existsSync(this.config.ecosystem)) {
          throw new Error(`"${bot.pm2}" is not in pm2 and ${this.config.ecosystem} was not found`);
        }
        return call(pm2.start, this.config.ecosystem, { only: bot.pm2 });
      case 'stop':
        if (!proc) throw new Error(`"${bot.pm2}" is not running under pm2`);
        return call(pm2.stop, bot.pm2);
      default:
        throw new Error(`unknown action "${action}"`);
    }
  }

  async history(bot, lines = 200, stream = 'all') {
    const proc = await this.find(bot);
    let entries = [];
    if (proc) {
      const env = proc.pm2_env || {};
      const read = (file, s) => tailFile(file, lines).map((line) => ({ bot: bot.id, stream: s, at: null, line }));
      if (stream !== 'err' && env.pm_out_log_path) entries = entries.concat(read(env.pm_out_log_path, 'out'));
      if (stream !== 'out' && env.pm_err_log_path) entries = entries.concat(read(env.pm_err_log_path, 'err'));
    }
    if (!entries.length) {
      entries = this.logs.get(bot.id).filter((e) => stream === 'all' || e.stream === stream);
    }
    return entries.slice(-lines);
  }

  // Sends a command to a bot through pm2 IPC and waits for its reply (see control/bot-link).
  async command(bot, action, payload = {}, timeoutMs = 15_000) {
    const proc = await this.find(bot);
    if (!proc || proc.pm2_env.status !== 'online') throw new Error(`${bot.label} is not online`);
    const reqId = crypto.randomUUID();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`${bot.label} did not answer (is control/bot-link enabled in this bot?)`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
    });
    try {
      await call(pm2.sendDataToProcessId, proc.pm_id, {
        type: 'process:msg',
        topic: 'gnd:cmd',
        data: { reqId, action, payload },
      });
    } catch (err) {
      const p = this.pending.get(reqId);
      if (p) clearTimeout(p.timer);
      this.pending.delete(reqId);
      throw err;
    }
    return reply;
  }
}

module.exports = { Pm2Control, tailFile };
