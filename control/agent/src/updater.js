'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Pulls the latest code from GitHub, installs changed dependencies and restarts the bots.
class Updater extends EventEmitter {
  constructor(config, control, redactor) {
    super();
    this.config = config;
    this.control = control;
    this.redactor = redactor;
    this.running = false;
    this.last = null;
  }

  run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
      this.emit('line', `$ ${cmd} ${args.join(' ')}${cwd !== this.config.projectRoot ? `   (${path.relative(this.config.projectRoot, cwd)})` : ''}`);
      const child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      let output = '';
      const onData = (d) => {
        const text = d.toString();
        output += text;
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.emit('line', this.redactor.redact(line));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`${cmd} exited with code ${code}`))));
    });
  }

  async start() {
    if (this.running) throw new Error('an update is already running');
    this.running = true;
    this.emit('state', { running: true });
    const root = this.config.projectRoot;
    const result = { ok: false, changed: [], startedAt: Date.now() };
    try {
      if (!fs.existsSync(path.join(root, '.git'))) throw new Error(`${root} is not a git checkout`);
      const before = (await this.run('git', ['rev-parse', 'HEAD'], root)).trim();
      const pullArgs = ['pull', '--ff-only'];
      if (this.config.update.branch) pullArgs.push('origin', this.config.update.branch);
      await this.run('git', pullArgs, root);
      const after = (await this.run('git', ['rev-parse', 'HEAD'], root)).trim();
      result.from = before;
      result.to = after;

      if (before === after) {
        this.emit('line', 'Already up to date. Nothing to restart.');
        result.ok = true;
        return result;
      }

      const changed = (await this.run('git', ['diff', '--name-only', before, after], root)).split('\n').filter(Boolean);
      result.changed = changed;

      for (const dir of this.config.update.packages) {
        const prefix = dir === '.' ? '' : `${dir.replace(/\/+$/, '')}/`;
        const pkgChanged = changed.some((f) => f === `${prefix}package.json` || f === `${prefix}package-lock.json`);
        if (!pkgChanged) continue;
        const cwd = path.resolve(root, dir);
        await this.run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], cwd);
      }

      const agentChanged = changed.some((f) => f.startsWith('control/agent/'));
      if (agentChanged && changed.includes('control/agent/package.json')) {
        await this.run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], this.config.agentDir);
      }

      for (const bot of this.config.bots.filter((b) => b.kind === 'bot')) {
        this.emit('line', `Restarting ${bot.label} (${bot.pm2})...`);
        try {
          await this.control.action(bot, 'restart');
        } catch (err) {
          this.emit('line', `  failed: ${err.message}`);
        }
      }
      result.ok = true;
      result.restartAgent = agentChanged;
      if (agentChanged) this.emit('line', 'Agent files changed: the agent restarts itself in a few seconds.');
      return result;
    } catch (err) {
      result.error = this.redactor.redact(err.message);
      this.emit('line', `Update failed: ${result.error}`);
      return result;
    } finally {
      result.finishedAt = Date.now();
      this.last = result;
      this.running = false;
      this.emit('state', { running: false, result });
    }
  }
}

module.exports = { Updater };
