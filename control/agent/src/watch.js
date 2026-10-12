'use strict';

const { EventEmitter } = require('events');

// Watches pm2 events and raises an alert when a bot keeps crashing.
class CrashWatch extends EventEmitter {
  constructor({ crashes, windowMs, cooldownMs, now = Date.now }) {
    super();
    this.limit = crashes;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.exits = new Map();
    this.lastAlert = new Map();
  }

  onEvent({ bot, event, manually }) {
    if (event === 'restart overlimit') return this._alert(bot, 'pm2 gave up restarting it (restart overlimit)');
    if (event !== 'exit' || manually) return null;
    const t = this.now();
    const list = (this.exits.get(bot) || []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.exits.set(bot, list);
    this.emit('crash', { bot, count: list.length, at: t });
    if (list.length >= this.limit) {
      return this._alert(bot, `crashed ${list.length} times in ${Math.round(this.windowMs / 60_000)} minutes`);
    }
    return null;
  }

  _alert(bot, reason) {
    const t = this.now();
    const last = this.lastAlert.get(bot);
    if (last !== undefined && t - last < this.cooldownMs) return null;
    this.lastAlert.set(bot, t);
    const alert = { bot, reason, at: t };
    this.emit('alert', alert);
    return alert;
  }
}

module.exports = { CrashWatch };
