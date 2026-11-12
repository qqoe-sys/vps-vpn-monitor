'use strict';
// Интерфейс. Данные приходят через window.api (см. preload.js).

const servers = new Map();
const ui = { view: 'overview', days: 7, expanded: new Set(), entry: null, showExit: false };
const terminals = new Map();
let activeTerm = null;

const $ = (id) => document.getElementById(id);

// Имена ключей и ошибки приходят извне, поэтому экранируем всё, что вставляем в HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATUS = {
  ok: ['✓', 'Работает'],
  warn: ['!', 'Внимание'],
  down: ['✕', 'Проблема'],
  connecting: ['…', 'Подключение'],
};

function formatBytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  const mbit = (bytesPerSec * 8) / 1e6;
  return mbit >= 100 ? `${mbit.toFixed(0)} Мбит/с` : `${mbit.toFixed(2)} Мбит/с`;
}

function formatUptime(sec) {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} д ${h} ч` : `${h} ч ${m} мин`;
}

function cleanError(err) {
  // Electron добавляет к ошибке служебный префикс про IPC.
  return String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function statusBadge(level, label) {
  const [icon, text] = STATUS[level] ?? STATUS.connecting;
  return `<span class="status ${level}">${icon} ${esc(label ?? text)}</span>`;
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
    <span class="chart-max">до ${formatSpeed(peak)}</span>
  </div>
  <div class="chart-caption">Скорость за последний час</div>`;
}

function serverDetail(s) {
  const snap = s.snapshot;
  const busy = actionBusy.has(s.id) ? 'disabled' : '';
  const msg = actionMessages.get(s.id);
  let info = '';
  if (snap) {
    const link = s.link ? (s.link.ok ? `есть, ${s.link.ms} мс` : 'нет') : '—';
    const services = Object.entries(snap.services).map(([n, st]) => `${n}: ${st}`).join(', ');
    info = `
      <div class="legend">
        <span><i class="swatch" style="background:var(--series-1)"></i>Входящий ${formatSpeed(s.rates.rxBps)}</span>
        <span><i class="swatch" style="background:var(--series-2)"></i>Исходящий ${formatSpeed(s.rates.txBps)}</span>
      </div>
      ${speedChart(s)}
      <dl class="facts">
        <div><dt>Адрес</dt><dd>${esc(s.host)}</dd></div>
        <div><dt>Xray</dt><dd>${esc(snap.xray.version ?? '—')}</dd></div>
        <div><dt>Соединений TCP</dt><dd>${snap.connections ?? '—'}</dd></div>
        <div><dt>Рестартов Xray</dt><dd>${snap.xray.restarts ?? '—'}</dd></div>
        <div><dt>Порты</dt><dd>${esc(snap.listening.filter((p) => p !== 22 && p < 10000).join(', '))}</dd></div>
        <div><dt>Связь с выходом</dt><dd>${link}</dd></div>
      </dl>
      <p class="note">${esc(services)}</p>`;
  }
  return `<div class="row-detail">${info}
    <div class="card-actions">
      <button class="btn" data-open-term="${esc(s.id)}">Открыть терминал</button>
      <button class="btn" data-action="restartXray" data-server="${esc(s.id)}" ${busy}>Перезапустить Xray</button>
      <button class="btn danger" data-action="rebootServer" data-server="${esc(s.id)}" ${busy}>Перезагрузить сервер</button>
      ${s.passwordAuth === undefined ? '' : `<button class="btn" data-action="togglePassword" data-server="${esc(s.id)}" ${busy}>Вход по паролю: ${s.passwordAuth ? 'вкл' : 'выкл'}</button>`}
      <button class="btn" data-change-pass="${esc(s.id)}" ${busy}>Сменить пароль</button>
      <button class="btn" data-edit-limit="${esc(s.id)}">Лимит трафика</button>
      <button class="btn danger" data-remove-settings="${esc(s.id)}" ${busy}>Удалить настройки</button>
      ${s.managed && !s.noAccess ? `<button class="btn danger" data-remove-key="${esc(s.id)}" ${busy}>Удалить ключ доступа</button>` : ''}
      ${s.noAccess ? `<button class="btn" data-reconnect="${esc(s.id)}">Подключить снова</button>` : ''}
      ${s.exitHost && !s.replacedBy ? `<button class="btn" data-replace-entry="${esc(s.id)}" ${busy}>Заменить вход</button>` : ''}
      ${s.replacedBy ? `<button class="btn" data-close-exit="${esc(s.id)}" ${busy}>Закрыть доступ на выходе</button>
      <button class="btn" data-undo-replace="${esc(s.id)}" ${busy}>Отменить замену</button>
      <button class="btn danger" data-forget="${esc(s.id)}" ${busy}>Удалить сервер из списка</button>` : ''}
      ${s.managed && s.connection === 'offline' && !s.replacedBy ? `<button class="btn" data-forget="${esc(s.id)}">Убрать из программы</button>` : ''}
    </div>
    <p class="key-msg ${msg?.error ? 'error' : ''}">${esc(msg?.text ?? '')}</p>
  </div>`;
}

