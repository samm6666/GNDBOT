'use strict';

// Removes secrets from any text that leaves the agent (logs, reports, errors).

const PATTERNS = [
  // Discord bot tokens: base64 user id . timestamp . hmac
  /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g,
  /\bmfa\.[A-Za-z\d_-]{84}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z\d]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z\d_]{22,255}\b/g,
  // Discord webhook URLs
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z\d_-]+/g,
  // Common API key shapes
  /\bsk-[A-Za-z\d_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Credentials inside URLs: scheme://user:pass@host
  /(?<=:\/\/[^/\s:@]+:)[^@\s/]+(?=@)/g,
  // Authorization headers
  /(?<=\b(?:Bearer|Bot|Basic)\s)[A-Za-z\d._~+/=-]{16,}/g,
];

const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASS|KEY|PRIVATE|CREDENTIAL|WEBHOOK|COOKIE|SESSION|AUTH)/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class Redactor {
  constructor() {
    this.literals = new Set();
    this.literalRegex = null;
  }

  // Register exact secret values (from .env files) so they are removed even
  // when they do not match a known pattern.
  addSecrets(values) {
    for (const v of values) {
      if (typeof v === 'string' && v.length >= 6) this.literals.add(v);
    }
    this.literalRegex = this.literals.size
      ? new RegExp([...this.literals].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g')
      : null;
  }

  addEnv(envObject) {
    const values = [];
    for (const [k, v] of Object.entries(envObject || {})) {
      if (SECRET_KEY.test(k)) values.push(v);
    }
    this.addSecrets(values);
  }

  redact(text) {
    if (text === null || text === undefined) return text;
    let out = String(text);
    if (this.literalRegex) out = out.replace(this.literalRegex, '[REDACTED]');
    for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
    return out;
  }
}

module.exports = { Redactor, SECRET_KEY };
