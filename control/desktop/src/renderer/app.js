'use strict';

/* global gnd */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// Small DOM builder. Text always goes through textContent, never innerHTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by the CSP, style attributes are not
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const BOT_AR = { music: 'بوت الموسيقى', games: 'بوت الألعاب', system: 'بوت السيستم', lavalink: 'Lavalink' };
const STATUS_AR = {
  online: 'شغال',
  stopped: 'طافي',
  stopping: 'يطفي...',
  launching: 'يشتغل...',
  errored: 'فيه خطأ',
  missing: 'مو مضاف في pm2',
  'one-launch-status': 'يشتغل...',
};
const PRESENCE_AR = { online: 'متصل', idle: 'خامل', dnd: 'مشغول', invisible: 'مخفي' };
const FALLBACK_AVATAR = '../../build/icon.png';
const MAX_LOG_LINES = 3000;

const state = {
  bots: [],
  system: null,
  agent: null,
  settings: {},
  github: {},
  update: {},
  live: 'off',
  logs: [],
  logsBot: 'all',
  logsPaused: false,
  settingsBot: null,
  report: '',
  configured: false,
};

// ---------- helpers ----------

function fmtBytes(n) {
  if (n === null || n === undefined) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function fmtNum(n) {
  return n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US');
}

function fmtTime(at) {
  if (!at) return ''; // lines read back from pm2 log files carry no time
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB');
}

function botName(b) {
  return BOT_AR[b.id] || b.label || b.id;
}

function avatarOf(b) {
  const url = b.stats && b.stats.user && b.stats.user.avatar;
  return typeof url === 'string' && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(url) ? url : FALLBACK_AVATAR;
}

function toast(text, kind = '') {
  const t = h('div', { class: `toast ${kind}`, text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}

async function api(method, path, body) {
  try {
    return await gnd.api(method, path, body);
  } catch (err) {
    toast(err.message, 'bad');
    throw err;
  }
}

// Disables the button while the action runs.
async function busy(btn, fn) {
  if (btn.disabled) return undefined;
  btn.disabled = true;
  try {
    return await fn();
  } catch {
    return undefined;
  } finally {
    btn.disabled = false;
  }
}

// ---------- navigation ----------

function go(page) {
  for (const b of $$('.nav-item')) b.classList.toggle('active', b.dataset.page === page);
  for (const p of $$('.page')) p.classList.toggle('active', p.id === `page-${page}`);
  if (page === 'logs') loadLogHistory();
  if (page === 'settings') selectSettingsBot(state.settingsBot);
  if (page === 'connection') renderConnection();
}

for (const b of $$('.nav-item')) b.addEventListener('click', () => go(b.dataset.page));

// ---------- overview ----------

let refreshing = false;
async function refresh() {
  if (refreshing || !state.configured) return;
  refreshing = true;
  try {
    const o = await gnd.api('GET', '/api/overview');
    state.bots = o.bots;
    state.system = o.system;
    state.agent = o.agent;
    state.settings = o.settings;
    state.github = o.github;
    state.update = o.update;
    renderHome();
    renderServer();
    renderReportSide();
    renderBotTabs();
    $('#agent-version').textContent = `agent v${o.agent.version}`;
  } catch (err) {
    $('#summary').replaceChildren();
    $('#bot-cards').replaceChildren(h('div', { class: 'empty' }, `ما قدرت أجيب الحالة: ${err.message}`));
  } finally {
    refreshing = false;
  }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 700);
}

function renderHome() {
  const bots = state.bots.filter((b) => b.kind === 'bot');
  const online = bots.filter((b) => b.status === 'online').length;
  const guilds = bots.reduce((n, b) => n + ((b.stats && b.stats.guilds) || 0), 0);
  const users = bots.reduce((n, b) => n + ((b.stats && b.stats.users) || 0), 0);
  const sys = state.system || {};
  const tile = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  $('#summary').replaceChildren(
    tile('البوتات الشغالة', `${online} / ${bots.length}`),
    tile('السيرفرات', fmtNum(guilds)),
    tile('الأعضاء', fmtNum(users)),
    tile('السيرفر (CPU / RAM)', sys.memory ? `${sys.cpu}% / ${Math.round((sys.memory.used / sys.memory.total) * 100)}%` : '-'),
  );
  $('#bot-cards').replaceChildren(...state.bots.map(botCard));
}

function botCard(b) {
  const s = b.stats || {};
  const online = b.status === 'online';
  const kv = (k, v) => h('div', {}, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  const presence = s.presence
    ? `${PRESENCE_AR[s.presence.status] || s.presence.status}${s.presence.activity ? ` · ${s.presence.activity}` : ''}`
    : '';

  const action = (label, act, cls) => h('button', {
    class: `btn sm ${cls}`,
    onclick: (e) => busy(e.currentTarget, async () => {
      if (act === 'stop' && !confirm(`تبي توقف ${botName(b)}؟`)) return;
      await api('POST', `/api/bots/${b.id}/${act}`);
      toast(`${botName(b)}: تم`, 'ok');
      refreshSoon();
    }),
  }, label);

  const stats = b.kind === 'bot'
    ? [kv('التشغيل', fmtDuration(b.uptime)), kv('الرام', fmtBytes(b.memory)), kv('المعالج', b.cpu === undefined ? '-' : `${b.cpu}%`),
      kv('سيرفرات', fmtNum(s.guilds)), kv('الأعضاء', fmtNum(s.users)), kv('البنق', s.ping === undefined || s.ping === null ? '-' : `${s.ping}ms`)]
    : [kv('التشغيل', fmtDuration(b.uptime)), kv('الرام', fmtBytes(b.memory)), kv('المعالج', b.cpu === undefined ? '-' : `${b.cpu}%`)];

  return h('div', { class: `card ${b.status}` },
    h('div', { class: 'card-head' },
      h('img', { class: 'avatar', src: avatarOf(b), alt: '' }),
      h('div', { class: 'card-title' },
        h('div', { class: 'name', text: (s.user && s.user.username) || botName(b) }),
        h('div', { class: 'sub', text: `${botName(b)} · ${b.pm2}${b.restarts ? ` · ${b.restarts} ريستارت` : ''}` })),
      h('span', { class: `pill ${b.status}`, text: STATUS_AR[b.status] || b.status })),
    b.kind === 'bot' ? h('div', { class: 'presence', text: online ? presence : '' }) : null,
    h('div', { class: 'kv' }, stats),
    h('div', { class: 'card-actions' },
      online ? action('إيقاف', 'stop', 'danger') : action('تشغيل', 'start', 'ok'),
      action('ريستارت', 'restart', ''),
      h('button', { class: 'btn sm ghost', onclick: () => { state.logsBot = b.id; go('logs'); } }, 'السجلات')),
  );
}

$('#refresh').addEventListener('click', (e) => busy(e.currentTarget, refresh));
$('#restart-all').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (!confirm('ريستارت لكل البوتات؟')) return;
  const res = await api('POST', '/api/bots/all/restart');
  const failed = Object.entries(res.results).filter(([, v]) => v !== 'ok');
  toast(failed.length ? `فيه بوتات ما اشتغلت: ${failed.map(([k]) => BOT_AR[k] || k).join('، ')}` : 'تم ريستارت كل البوتات', failed.length ? 'bad' : 'ok');
  refreshSoon();
}));

