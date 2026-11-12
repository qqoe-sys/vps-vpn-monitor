'use strict';
// Интерфейс. Данные приходят через window.api (см. preload.js).

const servers = new Map();
const ui = { view: 'overview', days: 7, expanded: new Set(), entry: null, showExit: false };
const terminals = new Map();
let activeTerm = null;

const $ = (id) => document.getElementById(id);
// Переводы: t('ключ', {подстановки}). Словари — src/i18n, язык выбирается внизу меню.
const { t } = window.I18N;

// Имена ключей и ошибки приходят извне, поэтому экранируем всё, что вставляем в HTML.
// Заодно переводим коды серверных скриптов (@E:...) в текст текущего языка.
const esc = (v) => window.I18N.translateServer(String(v ?? '')).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATUS = {
  ok: ['✓', 'status.ok'],
  warn: ['!', 'status.warn'],
  down: ['✕', 'status.down'],
  connecting: ['…', 'status.connecting'],
};

function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  const units = t('unit.bytes').split(',');
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  const mbit = (bytesPerSec * 8) / 1e6;
  return t('unit.mbps', { v: mbit >= 100 ? mbit.toFixed(0) : mbit.toFixed(2) });
}

function formatUptime(sec) {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? t('unit.uptimeDays', { d, h }) : t('unit.uptimeHours', { h, m });
}

