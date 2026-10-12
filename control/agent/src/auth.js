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

function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (trustProxy && isLocal && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
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

module.exports = { keyMatches, bearer, clientIp, Limiter };