// Лимиты тарифов десятичные, как у хостеров.
const formatTb = (bytes) => `${(bytes / 1e12).toFixed(2)} ТБ`;

function limitLine(s) {
  if (!s.limit) return '';
  return `<span class="row-limit ${s.limit.level}">Осталось ${formatTb(s.limit.remainingBytes)} из ${formatTb(s.limit.totalBytes)}</span>`;
}

function serverRow(s) {
  const open = ui.expanded.has(s.id);
  const m = metrics(s);
  const snap = s.snapshot;
  const problems = s.health.problems.length
    ? `<div class="row-problems"><ul class="problems">${s.health.problems.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul></div>` : '';
  return `<button class="row" data-toggle="${esc(s.id)}" aria-expanded="${open}">
      <span class="chev">▸</span>
      <span><span class="row-name">${esc(s.name)} ${statusBadge(s.health.level)}</span><span class="row-role">${esc(s.role)}</span>${s.replacedBy ? `<span class="row-replaced">заменён → ${esc(servers.get(s.replacedBy)?.name ?? s.replacedBy)}</span>` : ''}${limitLine(s)}</span>
      ${meter('CPU', m.cpu, snap ? `${snap.cores} ядер, нагрузка ${snap.load.join(' ')}` : '')}
      ${meter('Память', m.mem, snap ? `${formatBytes(snap.mem.total - snap.mem.available)} из ${formatBytes(snap.mem.total)}` : '')}
      ${meter('Диск', m.disk, snap ? `${formatBytes(snap.disk?.used)} из ${formatBytes(m.diskTotal)}` : '')}
      <span class="row-speed">↓ ${formatSpeed(s.rates.rxBps)}<br>↑ ${formatSpeed(s.rates.txBps)}</span>
      <span class="row-uptime" title="Аптайм">${snap ? formatUptime(snap.uptimeSec) : '—'}</span>
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
  if (levels.includes('down')) return statusBadge('down', 'VPN: проблема');
  if (levels.includes('connecting')) return statusBadge('connecting');
  if (levels.includes('warn')) return statusBadge('warn', 'VPN работает, есть замечания');
  return statusBadge('ok', 'VPN работает');
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
  $('overview').innerHTML = `<h2>Обзор</h2>${[...cascades, ...singles].join('')}`;
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
  restartXray: ['Перезапускаю Xray…', 'Xray перезапущен'],
  rebootServer: ['Отправляю перезагрузку…', 'Сервер перезагружается, вернётся через 1–2 минуты'],
  togglePassword: ['Меняю настройку входа…', 'Настройка входа изменена'],
};

async function runServerAction(action, serverId) {
  const [pending, done] = ACTION_TEXT[action];
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
    const tip = `${shortDay(date)}\nВсего ${formatBytes(dayTotal(d))}\nСкачано ${formatBytes(d?.down ?? 0)}\nОтправлено ${formatBytes(d?.up ?? 0)}`;
    return `<div data-tip="${esc(tip)}"><i style="height:${(dayTotal(d) / peak) * 100}%"></i></div>`;
  }).join('')}</div>`;
}

