'use strict';

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('./config');
const { SECRET_KEY } = require('./redact');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function resolveEnvPath(config, bot) {
  if (!bot.env) return null;
  const file = path.resolve(config.projectRoot, bot.env);
  // Never follow a bots.json entry outside the project.
  if (!file.startsWith(config.projectRoot + path.sep) && file !== config.projectRoot) {
    throw new Error(`env path for ${bot.id} is outside the project`);
  }
  return file;
}

function read(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Values are never sent back: only whether the key is set and how long it is.
function describe(file) {
  const exists = fs.existsSync(file);
  const env = exists ? read(file) : {};
  return {
    exists,
    keys: Object.entries(env).map(([key, value]) => ({
      key,
      set: value !== '',
      length: value.length,
      secret: SECRET_KEY.test(key),
    })),
  };
}

// Single quotes are literal in dotenv; fall back to double quotes when the value has one.
function quote(value) {
  if (!/[\s#"'=`]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error('value cannot contain both single and double quotes');
}

// Sets or removes (value === null) one key and keeps every other line as is.
function setKey(file, key, value) {
  if (!KEY_RE.test(key)) throw new Error('invalid key name');
  if (value !== null && (typeof value !== 'string' || /[\r\n\0]/.test(value))) {
    throw new Error('value must be a single line of text');
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let found = false;
  const out = [];
  for (const line of lines) {
    if (re.test(line)) {
      if (!found && value !== null) out.push(`${key}=${quote(value)}`);
      found = true;
    } else {
      out.push(line);
    }
  }
  if (!found && value !== null) out.push(`${key}=${quote(value)}`);

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join(eol) + eol, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return found ? (value === null ? 'removed' : 'updated') : value === null ? 'absent' : 'added';
}

module.exports = { resolveEnvPath, read, describe, setKey };
