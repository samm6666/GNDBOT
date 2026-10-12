'use strict';

const fs = require('fs');
const path = require('path');

const AGENT_DIR = path.resolve(__dirname, '..');

// Minimal .env parser: KEY=value, optional quotes, # comments.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// The three bots plus Lavalink. `pm2` is the pm2 app name, `dir` and `env`
// are relative to the project root. Override any of it with control/agent/bots.json.
const DEFAULT_BOTS = [
  { id: 'music', label: 'الموسيقى', pm2: 'gnd-music', dir: '.', env: '.env', kind: 'bot' },
  { id: 'games', label: 'الألعاب', pm2: 'gnd-games', dir: 'games', env: 'games/.env', kind: 'bot' },
  { id: 'system', label: 'السيستم', pm2: 'gnd-system', dir: 'system', env: 'system/.env', kind: 'bot' },
  { id: 'lavalink', label: 'Lavalink', pm2: 'lavalink', dir: 'lavalink', env: null, kind: 'service' },
];

function loadBots(file) {
  if (!fs.existsSync(file)) return DEFAULT_BOTS.map((b) => ({ ...b }));
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file} must contain a JSON array`);
  return list.map((b) => {
    if (!b.id || !/^[a-z0-9_-]+$/i.test(b.id)) throw new Error(`bots.json: invalid id "${b.id}"`);
    if (!b.pm2) throw new Error(`bots.json: "${b.id}" needs a pm2 app name`);
    return { label: b.id, dir: '.', env: null, kind: 'bot', ...b };
  });
}

function load(overrides = {}) {
  const fileEnv = loadEnvFile(overrides.envFile || path.join(AGENT_DIR, '.env'));
  const env = { ...fileEnv, ...process.env, ...(overrides.env || {}) };

  const projectRoot = path.resolve(env.PROJECT_ROOT || path.join(AGENT_DIR, '..', '..'));
  const dataDir = path.resolve(env.CONTROL_DATA_DIR || path.join(AGENT_DIR, 'data'));

  const config = {
    agentDir: AGENT_DIR,
    projectRoot,
    dataDir,
    host: env.CONTROL_HOST || '127.0.0.1',
    port: int(env.CONTROL_PORT, 7420),
    apiKey: env.CONTROL_API_KEY || '',
    // Trust X-Forwarded-For only when the agent sits behind a local reverse proxy (Caddy).
    trustProxy: bool(env.CONTROL_TRUST_PROXY, true),
    ecosystem: path.resolve(projectRoot, env.ECOSYSTEM_FILE || 'deploy/ecosystem.config.js'),
    bots: loadBots(overrides.botsFile || env.BOTS_FILE || path.join(AGENT_DIR, 'bots.json')),
    lavalink: {
      url: env.LAVALINK_URL || '',
      password: env.LAVALINK_PASSWORD || '',
    },
    github: {
      token: env.GITHUB_TOKEN || '',
      repo: env.GITHUB_REPO || 'samm6666/GNDBOT-v2',
      api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
      label: env.GITHUB_REPORT_LABEL || 'claude-report',
    },
    autoReport: {
      enabled: bool(env.AUTO_REPORT, true),
      crashes: int(env.AUTO_REPORT_CRASHES, 3),
      windowMs: int(env.AUTO_REPORT_WINDOW_MIN, 10) * 60_000,
      cooldownMs: int(env.AUTO_REPORT_COOLDOWN_MIN, 60) * 60_000,
    },
    update: {
      branch: env.UPDATE_BRANCH || '',
      packages: (env.UPDATE_PACKAGES || '.,games,system').split(',').map((s) => s.trim()).filter(Boolean),
    },
  };

  return config;
}

function validate(config) {
  const problems = [];
  if (!config.apiKey || config.apiKey.length < 32) {
    problems.push('CONTROL_API_KEY is missing or shorter than 32 characters. Run "npm run keygen" in control/agent.');
  }
  const ids = new Set();
  for (const b of config.bots) {
    if (ids.has(b.id)) problems.push(`duplicate bot id "${b.id}"`);
    ids.add(b.id);
  }
  return problems;
}

module.exports = { load, validate, parseEnv, DEFAULT_BOTS };