// ---------- logs ----------

function renderLogTabs() {
  const tabs = [{ id: 'all', name: 'الكل' }, ...state.bots.map((b) => ({ id: b.id, name: botName(b) }))];
  $('#logs-bots').replaceChildren(...tabs.map((t) => h('button', {
    class: `tab ${state.logsBot === t.id ? 'active' : ''}`,
    onclick: () => {
      state.logsBot = t.id;
      renderLogTabs();
      loadLogHistory();
    },
  }, t.name)));
}

function logMatches(e) {
  if (state.logsBot !== 'all' && e.bot !== state.logsBot) return false;
  if ($('#logs-errors').checked && e.stream !== 'err') return false;
  const q = $('#logs-search').value.trim().toLowerCase();
  return !q || e.line.toLowerCase().includes(q);
}

function logLine(e) {
  const q = $('#logs-search').value.trim();
  const msg = h('span', { class: 'm' });
  if (q) {
    const lower = e.line.toLowerCase();
    const ql = q.toLowerCase();
    let i = 0;
    let at = lower.indexOf(ql);
    while (at !== -1) {
      msg.append(e.line.slice(i, at), h('mark', { text: e.line.slice(at, at + q.length) }));
      i = at + q.length;
      at = lower.indexOf(ql, i);
    }
    msg.append(e.line.slice(i));
  } else {
    msg.textContent = e.line;
  }
  return h('div', { class: `line ${e.stream}` },
    h('span', { class: 't', text: fmtTime(e.at) }),
    h('span', { class: `b ${e.bot}`, text: e.bot }),
    msg);
}

