'use strict';

const envfile = require('./envfile');

const MAX_BODY = 60_000; // GitHub issue bodies are capped at 65536 characters

function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function fence(lines) {
  const body = lines.join('\n').replace(/```/g, "'''");
  return '```text\n' + (body || '(empty)') + '\n```';
}

// Builds a Markdown report that Claude (or a person) can read to debug the bots.
// Everything goes through the redactor; .env values are never included.
async function build({ config, control, redactor, system, reason = 'manual', focus = null, errorLines = 200, outLines = 60 }) {
  const bots = await control.overview();
  const sys = await system();
  const now = new Date();
  const out = [];

  out.push(`# GND bot report`);
  out.push('');
  out.push(`- **Time:** ${now.toISOString()}`);
  out.push(`- **Reason:** ${reason}`);
  if (focus) out.push(`- **Focus:** ${focus}`);
  out.push(`- **Host:** ${sys.hostname} (${sys.platform}), Node ${sys.node}`);
  out.push(`- **Server:** CPU ${sys.cpu}% (${sys.cpus} cores, load ${sys.load.join(' / ')}), RAM ${fmtBytes(sys.memory.used)} / ${fmtBytes(sys.memory.total)}` +
    (sys.disk ? `, disk ${fmtBytes(sys.disk.used)} / ${fmtBytes(sys.disk.total)}` : ''));
  if (sys.lavalink) {
    out.push(`- **Lavalink HTTP:** ${sys.lavalink.reachable ? `reachable, v${sys.lavalink.version}, ${sys.lavalink.latency}ms` : `unreachable (${sys.lavalink.error || sys.lavalink.status})`}`);
  }
  out.push('');

  out.push('## Status');
  out.push('');
  out.push('| Bot | pm2 name | Status | Uptime | Restarts | Memory | CPU | Guilds | Ping |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const b of bots) {
    const s = b.stats || {};
    out.push(`| ${b.id} | ${b.pm2} | ${b.status} | ${fmtDuration(b.uptime)} | ${b.restarts ?? '-'} (unstable ${b.unstableRestarts ?? 0}) | ${fmtBytes(b.memory)} | ${b.cpu ?? '-'}% | ${s.guilds ?? '-'} | ${s.ping ?? '-'}ms |`);
  }
  out.push('');

  const ordered = focus ? [...bots].sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0)) : bots;
  for (const b of ordered) {
    const bot = control.bot(b.id);
    out.push(`## ${b.id}`);
    out.push('');
    if (b.stats) {
      const { kind, receivedAt, ...stats } = b.stats;
      out.push('**Bot stats:** `' + redactor.redact(JSON.stringify(stats)) + '`');
      out.push('');
    }
    if (bot.env) {
      try {
        const info = envfile.describe(envfile.resolveEnvPath(config, bot));
        const keys = info.keys.map((k) => `${k.key}${k.set ? '' : ' (empty)'}`);
        out.push(`**.env keys (${bot.env}):** ${info.exists ? keys.join(', ') || '(none)' : 'file missing'}`);
        out.push('');
      } catch (err) {
        out.push(`**.env:** ${err.message}`);
        out.push('');
      }
    }
    const errs = await control.history(bot, errorLines, 'err');
    out.push(`### Last ${errs.length} error lines`);
    out.push(fence(errs.map((e) => redactor.redact(e.line))));
    const outs = await control.history(bot, outLines, 'out');
    out.push(`### Last ${outs.length} output lines`);
    out.push(fence(outs.map((e) => redactor.redact(e.line))));
    out.push('');
  }

  let text = redactor.redact(out.join('\n'));
  if (text.length > MAX_BODY) {
    text = text.slice(0, MAX_BODY - 200) + '\n```\n\n_(report truncated)_\n';
  }
  return text;
}

module.exports = { build, fmtBytes, fmtDuration };
