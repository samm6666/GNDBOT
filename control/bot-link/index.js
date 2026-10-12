'use strict';

// GND bot link: connects a discord.js bot to the GND Control agent through pm2 IPC.
//
//   const gndLink = require('../control/bot-link');   // path from the bot's file
//   gndLink.attach(client, { extra: () => ({ players: manager.players.size }) });
//
// It sends stats every 30 seconds and answers commands from the desktop app
// (presence, username, avatar, ...). Outside pm2 it does nothing.

const fs = require('fs');
const path = require('path');

const ACTIVITY_TYPES = { playing: 0, streaming: 1, listening: 2, watching: 3, custom: 4, competing: 5 };
const STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
const STATE_DIR = path.join(__dirname, '.state');

function send(data) {
  if (typeof process.send === 'function' && process.connected) {
    try {
      process.send({ type: 'process:msg', data });
    } catch {
      // the IPC channel can close during shutdown
    }
  }
}

function djsVersion() {
  try {
    return require(require.resolve('discord.js/package.json', { paths: [process.cwd()] })).version;
  } catch {
    return null;
  }
}

function activityFrom(input) {
  if (!input || !input.name) return [];
  const type = typeof input.type === 'number' ? input.type : ACTIVITY_TYPES[String(input.type || 'playing').toLowerCase()] ?? 0;
  const name = String(input.name).slice(0, 128);
  if (type === 4) return [{ type, name, state: name }];
  const activity = { type, name };
  if (type === 1 && input.url) activity.url = String(input.url);
  return [activity];
}

function attach(client, options = {}) {
  const enabled = typeof process.send === 'function';
  const key = String(options.name || process.env.name || 'bot').replace(/[^\w-]/g, '_');
  const stateFile = path.join(STATE_DIR, `${key}.json`);
  const commands = { ...(options.commands || {}) };
  const interval = options.interval || 30_000;
  const djs = djsVersion();

  const loadState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const saveState = (patch) => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...loadState(), ...patch }, null, 2));
    } catch {
      // state is a convenience only
    }
  };

  const stats = () => {
    const ready = typeof client.isReady === 'function' ? client.isReady() : Boolean(client.readyAt);
    const guilds = client.guilds && client.guilds.cache;
    let users = 0;
    if (guilds) for (const g of guilds.values()) users += g.memberCount || 0;
    let extra = {};
    if (typeof options.extra === 'function') {
      try {
        extra = options.extra() || {};
      } catch (err) {
        extra = { extraError: err.message };
      }
    }
    const mem = process.memoryUsage();
    return {
      kind: 'gnd:stats',
      ready,
      user: client.user ? { id: client.user.id, username: client.user.username, avatar: client.user.displayAvatarURL ? client.user.displayAvatarURL({ size: 128 }) : null } : null,
      guilds: guilds ? guilds.size : 0,
      users,
      ping: client.ws ? Math.round(client.ws.ping) : null,
      uptime: client.uptime || 0,
      presence: client.user && client.user.presence ? {
        status: client.user.presence.status,
        activity: client.user.presence.activities && client.user.presence.activities[0] ? client.user.presence.activities[0].state || client.user.presence.activities[0].name : null,
      } : null,
      memory: { rss: mem.rss, heap: mem.heapUsed },
      discordjs: djs,
      node: process.version,
      ...extra,
    };
  };

  const applyPresence = (p) => {
    const status = STATUSES.has(p.status) ? p.status : 'online';
    client.user.setPresence({ status, activities: activityFrom(p.activity) });
    return { status, activity: p.activity || null };
  };

  const builtins = {
    ping: async () => ({ ws: client.ws ? Math.round(client.ws.ping) : null }),
    stats: async () => stats(),
    setPresence: async (p) => {
      if (!client.user) throw new Error('bot is not ready yet');
      const applied = applyPresence(p || {});
      if (options.persistPresence !== false) saveState({ presence: p.clear ? null : applied });
      return applied;
    },
    setUsername: async (p) => {
      if (!client.user) throw new Error('bot is not ready yet');
      const name = String((p && p.username) || '').trim();
      if (name.length < 2 || name.length > 32) throw new Error('username must be 2-32 characters');
      await client.user.setUsername(name);
      return { username: client.user.username };
    },
    setAvatar: async (p) => {
      if (!client.user) throw new Error('bot is not ready yet');
      let image = p && (p.dataUrl || p.url);
      if (!image) throw new Error('send dataUrl or url');
      if (p.dataUrl) {
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(p.dataUrl);
        if (!m) throw new Error('avatar must be a png, jpg, gif or webp image');
        image = Buffer.from(m[2], 'base64');
        if (image.length > 10 * 1024 * 1024) throw new Error('avatar must be under 10 MB');
      }
      await client.user.setAvatar(image);
      return { avatar: client.user.displayAvatarURL({ size: 128 }) };
    },
  };

  if (!enabled) return { stats, enabled: false };

  const onMessage = async (packet) => {
    if (!packet || packet.topic !== 'gnd:cmd' || !packet.data) return;
    const { reqId, action, payload } = packet.data;
    const handler = commands[action] || builtins[action];
    try {
      if (!handler) throw new Error(`this bot does not support "${action}"`);
      const result = await handler(payload || {}, client);
      send({ kind: 'gnd:reply', reqId, ok: true, result: result === undefined ? null : result });
    } catch (err) {
      send({ kind: 'gnd:reply', reqId, ok: false, error: err && err.message ? err.message : String(err) });
    }
    if (action !== 'ping' && action !== 'stats') send(stats());
  };
  process.on('message', onMessage);

  const onReady = () => {
    const saved = loadState().presence;
    if (saved && options.persistPresence !== false) {
      try {
        applyPresence(saved);
      } catch {
        // ignore
      }
    }
    send(stats());
  };
  if (client.readyAt) {
    onReady();
  } else {
    // discord.js v14 emits "ready", v14.22+ and v15 emit "clientReady"
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      onReady();
    };
    client.once('clientReady', once);
    client.once('ready', once);
  }

  const timer = setInterval(() => send(stats()), interval);
  if (timer.unref) timer.unref();

  return {
    enabled: true,
    stats,
    detach() {
      clearInterval(timer);
      process.removeListener('message', onMessage);
    },
  };
}

module.exports = { attach, activityFrom };