function renderLogs() {
  const box = $('#logs-console');
  const lines = state.logs.filter(logMatches).slice(-1500);
  box.replaceChildren(...(lines.length ? lines.map(logLine) : [h('div', { class: 'empty', text: 'ما فيه سجلات' })]));
  box.scrollTop = box.scrollHeight;
}

function pushLog(e) {
  state.logs.push(e);
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  if (state.logsPaused || !$('#page-logs').classList.contains('active') || !logMatches(e)) return;
  const box = $('#logs-console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const empty = $('.empty', box);
  if (empty) empty.remove();
  box.append(logLine(e));
  while (box.childElementCount > 1500) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function loadLogHistory() {
  renderLogTabs();
  if (!state.configured) return;
  const ids = state.logsBot === 'all' ? state.bots.map((b) => b.id) : [state.logsBot];
  try {
    const results = await Promise.all(ids.map((id) => gnd.api('GET', `/api/bots/${id}/logs?lines=${state.logsBot === 'all' ? 120 : 400}&stream=all`)));
    const history = results.flatMap((r) => r.entries);
    const live = state.logs.filter((e) => e.at && ids.includes(e.bot));
    state.logs = history.concat(live.filter((e) => !history.some((x) => x.line === e.line)));
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderLogs();
}

$('#logs-errors').addEventListener('change', renderLogs);
let searchTimer = null;
$('#logs-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderLogs, 200);
});
$('#logs-pause').addEventListener('click', (e) => {
  state.logsPaused = !state.logsPaused;
  e.currentTarget.textContent = state.logsPaused ? 'متابعة' : 'إيقاف مؤقت';
  if (!state.logsPaused) renderLogs();
});
$('#logs-clear').addEventListener('click', () => {
  state.logs = [];
  renderLogs();
});

// ---------- bot settings ----------

function renderBotTabs() {
  const bots = state.bots.filter((b) => b.kind === 'bot');
  if (!state.settingsBot && bots.length) state.settingsBot = bots[0].id;
  $('#settings-bots').replaceChildren(...bots.map((b) => h('button', {
    class: `tab ${state.settingsBot === b.id ? 'active' : ''}`,
    onclick: () => selectSettingsBot(b.id),
  }, botName(b))));
  const focus = $('#report-focus');
  const current = focus.value;
  focus.replaceChildren(h('option', { value: '' }, 'كل البوتات'), ...state.bots.map((b) => h('option', { value: b.id }, botName(b))));
  focus.value = current;
}

function currentSettingsBot() {
  return state.bots.find((b) => b.id === state.settingsBot) || null;
}

async function selectSettingsBot(id) {
  if (id) state.settingsBot = id;
  renderBotTabs();
  const b = currentSettingsBot();
  if (!b) return;
  const s = b.stats || {};
  $('#profile-avatar').src = avatarOf(b);
  $('#profile-name').value = (s.user && s.user.username) || '';
  if (s.presence) $('#presence-status').value = s.presence.status || 'online';
  await loadEnv();
}

async function loadEnv() {
  const b = currentSettingsBot();
  const body = $('#env-table tbody');
  body.replaceChildren();
  $('#env-file').textContent = '';
  if (!b) return;
  let env;
  try {
    env = await gnd.api('GET', `/api/bots/${b.id}/env`);
  } catch (err) {
    body.append(h('tr', {}, h('td', { colspan: 4, class: 'muted', text: err.message })));
    return;
  }
  $('#env-file').textContent = env.exists ? `(${env.file})` : `(${env.file} غير موجود)`;
  for (const k of env.keys) {
    const input = h('input', { class: 'input', type: k.secret ? 'password' : 'text', placeholder: k.set ? '••••••' : 'فاضي', dir: 'ltr' });
    body.append(h('tr', {},
      h('td', { class: 'key', text: k.key }),
      h('td', {}, h('span', { class: `tag ${k.secret ? 'secret' : ''}`, text: k.set ? (k.secret ? 'سري · مضبوط' : 'مضبوط') : 'فاضي' })),
      h('td', {}, input),
      h('td', {}, h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, () => saveEnv(k.key, input.value)) }, 'حفظ'),
        h('button', {
          class: 'btn sm danger',
          onclick: (e) => busy(e.currentTarget, async () => {
            if (!confirm(`حذف ${k.key}؟`)) return;
            await saveEnv(k.key, null);
          }),
        }, 'حذف')))));
  }
}

