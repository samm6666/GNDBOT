'use strict';

// Creates control/agent/.env with a fresh CONTROL_API_KEY (or replaces it with --force).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseEnv } = require('./config');
const envfile = require('./envfile');

const file = path.resolve(__dirname, '..', '.env');
const force = process.argv.includes('--force');
const current = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};

if (current.CONTROL_API_KEY && current.CONTROL_API_KEY.length >= 32 && !force) {
  console.log('CONTROL_API_KEY already exists in control/agent/.env (use --force to replace it).');
  console.log(`Key: ${current.CONTROL_API_KEY}`);
  process.exit(0);
}

const key = crypto.randomBytes(32).toString('base64url');
envfile.setKey(file, 'CONTROL_API_KEY', key);
console.log('New API key saved to control/agent/.env');
console.log('Paste it into the GND Control app:');
console.log('');
console.log(`  ${key}`);
console.log('');
