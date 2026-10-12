'use strict';

const os = require('os');
const fs = require('fs');

let lastCpu = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

// CPU usage since the previous call (first call falls back to load average).
function cpuPercent() {
  const now = cpuTimes();
  let pct;
  if (lastCpu && now.total > lastCpu.total) {
    pct = 100 * (1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total));
  } else {
    pct = Math.min(100, (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100);
  }
  lastCpu = now;
  return Math.round(pct * 10) / 10;
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

async function lavalinkInfo(cfg) {
  if (!cfg.url) return null;
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/version`, {
      headers: cfg.password ? { Authorization: cfg.password } : {},
      signal: AbortSignal.timeout(4000),
    });
    return { reachable: res.ok, status: res.status, version: res.ok ? (await res.text()).trim().slice(0, 40) : null, latency: Date.now() - started };
  } catch (err) {
    return { reachable: false, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

async function snapshot(config) {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    uptime: Math.round(os.uptime()),
    cpus: os.cpus().length,
    cpu: cpuPercent(),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
    disk: disk(config.projectRoot),
    lavalink: await lavalinkInfo(config.lavalink),
  };
}

module.exports = { snapshot, cpuPercent };
