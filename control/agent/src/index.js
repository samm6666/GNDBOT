'use strict';

const configLib = require('./config');
const envfile = require('./envfile');
const { Redactor } = require('./redact');
const { Pm2Control } = require('./pm2');
const { Settings } = require('./settings');
const { GitHubReporter } = require('./github');
const { CrashWatch } = require('./watch');
const { Updater } = require('./updater');
const { createServer } = require('./server');
const report = require('./report');
const system = require('./system');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Every secret value from the bots' .env files and pm2 env is removed from logs and reports.
async function loadSecrets(config, redactor, control) {
  redactor.addSecrets([config.apiKey, config.github.token, config.lavalink.password]);
  for (const bot of config.bots) {
    try {
      const file = envfile.resolveEnvPath(config, bot);
      if (file) redactor.addEnv(envfile.read(file));
    } catch {
      // ignore bad paths here; the API reports them
    }
  }
  if (!control) return;
  try {
    const names = new Set(config.bots.map((b) => b.pm2));
    for (const proc of await control.list()) {
      if (!names.has(proc.name) || !proc.pm2_env) continue;
      redactor.addEnv(proc.pm2_env.env || {});
      redactor.addEnv(proc.pm2_env);
    }
  } catch {
    // pm2 unavailable for a moment; the next pass picks it up
  }
}

async function main() {
  const config = configLib.load();
  const problems = configLib.validate(config);
  if (problems.length) {
    for (const p of problems) console.error(`[gnd-control] ${p}`);
    process.exit(1);
  }

  const redactor = new Redactor();
  await loadSecrets(config, redactor);

  const control = new Pm2Control(config);
  await control.connect();
  await loadSecrets(config, redactor, control);
  setInterval(() => loadSecrets(config, redactor, control), 5 * 60_000).unref();

  const settings = new Settings(config.dataDir, { autoReport: config.autoReport.enabled });
  const github = new GitHubReporter(config.github);
  const watch = new CrashWatch(config.autoReport);
  const updater = new Updater(config, control, redactor);

  control.on('event', (e) => {
    watch.onEvent(e);
    if (e.event === 'online') loadSecrets(config, redactor, control); // pick up env of newly started bots
  });

  watch.on('alert', async (alert) => {
    log(`[alert] ${alert.bot}: ${alert.reason}`);
    if (!settings.get().autoReport || !github.enabled) return;
    try {
      const markdown = await report.build({
        config,
        control,
        redactor,
        system: () => system.snapshot(config),
        reason: `automatic: ${alert.bot} ${alert.reason}`,
        focus: alert.bot,
      });
      const res = await github.report({ title: `[GND auto-report] ${alert.bot} keeps crashing`, body: markdown, dedupe: true });
      log(`[alert] report filed: ${res.url}`);
    } catch (err) {
      log(`[alert] could not file report: ${redactor.redact(err.message)}`);
    }
  });

  const { server } = createServer({
    config,
    control,
    redactor,
    settings,
    github,
    updater,
    watch,
    system: system.snapshot,
  });

  server.listen(config.port, config.host, () => {
    log(`[gnd-control] listening on http://${config.host}:${config.port} for ${config.bots.map((b) => b.pm2).join(', ')}`);
  });

  const shutdown = () => {
    server.close();
    control.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[gnd-control] failed to start:', err);
  process.exit(1);
});