async function saveEnv(key, value) {
  const b = currentSettingsBot();
  if (value === '') {
    toast('اكتب قيمة أول', 'bad');
    return;
  }
  const restart = $('#env-restart').checked;
  await api('PUT', `/api/bots/${b.id}/env`, { key, value, restart });
  toast(`${key}: تم الحفظ${restart ? ' وريستارت البوت' : ''}`, 'ok');
  await loadEnv();
  if (restart) refreshSoon();
}

$('#env-add').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const key = $('#env-new-key').value.trim();
  const value = $('#env-new-value').value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    toast('اسم المفتاح لازم يكون حروف إنجليزية وأرقام و _', 'bad');
    return;
  }
  await saveEnv(key, value);
  $('#env-new-key').value = '';
  $('#env-new-value').value = '';
}));

$('#presence-type').addEventListener('change', () => {
  $('#presence-url-wrap').classList.toggle('hidden', $('#presence-type').value !== 'streaming');
});

async function botCommand(action, payload) {
  const b = currentSettingsBot();
  if (!b) return null;
  const res = await api('POST', `/api/bots/${b.id}/command`, { action, payload });
  refreshSoon();
  return res.result;
}

$('#presence-save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const text = $('#presence-text').value.trim();
  await botCommand('setPresence', {
    status: $('#presence-status').value,
    activity: text ? { type: $('#presence-type').value, name: text, url: $('#presence-url').value.trim() || undefined } : null,
  });
  toast('تم تغيير الحالة', 'ok');
}));

$('#presence-clear').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await botCommand('setPresence', { status: 'online', activity: null, clear: true });
  toast('تم. البوت يرجع لحالته الافتراضية بعد الريستارت', 'ok');
}));

$('#profile-name-save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const name = $('#profile-name').value.trim();
  await botCommand('setUsername', { username: name });
  toast('تم تغيير الاسم', 'ok');
}));

$('#profile-avatar-pick').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const file = await gnd.pickAvatar();
  if (!file) return;
  const res = await botCommand('setAvatar', { dataUrl: file.dataUrl });
  if (res && res.avatar) $('#profile-avatar').src = res.avatar;
  toast('تم تغيير الصورة', 'ok');
}));