function cleanError(err) {
  // Electron добавляет к ошибке служебный префикс про IPC.
  return String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function statusBadge(level, label) {
  const [icon, text] = STATUS[level] ?? STATUS.connecting;
  return `<span class="status ${level}">${icon} ${esc(label ?? t(text))}</span>`;
}

// --- Обзор ---

function meter(label, percent, detail) {
  const value = percent === null || percent === undefined ? '—' : `${percent.toFixed(0)}%`;
  return `<span title="${esc(detail ?? '')}">
    <span class="meter-label"><span>${label}</span><span class="meter-value">${value}</span></span>
    <span class="bar"><i style="width:${Math.min(100, percent ?? 0)}%"></i></span>
  </span>`;
}

function metrics(s) {
  const snap = s.snapshot;
  if (!snap) return { cpu: null, mem: null, disk: null, diskTotal: 0 };
  const diskTotal = snap.disk ? snap.disk.used + snap.disk.available : 0;
  return {
    cpu: s.rates.cpu,
    mem: snap.mem.total ? 100 * (1 - snap.mem.available / snap.mem.total) : null,
    disk: diskTotal ? (100 * snap.disk.used) / diskTotal : null,
    diskTotal,
  };
}

function speedChart(s) {
  const CAPACITY = 359;
  const points = s.history;
  const peak = Math.max(1, ...points.flatMap((p) => [p.rx ?? 0, p.tx ?? 0]));
  const line = (field) => points
    .map((p, i) => [600 - ((points.length - 1 - i) / CAPACITY) * 600, p[field]])
    .filter(([, v]) => v !== null)
    .map(([x, v]) => `${x.toFixed(1)},${(76 - (v / peak) * 72).toFixed(1)}`)
    .join(' ');
  return `<div class="chart" data-chart="${esc(s.id)}">
    <svg viewBox="0 0 600 76" preserveAspectRatio="none" aria-hidden="true">
      <polyline stroke="var(--series-1)" points="${line('rx')}"></polyline>
      <polyline stroke="var(--series-2)" points="${line('tx')}"></polyline>
    </svg>
    <span class="chart-max">${esc(t('ov.chartMax', { v: formatSpeed(peak) }))}</span>
  </div>
  <div class="chart-caption">${t('ov.chartCaption')}</div>`;
}

function serverDetail(s) {
  const snap = s.snapshot;
  const busy = actionBusy.has(s.id) ? 'disabled' : '';
  const msg = actionMessages.get(s.id);
  let info = '';
  if (snap) {
    const link = s.link ? (s.link.ok ? t('ov.linkOk', { ms: s.link.ms }) : t('ov.linkNo')) : '—';
    const services = Object.entries(snap.services).map(([n, st]) => `${n}: ${st}`).join(', ');
    info = `
      <div class="legend">
        <span><i class="swatch" style="background:var(--series-1)"></i>${t('ov.rx')} ${formatSpeed(s.rates.rxBps)}</span>
        <span><i class="swatch" style="background:var(--series-2)"></i>${t('ov.tx')} ${formatSpeed(s.rates.txBps)}</span>
      </div>
      ${speedChart(s)}
      <dl class="facts">
        <div><dt>${t('ov.address')}</dt><dd>${esc(s.host)}</dd></div>
        <div><dt>Xray</dt><dd>${esc(snap.xray.version ?? '—')}</dd></div>
        <div><dt>${t('ov.tcp')}</dt><dd>${snap.connections ?? '—'}</dd></div>
        <div><dt>${t('ov.restarts')}</dt><dd>${snap.xray.restarts ?? '—'}</dd></div>
        <div><dt>${t('ov.ports')}</dt><dd>${esc(snap.listening.filter((p) => p !== 22 && p < 10000).join(', '))}</dd></div>
        <div><dt>${t('ov.link')}</dt><dd>${link}</dd></div>
      </dl>
      <p class="note">${esc(services)}</p>`;
  }
  return `<div class="row-detail">${info}
    <div class="card-actions">
      <button class="btn" data-open-term="${esc(s.id)}">${t('ov.openTerm')}</button>
      <button class="btn" data-action="restartXray" data-server="${esc(s.id)}" ${busy}>${t('ov.restartXray')}</button>
      <button class="btn danger" data-action="rebootServer" data-server="${esc(s.id)}" ${busy}>${t('ov.reboot')}</button>
      ${s.passwordAuth === undefined ? '' : `<button class="btn" data-action="togglePassword" data-server="${esc(s.id)}" ${busy}>${t(s.passwordAuth ? 'ov.passOn' : 'ov.passOff')}</button>`}
      <button class="btn" data-change-pass="${esc(s.id)}" ${busy}>${t('ov.changePass')}</button>
      <button class="btn" data-edit-limit="${esc(s.id)}">${t('ov.limit')}</button>
      <button class="btn danger" data-remove-settings="${esc(s.id)}" ${busy}>${t('ov.removeSettings')}</button>
      ${s.managed && !s.noAccess ? `<button class="btn danger" data-remove-key="${esc(s.id)}" ${busy}>${t('ov.removeKey')}</button>` : ''}
      ${s.noAccess ? `<button class="btn" data-reconnect="${esc(s.id)}">${t('ov.reconnect')}</button>` : ''}
      ${s.exitHost && !s.replacedBy ? `<button class="btn" data-replace-entry="${esc(s.id)}" ${busy}>${t('ov.replaceEntry')}</button>` : ''}
      ${s.replacedBy ? `<button class="btn" data-close-exit="${esc(s.id)}" ${busy}>${t('ov.closeExit')}</button>
      <button class="btn" data-undo-replace="${esc(s.id)}" ${busy}>${t('ov.undoReplace')}</button>
      <button class="btn danger" data-forget="${esc(s.id)}" ${busy}>${t('ov.forget')}</button>` : ''}
      ${s.managed && s.connection === 'offline' && !s.replacedBy ? `<button class="btn" data-forget="${esc(s.id)}">${t('ov.forgetOffline')}</button>` : ''}
    </div>
    <p class="key-msg ${msg?.error ? 'error' : ''}">${esc(msg?.text ?? '')}</p>
  </div>`;
}

// Лимиты тарифов десятичные, как у хостеров.
const formatTb = (bytes) => t('unit.tb', { v: (bytes / 1e12).toFixed(2) });

function limitLine(s) {
  if (!s.limit) return '';
  return `<span class="row-limit ${s.limit.level}">${esc(t('ov.limitLeft', { left: formatTb(s.limit.remainingBytes), total: formatTb(s.limit.totalBytes) }))}</span>`;
}

// Роль считаем по данным серверов, а не по сохранённой строке: так она всегда на текущем языке.
function roleText(s) {
  const all = [...servers.values()];
  if (s.exitHost) {
    const exit = all.find((x) => x.host === s.exitHost);
    return t('role.entry', { exit: exit ? exit.name : s.exitHost });
  }
  return t(all.some((x) => x.exitHost === s.host) ? 'role.exit' : 'role.single');
}

function serverRow(s) {
  const open = ui.expanded.has(s.id);
  const m = metrics(s);
  const snap = s.snapshot;
  const problems = s.health.problems.length
    ? `<div class="row-problems"><ul class="problems">${s.health.problems.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul></div>` : '';
  return `<button class="row" data-toggle="${esc(s.id)}" aria-expanded="${open}">
      <span class="chev">▸</span>
      <span><span class="row-name">${esc(s.name)} ${statusBadge(s.health.level)}</span><span class="row-role">${esc(roleText(s))}</span>${s.replacedBy ? `<span class="row-replaced">${esc(t('ov.replacedBy', { name: servers.get(s.replacedBy)?.name ?? s.replacedBy }))}</span>` : ''}${limitLine(s)}</span>
      ${meter('CPU', m.cpu, snap ? t('ov.cpuDetail', { cores: snap.cores, load: snap.load.join(' ') }) : '')}
      ${meter(t('ov.mem'), m.mem, snap ? t('ov.ofTotal', { used: formatBytes(snap.mem.total - snap.mem.available), total: formatBytes(snap.mem.total) }) : '')}
      ${meter(t('ov.disk'), m.disk, snap ? t('ov.ofTotal', { used: formatBytes(snap.disk?.used), total: formatBytes(m.diskTotal) }) : '')}
      <span class="row-speed">↓ ${formatSpeed(s.rates.rxBps)}<br>↑ ${formatSpeed(s.rates.txBps)}</span>
      <span class="row-uptime" title="${t('ov.uptime')}">${snap ? formatUptime(snap.uptimeSec) : '—'}</span>
    </button>${problems}${open ? serverDetail(s) : ''}`;
}

// Связки "вход → выход": так сразу видно, работает ли VPN для клиентов.
// Одна группа на выход: все его входы (действующие и заменённые) и сам выход один раз.
function serverGroups() {
  const all = [...servers.values()];
  const groups = new Map();
  for (const entry of all.filter((s) => s.exitHost)) {
    if (!groups.has(entry.exitHost)) groups.set(entry.exitHost, { entries: [], exit: all.find((s) => s.host === entry.exitHost) });
    groups.get(entry.exitHost).entries.push(entry);
  }
  return [...groups.values()];
}

// Действующие входы группы; если все заменены — показываем по всем.
function activeEntries(group) {
  const active = group.entries.filter((e) => !e.replacedBy);
  return active.length ? active : group.entries;
}

const provider = (s) => s.name.split(' ')[0];
const city = (s) => s.name.split(' ').slice(1).join(' ');

function vpnBadge(group) {
  const levels = [...activeEntries(group).map((e) => e.health.level), group.exit?.health.level];
  if (levels.includes('down')) return statusBadge('down', t('ov.vpnDown'));
  if (levels.includes('connecting')) return statusBadge('connecting');
  if (levels.includes('warn')) return statusBadge('warn', t('ov.vpnWarn'));
  return statusBadge('ok', t('ov.vpnOk'));
}

// Серверы вне каскада показываются своей группой.
function singleServers() {
  const all = [...servers.values()];
  return all.filter((s) => !s.exitHost && !all.some((x) => x.exitHost === s.host));
}

function renderOverview() {
  const cascades = serverGroups().map((g) => `<section class="group">
    <div class="group-head">
      <span class="group-title">${esc(provider(activeEntries(g)[0]))}: ${esc(activeEntries(g).map(city).join(' / '))} → ${esc(g.exit ? city(g.exit) : '?')}</span>
      ${vpnBadge(g)}
    </div>
    ${g.entries.map(serverRow).join('')}${g.exit ? serverRow(g.exit) : ''}
  </section>`);
  const singles = singleServers().map((s) => `<section class="group">
    <div class="group-head"><span class="group-title">${esc(s.name)}</span>${vpnBadge({ entry: s })}</div>
    ${serverRow(s)}
  </section>`);
  $('overview').innerHTML = `<h2>${t('nav.overview')}</h2>${[...cascades, ...singles].join('') || `<p class="empty">${t('ov.empty')}</p>`}`;
}

function renderSide() {
  $('side-list').innerHTML = [...servers.values()].map((s) => {
    const [icon] = STATUS[s.health.level] ?? STATUS.connecting;
    return `<div class="side-row"><span class="status ${s.health.level}">${icon}</span>${esc(s.name)}</div>`;
  }).join('');
}

const actionBusy = new Set();
const actionMessages = new Map();
const ACTION_TEXT = {
  restartXray: ['act.restartPending', 'act.restartDone'],
  rebootServer: ['act.rebootPending', 'act.rebootDone'],
  togglePassword: ['act.passPending', 'act.passDone'],
};

async function runServerAction(action, serverId) {
  const [pending, done] = ACTION_TEXT[action].map((k) => t(k));
  actionBusy.add(serverId);
  actionMessages.set(serverId, { text: pending });
  renderOverview();
  try {
    const result = await window.api[action](serverId);
    actionMessages.set(serverId, { text: result.cancelled ? '' : done });
  } catch (err) {
    actionMessages.set(serverId, { text: cleanError(err), error: true });
  }
  actionBusy.delete(serverId);
  if (ui.view === 'overview') renderOverview();
}

// --- Ключи и трафик ---

const dayTotal = (d) => (d ? d.up + d.down : 0);
const shortDay = (date) => `${date.slice(8)}.${date.slice(5, 7)}`;

// Столбики по дням: и большой график сервера, и маленький у каждого ключа.
// peak общий для графиков одной карточки, чтобы ключи можно было сравнивать.
function dayBars(cssClass, range, byDay, peak) {
  if (!range.length) return '';
  return `<div class="${cssClass}">${range.map((date) => {
    const d = byDay[date];
    const tip = t('keys.dayTip', { day: shortDay(date), total: formatBytes(dayTotal(d)), down: formatBytes(d?.down ?? 0), up: formatBytes(d?.up ?? 0) });
    return `<div data-tip="${esc(tip)}"><i style="height:${(dayTotal(d) / peak) * 100}%"></i></div>`;
  }).join('')}</div>`;
}

function totalsBlock(tr) {
  const peak = Math.max(1, ...tr.range.map((d) => dayTotal(tr.daily[d])));
  return `<div class="tiles">
      <div><div class="tile-label">${t('keys.totalIface')}</div><div class="tile-value">${formatBytes(tr.total.up + tr.total.down)}</div></div>
      <div><div class="tile-label">${t('ov.rx')}</div><div class="tile-value">${formatBytes(tr.total.down)}</div></div>
      <div><div class="tile-label">${t('ov.tx')}</div><div class="tile-value">${formatBytes(tr.total.up)}</div></div>
    </div>
    <p class="before-line">${esc(t(tr.since ? 'keys.beforeSince' : 'keys.before', { since: tr.since ? shortDay(tr.since) : '', v: formatBytes(tr.before.up + tr.before.down) }))}</p>
    ${dayBars('bars', tr.range, tr.daily, peak)}`;
}

const keyNames = new Map(); // список ключей с сервера: массив или { error }
const keyMessages = new Map();
const keyBusy = new Set();
let lastTraffic = [];

function keySpeedText(rate) {
  return rate ? `↓ ${formatSpeed(rate.downBps)}<br>↑ ${formatSpeed(rate.upBps)}` : '—';
}

// Скорость обновляем точечно при каждом опросе: перерисовка всей таблицы стёрла бы ввод в форме.
function refreshKeySpeeds(s) {
  for (const cell of document.querySelectorAll('#keys [data-key-speed]')) {
    cell.innerHTML = keySpeedText(s.keyRates?.[cell.dataset.keySpeed]);
  }
}

function keysTable(tr) {
  const names = keyNames.get(tr.id);
  const live = Array.isArray(names) ? new Set(names) : null;
  const usage = new Map(tr.users.map((u) => [u.name, u]));
  for (const name of live ?? []) {
    if (!usage.has(name)) usage.set(name, { name, up: 0, down: 0, before: 0, days: {} });
  }
  if (!usage.size) return `<p class="empty">${t(names ? 'keys.none' : 'keys.loading')}</p>`;
  const rows = [...usage.values()].sort((a, b) => b.up + b.down - (a.up + a.down));
  const peak = Math.max(1, ...rows.flatMap((u) => tr.range.map((d) => dayTotal(u.days[d]))));
  const server = esc(tr.id);
  return `<table><thead><tr><th>${t('keys.colKey')}</th><th>${t('keys.colSpeed')}</th><th>${t('keys.colDays')}</th><th>${t('keys.colDown')}</th><th>${t('keys.colUp')}</th><th>${t('keys.colTotal')}</th><th>${t('keys.colBefore')}</th><th></th></tr></thead><tbody>
    ${rows.map((u) => {
    const deleted = live && !live.has(u.name);
    return `<tr>
      <td>${esc(u.name)}${deleted ? `<span class="tag-deleted">${t('keys.deleted')}</span>` : ''}</td>
      <td class="key-speed" data-key-speed="${esc(u.name)}">${keySpeedText(servers.get(tr.id)?.keyRates?.[u.name])}</td>
      <td class="mini-cell">${dayBars('mini', tr.range, u.days, peak)}</td>
      <td>${formatBytes(u.down)}</td><td>${formatBytes(u.up)}</td><td>${formatBytes(u.up + u.down)}</td><td>${formatBytes(u.before)}</td>
      <td class="key-actions">${live && !deleted ? `
        <button class="btn" data-key-links="${esc(u.name)}" data-server="${server}">${t('keys.links')}</button>
        <button class="btn" data-key-delete="${esc(u.name)}" data-server="${server}">${t('common.delete')}</button>` : ''}</td>
    </tr>`;
  }).join('')}
  </tbody></table>${names?.error ? `<p class="key-msg error">${esc(names.error)}</p>` : ''}`;
}

function exitBlock(exit) {
  const days = [...exit.range].reverse().filter((d) => exit.daily[d]);
  const list = days.length
    ? `<table><thead><tr><th>${t('keys.colDay')}</th><th>${t('keys.colDown')}</th><th>${t('keys.colUp')}</th><th>${t('keys.colTotal')}</th></tr></thead><tbody>
      ${days.map((d) => `<tr><td>${shortDay(d)}</td><td>${formatBytes(exit.daily[d].down)}</td><td>${formatBytes(exit.daily[d].up)}</td><td>${formatBytes(dayTotal(exit.daily[d]))}</td></tr>`).join('')}
      </tbody></table>`
    : `<p class="empty">${t('keys.noData')}</p>`;
  return `<div class="exit-box">${totalsBlock(exit)}${list}</div>`;
}

function renderKeysView() {
  const entries = lastTraffic.filter((tr) => tr.hasKeyStats);
  if (!entries.some((tr) => tr.id === ui.entry)) ui.entry = entries[0]?.id ?? null;
  const tr = entries.find((x) => x.id === ui.entry);
  if (!tr) { $('keys').innerHTML = `<h2>${t('nav.keys')}</h2><p class="empty">${t('keys.noServers')}</p>`; return; }
  const exit = lastTraffic.find((x) => x.id === tr.exitId);
  const periods = [[1, t('keys.today')], [7, t('keys.days', { n: 7 })], [30, t('keys.days', { n: 30 })], [0, t('keys.allTime')]];
  const msg = keyMessages.get(tr.id);
  $('keys').innerHTML = `<h2>${t('nav.keys')}</h2>
    <div class="topbar">
      <div class="tabs">${entries.map((e) => `<button class="btn ${e.id === tr.id ? 'active' : ''}" data-entry="${esc(e.id)}">${esc(e.name)}</button>`).join('')}</div>
      <div class="filters">${periods.map(([d, label]) => `<button class="btn ${d === ui.days ? 'active' : ''}" data-days="${d}">${label}</button>`).join('')}</div>
    </div>
    <article class="card">
      <div class="card-head"><div>
        <div class="card-title">${esc(tr.name)}</div>
        <div class="source">${t(tr.collector ? 'keys.collectorServer' : 'keys.collectorApp')}</div>
      </div></div>
      ${totalsBlock(tr)}
      <form class="key-form" data-key-form="${esc(tr.id)}">
        <input name="key" placeholder="${t('keys.newName')}" maxlength="32" aria-label="${t('keys.newName')}" autocomplete="off">
        ${tr.modes.length > 1 ? `<select name="profile" aria-label="${t('keys.mode')}">${tr.modes.map((m) => `<option value="${esc(m)}">${t(m === 'cascade' ? 'keys.modeCascade' : 'keys.modeSingle')}</option>`).join('')}</select>` : ''}
        <button class="btn" ${keyBusy.has(tr.id) ? 'disabled' : ''}>${t('keys.add')}</button>
      </form>
      <p class="key-msg ${msg?.error ? 'error' : ''}">${esc(msg?.text ?? '')}</p>
      ${keysTable(tr)}
      ${exit ? `<p class="exit-toggle"><button class="btn" data-toggle-exit>${esc(t(ui.showExit ? 'keys.hideExit' : 'keys.showExit', { name: exit.name }))}</button></p>${ui.showExit ? exitBlock(exit) : ''}` : ''}
    </article>
    <p class="note">${t('keys.note')}</p>`;
}

async function loadKeyNames(serverId) {
  try {
    keyNames.set(serverId, await window.api.keysList(serverId));
  } catch (err) {
    keyNames.set(serverId, { error: cleanError(err) });
  }
  if (ui.view === 'keys' && ui.entry === serverId) renderKeysView();
}

async function refreshKeysView() {
  lastTraffic = await window.api.getTraffic(ui.days);
  renderKeysView();
  if (ui.entry && !keyNames.has(ui.entry)) loadKeyNames(ui.entry);
}

async function keyOperation(serverId, pendingText, fn) {
  keyBusy.add(serverId);
  keyMessages.set(serverId, { text: pendingText });
  renderKeysView();
  try {
    const message = await fn();
    keyMessages.set(serverId, { text: message ?? '' });
  } catch (err) {
    keyMessages.set(serverId, { text: cleanError(err), error: true });
  }
  keyBusy.delete(serverId);
  keyNames.delete(serverId);
  if (ui.view === 'keys') refreshKeysView();
}

const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android', 'random'];

// source — откуда получать ссылки заново, когда меняют fingerprint.
function showLinks(title, links, source, fp = 'firefox') {
  const modal = $('modal');
  const picker = source ? `<label class="fp-row">${t('links.fingerprint')}
    <select id="fp-select" data-server="${esc(source.server)}" data-name="${esc(source.name)}" data-title="${esc(title)}">
      ${FINGERPRINTS.map((f) => `<option ${f === fp ? 'selected' : ''}>${f}</option>`).join('')}
    </select></label>` : '';
  modal.innerHTML = `<div class="modal-box" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><span>${esc(title)}</span><button class="btn" data-modal-close>${t('common.close')}</button></div>
    ${picker}
    <div class="qr-row">${links.map((l) => `<div>
      <div class="qr-title">${esc(l.label)}</div>
      <img src="${esc(l.qr)}" alt="${esc(t('links.qrAlt', { label: l.label }))}">
      <button class="btn" data-copy="${esc(l.url)}">${t('links.copy')}</button>
    </div>`).join('')}</div>
  </div>`;
  modal.hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
  $('modal').innerHTML = ''; // ссылки с UUID не оставляем в странице
}

function setView(view) {
  ui.view = view;
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('active', b.dataset.view === view);
  for (const v of ['overview', 'keys', 'terminal', 'setup', 'subs']) $(v).hidden = v !== view;
  if (view === 'overview') renderOverview();
  if (view === 'setup') renderSetup();
  if (view === 'keys') refreshKeysView();
  if (view === 'subs') refreshSubs();
  if (view === 'terminal') { renderTermBar(); fitActive(); }
}

// --- Терминал ---

function renderTermBar() {
  const openers = [...servers.values()].map((s) => `<button class="btn" data-open-term="${esc(s.id)}">+ ${esc(s.name)}</button>`).join('');
  const tabs = [...terminals.entries()].map(([id, tab]) => `
    <span class="btn term-tab ${id === activeTerm ? 'active' : ''}" data-term-tab="${id}" role="button" tabindex="0">
      ${esc(tab.name)}${tab.ended ? ` ${t('term.closedTag')}` : ''}
      <button class="term-x" data-term-close="${id}" aria-label="${t('term.closeTab')}">×</button>
    </span>`).join('');
  $('term-bar').innerHTML = openers + (tabs ? `<span class="term-sep"></span>${tabs}` : '');
  $('term-empty').hidden = terminals.size > 0;
}

function fitActive() {
  const tab = terminals.get(activeTerm);
  if (tab && ui.view === 'terminal') {
    tab.fit.fit();
    tab.term.focus();
  }
}

function activateTerm(id) {
  activeTerm = id;
  for (const [tid, tab] of terminals) tab.el.hidden = tid !== id;
  renderTermBar();
  fitActive();
}

async function openTerminal(serverId) {
  setView('terminal');
  if (!window.Terminal || !window.FitAddon) {
    $('term-empty').textContent = t('term.noXterm');
    return;
  }
  const TerminalClass = window.Terminal.Terminal ?? window.Terminal;
  const term = new TerminalClass({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0d0d0c' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'term-pane';
  $('term-host').append(el);
  term.open(el);
  fit.fit();

  // Ctrl+Shift+C копирует, Ctrl+Shift+V вставляет: обычный Ctrl+C нужен терминалу.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.code === 'KeyV') { navigator.clipboard.readText().then((x) => term.paste(x)); return false; }
    return true;
  });

  let id;
  try {
    id = await window.api.termOpen(serverId, { cols: term.cols, rows: term.rows });
  } catch (err) {
    term.dispose();
    el.remove();
    $('term-empty').textContent = t('term.connectFailed', { err: cleanError(err) });
    $('term-empty').hidden = false;
    return;
  }
  terminals.set(id, { term, fit, el, name: servers.get(serverId).name, ended: false });
  term.onData((d) => window.api.termInput(id, d));
  term.onResize((size) => window.api.termResize(id, size));
  activateTerm(id);
}

function closeTab(id) {
  const tab = terminals.get(id);
  if (!tab) return;
  window.api.termClose(id);
  tab.term.dispose();
  tab.el.remove();
  terminals.delete(id);
  activateTerm([...terminals.keys()].pop() ?? null);
}

// --- События ---

const tip = $('tip');
function showTip(text, x, y) {
  tip.textContent = text;
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(x + 12, window.innerWidth - w - 8)}px`;
  tip.style.top = `${y + 12}px`;
}

document.addEventListener('mousemove', (e) => {
  const chart = e.target.closest?.('[data-chart]');
  const hint = e.target.closest?.('[data-tip]');
  for (const c of document.querySelectorAll('.cursor')) c.remove();
  if (chart) {
    const history = servers.get(chart.dataset.chart).history;
    const rect = chart.getBoundingClientRect();
    const fromRight = Math.round(((rect.right - e.clientX) / rect.width) * 359);
    const p = history[history.length - 1 - fromRight];
    if (p) {
      const cursor = document.createElement('div');
      cursor.className = 'cursor';
      cursor.style.left = `${e.clientX - rect.left}px`;
      chart.append(cursor);
      showTip(t('ov.chartTip', { time: new Date(p.t).toLocaleTimeString(I18N.locale()), rx: formatSpeed(p.rx), tx: formatSpeed(p.tx), cpu: p.cpu === null ? '—' : `${p.cpu.toFixed(0)}%` }), e.clientX, e.clientY);
      return;
    }
  }
  if (hint) { showTip(hint.dataset.tip, e.clientX, e.clientY); return; }
  tip.hidden = true;
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-key-form]');
  if (!form) return;
  e.preventDefault();
  const serverId = form.dataset.keyForm;
  const name = form.elements.key.value.trim();
  if (!name || keyBusy.has(serverId)) return;
  keyOperation(serverId, t('keys.adding', { name }), async () => {
    const result = await window.api.keysAdd(serverId, name, form.elements.profile?.value);
    if (result.cancelled) return '';
    showLinks(t('keys.newKeyTitle', { name }), result.links);
    return t('keys.added', { name });
  });
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('button, [data-term-tab]');
  if (!el) return;
  const d = el.dataset;
  if (d.toggle) {
    if (!ui.expanded.delete(d.toggle)) ui.expanded.add(d.toggle);
    renderOverview();
  }
  if (d.action && !actionBusy.has(d.server)) runServerAction(d.action, d.server);
  handleServerAdminClick(d);
  if ('modalClose' in d) closeModal();
  if (d.copy) {
    navigator.clipboard.writeText(d.copy);
    el.textContent = t('common.copied');
  }
  if (d.entry) {
    ui.entry = d.entry;
    ui.showExit = false;
    refreshKeysView();
  }
  if ('toggleExit' in d) {
    ui.showExit = !ui.showExit;
    renderKeysView();
  }
  if (d.keyDelete && !keyBusy.has(d.server)) {
    const { keyDelete: name, server } = d;
    keyOperation(server, t('keys.deleting', { name }), async () => {
      const result = await window.api.keysDelete(server, name);
      return result.cancelled ? '' : t('keys.deletedMsg', { name });
    });
  }
  if (d.keyLinks) {
    const { keyLinks: name, server } = d;
    window.api.keysLinks(server, name)
      .then((links) => showLinks(t('keys.keyTitle', { name }), links, { server, name }))
      .catch((err) => { keyMessages.set(server, { text: cleanError(err), error: true }); renderKeysView(); });
  }
  if (d.view) setView(d.view);
  if (d.openTerm) openTerminal(d.openTerm);
  if (d.days) { ui.days = Number(d.days); refreshKeysView(); }
  if (d.termClose) { e.stopPropagation(); closeTab(Number(d.termClose)); return; }
  if (d.termTab) activateTerm(Number(d.termTab));
});

window.addEventListener('resize', fitActive);

window.api.onTermData(({ id, data }) => terminals.get(id)?.term.write(data));
window.api.onTermExit(({ id }) => {
  const tab = terminals.get(id);
  if (!tab) return;
  tab.ended = true;
  tab.term.write(`\r\n${t('term.closedLine')}\r\n`);
  renderTermBar();
});

window.api.onServerRemoved((id) => {
  servers.delete(id);
  ui.expanded.delete(id);
  renderSide();
  if (ui.view === 'overview') renderOverview();
});

window.api.onServerUpdate((s) => {
  servers.set(s.id, s);
  renderSide();
  if (ui.view === 'overview') renderOverview();
  if (ui.view === 'keys' && ui.entry === s.id) refreshKeySpeeds(s);
});

// --- Язык ---

// Статичные надписи из index.html помечены data-i18n="ключ".
function applyStaticTexts() {
  document.documentElement.lang = I18N.getLang();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('lang-select').value = I18N.getLang();
}

// Смена языка без перезапуска: главный процесс запоминает выбор, окно перерисовывается.
$('lang-select').addEventListener('change', async (e) => {
  I18N.setLang(await window.api.setLang(e.target.value));
  applyStaticTexts();
  renderSide();
  renderTermBar();
  setView(ui.view);
});

(async () => {
  I18N.setLang(await window.api.getLang());
  applyStaticTexts();
  for (const s of await window.api.getServers()) servers.set(s.id, s);
  renderSide();
  renderOverview();
  // Не перерисовываем вкладку, пока вводят имя ключа: иначе введённое пропадёт.
  setInterval(() => {
    const input = document.querySelector('.key-form input');
    if (ui.view === 'keys' && !input?.value && !keyBusy.size) refreshKeysView();
  }, 30000);
})();