function totalsBlock(t) {
  const peak = Math.max(1, ...t.range.map((d) => dayTotal(t.daily[d])));
  return `<div class="tiles">
      <div><div class="tile-label">Всего через интерфейс</div><div class="tile-value">${formatBytes(t.total.up + t.total.down)}</div></div>
      <div><div class="tile-label">Входящий</div><div class="tile-value">${formatBytes(t.total.down)}</div></div>
      <div><div class="tile-label">Исходящий</div><div class="tile-value">${formatBytes(t.total.up)}</div></div>
    </div>
    <p class="before-line">До начала учёта${t.since ? ` (до ${shortDay(t.since)})` : ''}: ${formatBytes(t.before.up + t.before.down)}</p>
    ${dayBars('bars', t.range, t.daily, peak)}`;
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

function keysTable(t) {
  const names = keyNames.get(t.id);
  const live = Array.isArray(names) ? new Set(names) : null;
  const usage = new Map(t.users.map((u) => [u.name, u]));
  for (const name of live ?? []) {
    if (!usage.has(name)) usage.set(name, { name, up: 0, down: 0, before: 0, days: {} });
  }
  if (!usage.size) return `<p class="empty">${names ? 'Ключей нет.' : 'Загрузка ключей…'}</p>`;
  const rows = [...usage.values()].sort((a, b) => b.up + b.down - (a.up + a.down));
  const peak = Math.max(1, ...rows.flatMap((u) => t.range.map((d) => dayTotal(u.days[d]))));
  const server = esc(t.id);
  return `<table><thead><tr><th>Ключ</th><th>Скорость</th><th>По дням</th><th>Скачано</th><th>Отправлено</th><th>Всего</th><th>До учёта</th><th></th></tr></thead><tbody>
    ${rows.map((u) => {
    const deleted = live && !live.has(u.name);
    return `<tr>
      <td>${esc(u.name)}${deleted ? '<span class="tag-deleted">удалён</span>' : ''}</td>
      <td class="key-speed" data-key-speed="${esc(u.name)}">${keySpeedText(servers.get(t.id)?.keyRates?.[u.name])}</td>
      <td class="mini-cell">${dayBars('mini', t.range, u.days, peak)}</td>
      <td>${formatBytes(u.down)}</td><td>${formatBytes(u.up)}</td><td>${formatBytes(u.up + u.down)}</td><td>${formatBytes(u.before)}</td>
      <td class="key-actions">${live && !deleted ? `
        <button class="btn" data-key-links="${esc(u.name)}" data-server="${server}">Ссылки</button>
        <button class="btn" data-key-delete="${esc(u.name)}" data-server="${server}">Удалить</button>` : ''}</td>
    </tr>`;
  }).join('')}
  </tbody></table>${names?.error ? `<p class="key-msg error">${esc(names.error)}</p>` : ''}`;
}

function exitBlock(exit) {
  const days = [...exit.range].reverse().filter((d) => exit.daily[d]);
  const list = days.length
    ? `<table><thead><tr><th>День</th><th>Скачано</th><th>Отправлено</th><th>Всего</th></tr></thead><tbody>
      ${days.map((d) => `<tr><td>${shortDay(d)}</td><td>${formatBytes(exit.daily[d].down)}</td><td>${formatBytes(exit.daily[d].up)}</td><td>${formatBytes(dayTotal(exit.daily[d]))}</td></tr>`).join('')}
      </tbody></table>`
    : '<p class="empty">За этот период данных нет.</p>';
  return `<div class="exit-box">${totalsBlock(exit)}${list}</div>`;
}

function renderKeysView() {
  const entries = lastTraffic.filter((t) => t.hasKeyStats);
  if (!entries.some((t) => t.id === ui.entry)) ui.entry = entries[0]?.id ?? null;
  const t = entries.find((x) => x.id === ui.entry);
  if (!t) { $('keys').innerHTML = '<h2>Ключи и трафик</h2>'; return; }
  const exit = lastTraffic.find((x) => x.id === t.exitId);
  const periods = [[1, 'Сегодня'], [7, '7 дней'], [30, '30 дней'], [0, 'Всё время']];
  const msg = keyMessages.get(t.id);
  $('keys').innerHTML = `<h2>Ключи и трафик</h2>
    <div class="topbar">
      <div class="tabs">${entries.map((e) => `<button class="btn ${e.id === t.id ? 'active' : ''}" data-entry="${esc(e.id)}">${esc(e.name)}</button>`).join('')}</div>
      <div class="filters">${periods.map(([d, label]) => `<button class="btn ${d === ui.days ? 'active' : ''}" data-days="${d}">${label}</button>`).join('')}</div>
    </div>
    <article class="card">
      <div class="card-head"><div>
        <div class="card-title">${esc(t.name)}</div>
        <div class="source">${t.collector ? 'Учёт ведётся на сервере' : 'Учёт ведётся в приложении: сборщик на сервере не установлен'}</div>
      </div></div>
      ${totalsBlock(t)}
      <form class="key-form" data-key-form="${esc(t.id)}">
        <input name="key" placeholder="Имя нового ключа" maxlength="32" aria-label="Имя нового ключа" autocomplete="off">
        ${t.modes.length > 1 ? `<select name="profile" aria-label="Режим ключа">${t.modes.map((m) => `<option value="${esc(m)}">${m === 'cascade' ? 'Каскад' : 'Одиночный'}</option>`).join('')}</select>` : ''}
        <button class="btn" ${keyBusy.has(t.id) ? 'disabled' : ''}>Добавить ключ</button>
      </form>
      <p class="key-msg ${msg?.error ? 'error' : ''}">${esc(msg?.text ?? '')}</p>
      ${keysTable(t)}
      ${exit ? `<p class="exit-toggle"><button class="btn" data-toggle-exit>${ui.showExit ? 'Скрыть' : 'Показать'} трафик выхода: ${esc(exit.name)}</button></p>${ui.showExit ? exitBlock(exit) : ''}` : ''}
    </article>
    <p class="note">«Всего» считается через сетевой интерфейс: на входном сервере он примерно вдвое больше суммы по ключам. «До учёта» — объём из счётчиков на момент начала учёта, без дат; он входит только в «Всё время».</p>`;
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
  const picker = source ? `<label class="fp-row">Fingerprint
    <select id="fp-select" data-server="${esc(source.server)}" data-name="${esc(source.name)}" data-title="${esc(title)}">
      ${FINGERPRINTS.map((f) => `<option ${f === fp ? 'selected' : ''}>${f}</option>`).join('')}
    </select></label>` : '';
  modal.innerHTML = `<div class="modal-box" role="dialog" aria-label="${esc(title)}">
    <div class="modal-head"><span>${esc(title)}</span><button class="btn" data-modal-close>Закрыть</button></div>
    ${picker}
    <div class="qr-row">${links.map((l) => `<div>
      <div class="qr-title">${esc(l.label)}</div>
      <img src="${esc(l.qr)}" alt="QR-код ${esc(l.label)}">
      <button class="btn" data-copy="${esc(l.url)}">Скопировать ссылку</button>
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
  const tabs = [...terminals.entries()].map(([id, t]) => `
    <span class="btn term-tab ${id === activeTerm ? 'active' : ''}" data-term-tab="${id}" role="button" tabindex="0">
      ${esc(t.name)}${t.ended ? ' (закрыт)' : ''}
      <button class="term-x" data-term-close="${id}" aria-label="Закрыть вкладку">×</button>
    </span>`).join('');
  $('term-bar').innerHTML = openers + (tabs ? `<span class="term-sep"></span>${tabs}` : '');
  $('term-empty').hidden = terminals.size > 0;
}

function fitActive() {
  const t = terminals.get(activeTerm);
  if (t && ui.view === 'terminal') {
    t.fit.fit();
    t.term.focus();
  }
}

function activateTerm(id) {
  activeTerm = id;
  for (const [tid, t] of terminals) t.el.hidden = tid !== id;
  renderTermBar();
  fitActive();
}

async function openTerminal(serverId) {
  setView('terminal');
  if (!window.Terminal || !window.FitAddon) {
    $('term-empty').textContent = 'Не загрузился xterm.js: выполни npm install.';
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
    $('term-empty').textContent = `Не удалось подключиться: ${cleanError(err)}`;
    $('term-empty').hidden = false;
    return;
  }
  terminals.set(id, { term, fit, el, name: servers.get(serverId).name, ended: false });
  term.onData((d) => window.api.termInput(id, d));
  term.onResize((size) => window.api.termResize(id, size));
  activateTerm(id);
}

function closeTab(id) {
  const t = terminals.get(id);
  if (!t) return;
  window.api.termClose(id);
  t.term.dispose();
  t.el.remove();
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
      showTip(`${new Date(p.t).toLocaleTimeString('ru')}\nВходящий ${formatSpeed(p.rx)}\nИсходящий ${formatSpeed(p.tx)}\nCPU ${p.cpu === null ? '—' : `${p.cpu.toFixed(0)}%`}`, e.clientX, e.clientY);
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
  keyOperation(serverId, `Добавляю ${name}…`, async () => {
    const result = await window.api.keysAdd(serverId, name, form.elements.profile?.value);
    if (result.cancelled) return '';
    showLinks(`Новый ключ: ${name}`, result.links);
    return `Ключ ${name} добавлен`;
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
    el.textContent = 'Скопировано';
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
    keyOperation(server, `Удаляю ${name}…`, async () => {
      const result = await window.api.keysDelete(server, name);
      return result.cancelled ? '' : `Ключ ${name} удалён`;
    });
  }
  if (d.keyLinks) {
    const { keyLinks: name, server } = d;
    window.api.keysLinks(server, name)
      .then((links) => showLinks(`Ключ: ${name}`, links, { server, name }))
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
  const t = terminals.get(id);
  if (!t) return;
  t.ended = true;
  t.term.write('\r\n[соединение закрыто]\r\n');
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

(async () => {
  for (const s of await window.api.getServers()) servers.set(s.id, s);
  renderSide();
  renderOverview();
  // Не перерисовываем вкладку, пока вводят имя ключа: иначе введённое пропадёт.
  setInterval(() => {
    const input = document.querySelector('.key-form input');
    if (ui.view === 'keys' && !input?.value && !keyBusy.size) refreshKeysView();
  }, 30000);
})();