// ---------- server ----------

function meter(k, v, pct) {
  const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  return h('div', { class: 'meter' },
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v', text: v }),
    pct === null ? null : h('div', { class: `bar ${cls}` }, h('span', { style: `width:${Math.max(2, Math.min(100, pct))}%` })));
}

function renderServer() {
  const s = state.system;
  if (!s) return;
  $('#server-host').textContent = `${s.hostname} · ${s.platform} · Node ${s.node}`;
  const memPct = (s.memory.used / s.memory.total) * 100;
  const diskPct = s.disk ? (s.disk.used / s.disk.total) * 100 : null;
  const lava = s.lavalink;
  const lavaBot = state.bots.find((b) => b.id === 'lavalink');
  const lavaText = lava ? (lava.reachable ? `يرد · ${lava.latency}ms` : 'ما يرد') : lavaBot ? STATUS_AR[lavaBot.status] || lavaBot.status : '-';
  $('#server-meters').replaceChildren(
    meter('المعالج', `${s.cpu}%  (${s.cpus} cores)`, s.cpu),
    meter('الرام', `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}`, memPct),
    meter('القرص', s.disk ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}` : '-', diskPct),
    meter('الحمل (1m / 5m / 15m)', s.load.join(' / '), null),
    meter('مدة تشغيل السيرفر', fmtDuration(s.uptime * 1000), null),
    meter('Lavalink', lavaText, null),
  );
  const btn = $('#update-run');
  btn.disabled = Boolean(state.update && state.update.running);
}

function updateLine(text) {
  const box = $('#update-console');
  box.append(h('div', { class: 'line' }, h('span', { class: 'm', text })));
  box.scrollTop = box.scrollHeight;
}

$('#update-run').addEventListener('click', async (e) => {
  if (!confirm('تحديث البوتات من GitHub؟ البوتات بتسوي ريستارت إذا فيه تغييرات.')) return;
  $('#update-console').replaceChildren();
  e.currentTarget.disabled = true;
  try {
    await api('POST', '/api/update');
  } catch {
    e.currentTarget.disabled = false;
  }
});

// ---------- report ----------

function renderReportSide() {
  $('#auto-report').checked = Boolean(state.settings.autoReport);
  $('#github-state').textContent = state.github.enabled
    ? `التقارير تروح لـ ${state.github.repo}`
    : 'GITHUB_TOKEN مو مضبوط في control/agent/.env، فزر الإرسال لـ GitHub ما بيشتغل. النسخ والحفظ يشتغلون.';
  $('#report-github').disabled = !state.github.enabled;
}

async function buildReport() {
  const focus = $('#report-focus').value;
  const res = await api('GET', `/api/report${focus ? `?focus=${encodeURIComponent(focus)}` : ''}`);
  state.report = res.markdown;
  $('#report-text').textContent = res.markdown;
  return res.markdown;
}

function reportResult(kind, ...content) {
  const box = $('#report-result');
  box.className = `notice ${kind}`;
  box.replaceChildren(...content);
}

$('#report-preview').addEventListener('click', (e) => busy(e.currentTarget, buildReport));
$('#report-copy').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const md = await buildReport();
  await gnd.copy(md);
  toast('نسخت التقرير، الصقه لـ Claude', 'ok');
}));
$('#report-save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const md = await buildReport();
  const file = await gnd.saveReport(md, `gnd-report-${new Date().toISOString().slice(0, 10)}.md`);
  if (file) toast(`انحفظ في ${file}`, 'ok');
}));
$('#report-github').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const res = await api('POST', '/api/report/github', { focus: $('#report-focus').value || null, note: $('#report-note').value });
  reportResult('ok',
    'تم إرسال التقرير. قل لـ Claude: ',
    h('b', { text: `شف التقرير رقم ${res.number}` }),
    ' · ',
    h('a', { onclick: () => gnd.openExternal(res.url) }, 'افتحه في GitHub'));
  buildReport().catch(() => {});
}));
$('#auto-report').addEventListener('change', async (e) => {
  try {
    state.settings = await api('PUT', '/api/settings', { autoReport: e.currentTarget.checked });
    toast(state.settings.autoReport ? 'التقرير التلقائي شغال' : 'التقرير التلقائي طافي', 'ok');
  } catch {
    e.currentTarget.checked = !e.currentTarget.checked;
  }
});

// ---------- connection ----------

async function renderConnection() {
  const cfg = await gnd.config();
  $('#conn-server').value = cfg.server;
  $('#conn-key').value = '';
  $('#conn-key-state').textContent = cfg.hasKey ? 'المفتاح محفوظ ومشفّر على جهازك. اتركه فاضي عشان تستخدم المحفوظ.' : 'ما فيه مفتاح محفوظ.';
  $('#pref-notify').checked = cfg.notifications;
  $('#pref-tray').checked = cfg.closeToTray;
}

$('#conn-save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    const res = await gnd.connect($('#conn-server').value, $('#conn-key').value);
    state.configured = true;
    toast(`اتصلت بالسيرفر (agent v${res.agent.version})`, 'ok');
    await renderConnection();
    await refresh();
    go('home');
  } catch (err) {
    toast(err.message, 'bad');
  }
}));
$('#conn-forget').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (!confirm('تبي تمسح المفتاح من الجهاز؟')) return;
  await gnd.forgetKey();
  state.configured = false;
  await renderConnection();
  toast('انمسح المفتاح', 'ok');
}));
$('#pref-notify').addEventListener('change', (e) => gnd.setPrefs({ notifications: e.currentTarget.checked }));
$('#pref-tray').addEventListener('change', (e) => gnd.setPrefs({ closeToTray: e.currentTarget.checked }));

// ---------- live channel ----------

function setLive(stateName) {
  state.live = stateName;
  const el = $('#live-state');
  el.className = `brand-sub ${stateName}`;
  $('.label', el).textContent = { online: 'متصل مباشر', connecting: 'يتصل...', offline: 'انقطع، يعيد المحاولة', off: 'غير متصل' }[stateName] || stateName;
  if (stateName === 'online') refreshSoon();
}

gnd.onLiveState(setLive);
gnd.onLive((msg) => {
  switch (msg.type) {
    case 'log':
      pushLog(msg.data);
      break;
    case 'event': {
      const d = msg.data;
      pushLog({ bot: d.bot, stream: 'evt', at: d.at, line: `[pm2] ${d.event}${d.manually ? ' (manual)' : ''}` });
      refreshSoon();
      break;
    }
    case 'stats': {
      const b = state.bots.find((x) => x.id === msg.data.bot);
      if (b) {
        b.stats = msg.data.stats;
        if ($('#page-home').classList.contains('active')) renderHome();
      }
      break;
    }
    case 'alert':
      toast(`${BOT_AR[msg.data.bot] || msg.data.bot}: ${msg.data.reason}`, 'bad');
      break;
    case 'update':
      updateLine(msg.data.line);
      break;
    case 'update-state':
      state.update = { running: msg.data.running, last: msg.data.result || state.update.last };
      $('#update-run').disabled = msg.data.running;
      if (!msg.data.running && msg.data.result) {
        toast(msg.data.result.ok ? 'خلص التحديث' : `فشل التحديث: ${msg.data.result.error}`, msg.data.result.ok ? 'ok' : 'bad');
        refreshSoon();
      }
      break;
    default:
      break;
  }
});

// ---------- start ----------

(async () => {
  const cfg = await gnd.config();
  setLive(cfg.liveState);
  $('#agent-version').textContent = `app v${cfg.version}`;
  state.configured = Boolean(cfg.server && cfg.hasKey);
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 5000);
  if (!state.configured) {
    go('connection');
    return;
  }
  await refresh();
})();
