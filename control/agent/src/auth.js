'use strict';

const crypto = require('crypto');

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// Compare hashes so the comparison is constant-time regardless of input length.
function keyMatches(given, expected) {
  if (!given || !expected) return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

// Loopback and private (Docker/LAN) addresses: where a reverse proxy such as Caddy or
// Coolify's Traefik connects from. Public addresses never get to set X-Forwarded-For.
function isPrivate(addr) {
  const ip = addr.replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || '';
  if (trustProxy && isPrivate(remote) && req.headers['x-forwarded-for']) {
    // The proxy appends the real client last; anything before it can be forged by the client.
    const hops = String(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    return hops[hops.length - 1] || remote;
  }
  return remote;
}

// Fixed-window limiter per IP for all requests, plus a lockout after repeated bad keys.
class Limiter {
  constructor({ perMinute = 240, maxFailures = 10, failureWindowMs = 10 * 60_000, lockMs = 15 * 60_000, now = Date.now } = {}) {
    this.perMinute = perMinute;
    this.maxFailures = maxFailures;
    this.failureWindowMs = failureWindowMs;
    this.lockMs = lockMs;
    this.now = now;
    this.hits = new Map();
    this.failures = new Map();
  }

  // Returns seconds to wait, or 0 if allowed.
  check(ip) {
    const t = this.now();
    const f = this.failures.get(ip);
    if (f && f.lockedUntil > t) return Math.ceil((f.lockedUntil - t) / 1000);

    const h = this.hits.get(ip);
    if (!h || t - h.start >= 60_000) {
      this.hits.set(ip, { start: t, count: 1 });
      return 0;
    }
    h.count += 1;
    return h.count > this.perMinute ? Math.ceil((h.start + 60_000 - t) / 1000) : 0;
  }

  fail(ip) {
    const t = this.now();
    let f = this.failures.get(ip);
    if (!f || t - f.start >= this.failureWindowMs) {
      f = { start: t, count: 0, lockedUntil: 0 };
      this.failures.set(ip, f);
    }
    f.count += 1;
    if (f.count >= this.maxFailures) f.lockedUntil = t + this.lockMs;
  }

  succeed(ip) {
    this.failures.delete(ip);
  }

  sweep() {
    const t = this.now();
    for (const [ip, h] of this.hits) if (t - h.start >= 60_000) this.hits.delete(ip);
    for (const [ip, f] of this.failures) {
      if (f.lockedUntil <= t && t - f.start >= this.failureWindowMs) this.failures.delete(ip);
    }
  }
}

module.exports = { keyMatches, bearer, clientIp, isPrivate, Limiter };
