'use strict';
// Мастер добавления сервера и окна администрирования (лимит, удаление, повторное подключение).
// Использует esc, $, servers, ui, showLinks и другие функции из app.js.

const wizard = { running: false, mode: 'single', entry: 0, steps: [], error: null, keys: null, sni: null, replaceId: null, subs: null };

const value = (form, name) => form.elements[name].value.trim();
const num = (form, name) => Number(value(form, name));

function serverFields(n, label) {
  return `<fieldset class="setup-box"><legend>${label}</legend>
    <div class="fields">
      <label>Название<input name="name${n}" required autocomplete="off"></label>
      <label>IP-адрес<input name="host${n}" required autocomplete="off"></label>
      <label>Пароль root<input name="pass${n}" type="password" required autocomplete="off"></label>
      <label>Лимит, ТБ<input name="tb${n}" type="number" min="0.1" step="0.1" value="3" required></label>
      <label>День сброса<input name="reset${n}" type="number" min="1" max="31" value="1" required></label>
    </div>
  </fieldset>`;
}

const portField = (label, name, val) => `<label>${label}<input name="${name}" type="number" min="1" max="65535" value="${val}" required></label>`;

// Форма замены входа: один новый сервер вместо старого (replaceId — id старого входа).
function replaceForm() {
  const old = servers.get(wizard.replaceId);
  const tb = old?.limit?.config?.tb ?? 3;
  const day = old?.limit?.config?.resetDay ?? 1;
  return `<form id="replace-form">
    <p class="note">Новый сервер получит тех же клиентов (те же UUID и имена ключей) и те же порты, что у «${esc(old?.name ?? wizard.replaceId)}». Старый вход останется в списке и продолжит работать, пока ты его не закроешь.</p>
    <fieldset class="setup-box"><legend>Новый сервер</legend>
      <div class="fields">
        <label>Название<input name="name" required autocomplete="off" value="${esc(old ? `${old.name} (новый)` : '')}"></label>
        <label>IP-адрес<input name="host" required autocomplete="off"></label>
        <label>Пароль root<input name="pass" type="password" required autocomplete="off"></label>
        <label>Лимит, ТБ<input name="tb" type="number" min="0.1" step="0.1" value="${esc(tb)}" required></label>
        <label>День сброса<input name="resetDay" type="number" min="1" max="31" value="${esc(day)}" required></label>
      </div>
    </fieldset>
    ${wizard.error?.includes('не завершена') ? '<label class="setup-clean"><input type="checkbox" name="clean" checked> Убрать следы незавершённой установки и повторить</label>' : ''}
    <p class="note">Перед изменением сервера будут проверены ОС и занятые порты. Если что-то пойдёт не так, изменения откатятся.</p>
    <button class="btn setup-start">Заменить</button>
  </form>`;
}

function setupForm() {
  if (wizard.replaceId) return replaceForm();
  const two = wizard.mode !== 'single';
  const both = wizard.mode === 'both';
  return `<form id="setup-form">
    <div class="setup-modes">
      ${[['single', 'Одиночный VPN'], ['cascade', 'Каскад из двух серверов'], ['both', 'Каскад и одиночный на входном']].map(([m, t]) => `
        <label><input type="radio" name="mode" value="${m}" ${m === wizard.mode ? 'checked' : ''}> ${t}</label>`).join('')}
    </div>
    ${serverFields(0, two ? 'Сервер 1' : 'Сервер')}
    ${two ? serverFields(1, 'Сервер 2') : ''}
    ${two ? `<fieldset class="setup-box"><legend>Какой сервер входной</legend>
      <div class="setup-modes">
        <label><input type="radio" name="entry" value="0" ${wizard.entry === 0 ? 'checked' : ''}> Сервер 1</label>
        <label><input type="radio" name="entry" value="1" ${wizard.entry === 1 ? 'checked' : ''}> Сервер 2</label>
      </div></fieldset>` : ''}
    <fieldset class="setup-box"><legend>Порты (рекомендованные уже указаны)</legend>
      <div class="fields">
        ${portField('XHTTP', 'xhttp', 443)}${portField('Vision', 'vision', 8443)}
        ${both ? `${portField('Одиночный XHTTP', 'xhttp2', 2053)}${portField('Одиночный Vision', 'vision2', 2083)}` : ''}
        ${two ? portField('Порт выходного сервера', 'exitPort', 443) : ''}
      </div></fieldset>
    ${wizard.error?.includes('не завершена') ? '<label class="setup-clean"><input type="checkbox" name="clean" checked> Убрать следы незавершённой установки и повторить</label>' : ''}
    <p class="note">Вход по паролю на сервере останется. Перед изменением сервера будут проверены ОС и занятые порты. Если что-то пойдёт не так, изменения откатятся.</p>
    <button class="btn setup-start">Настроить</button>
  </form>`;
}

function buildPlan(form) {
  const limit = (n) => ({ tb: num(form, `tb${n}`), resetDay: num(form, `reset${n}`), mode: 'both' });
  const target = (n) => ({ name: value(form, `name${n}`), host: value(form, `host${n}`), password: form.elements[`pass${n}`].value, limit: limit(n) });
  const main = { xhttp: num(form, 'xhttp'), vision: num(form, 'vision') };
  const plan = { cleanIncomplete: Boolean(form.elements.clean?.checked) };
  if (wizard.mode === 'single') {
    plan.targets = [{ ...target(0), role: 'single', modes: ['single'], ports: { single: main } }];
    return plan;
  }
  const entryIndex = Number(form.elements.entry.value);
  const ports = { cascade: main };
  const modes = ['cascade'];
  if (wizard.mode === 'both') {
    ports.single = { xhttp: num(form, 'xhttp2'), vision: num(form, 'vision2') };
    modes.push('single');
  }
  plan.targets = [
    { ...target(entryIndex), role: 'entry', modes, ports },
    { ...target(1 - entryIndex), role: 'exit', modes: [], ports: { exit: num(form, 'exitPort') } },
  ];
  return plan;
}

const STEP_ICON = { run: '…', ok: '✓', fail: '✕', undo: '↩', 'undo-failed': '!' };

function setupProgress() {
  const steps = wizard.steps.map((s) => `<li class="step ${s.state}"><span>${STEP_ICON[s.state] ?? ''}</span> ${esc(s.title)}${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</li>`).join('');
  const sni = wizard.sni ? `<div class="setup-box"><b>Выбери SNI для ${esc(wizard.sni.host)}</b>
    ${wizard.sni.list.length ? wizard.sni.list.map((x, i) => `<label class="sni-row"><input type="radio" name="sni" value="${esc(x.domain)}" ${i === 0 ? 'checked' : ''}> ${esc(x.domain)} <small>${esc(x.ms)} мс</small></label>`).join('') : '<p class="empty">Подходящих сайтов не нашлось, введи домен сам.</p>'}
    <label class="sni-row">Свой домен <input id="sni-custom" autocomplete="off"></label>
    <button class="btn" data-sni-confirm>Продолжить</button></div>` : '';
  return `<ul class="steps">${steps}</ul>${sni}`;
}

function setupResult() {
  if (wizard.error) return `<p class="key-msg error">Остановлено: ${esc(wizard.error)}</p>`;
  if (!wizard.keys) return '';
  const subsNote = wizard.subs?.message ? `<p class="key-msg subs-note ${wizard.subs.error ? 'error' : ''}">${esc(wizard.subs.message)}</p>` : '';
  const title = wizard.replaceId ? '✓ Вход заменён, старый вход пока работает' : '✓ Сервер настроен и добавлен в программу';
  return `<p class="status ok">${title}</p>${subsNote}
    ${wizard.keys.length ? `<table><tbody>${wizard.keys.map((k, i) => `<tr><td>${esc(k.server)}</td><td>${esc(k.name)}</td><td class="key-actions"><button class="btn" data-setup-key="${i}">Ссылки и QR</button></td></tr>`).join('')}</tbody></table>` : ''}
    <p class="setup-actions"><button class="btn" data-setup-reset>${wizard.replaceId ? 'Готово' : 'Добавить ещё'}</button></p>`;
}

function renderSetup() {
  const form = wizard.steps.length && (wizard.running || wizard.keys) ? '' : setupForm();
  $('setup').innerHTML = `<h2>${wizard.replaceId ? 'Заменить вход' : 'Добавить сервер'}</h2>${form}${setupProgress()}${setupResult()}`;
}

document.addEventListener('change', async (e) => {
  if (e.target.name === 'mode' && e.target.form?.id === 'setup-form') {
    wizard.mode = e.target.value;
    renderSetup();
  }
  if (e.target.name === 'entry') wizard.entry = Number(e.target.value);
  if (e.target.id === 'fp-select') {
    const { server, name, title } = e.target.dataset;
    const fp = e.target.value;
    showLinks(title, await window.api.keysLinks(server, name, fp), { server, name }, fp);
  }
});

// Замена входа: тот же прогресс и выбор SNI, другой вызов API.
async function submitReplace(form) {
  const oldId = wizard.replaceId;
  const payload = {
    host: value(form, 'host'),
    password: form.elements.pass.value,
    name: value(form, 'name'),
    limit: { tb: num(form, 'tb'), resetDay: num(form, 'resetDay'), mode: 'both' },
    // Галочка появляется, только если прошлая попытка остановилась на «установка не завершена».
    cleanIncomplete: Boolean(form.elements.clean?.checked),
  };
  Object.assign(wizard, { running: true, steps: [], error: null, keys: null, sni: null, subs: null });
  form.reset(); // пароль не остаётся в поле
  renderSetup();
  try {
    const result = await window.api.replaceEntry(oldId, payload);
    if (result.ok) {
      wizard.keys = result.keys;
      wizard.subs = result.subs ?? null;
    } else wizard.error = result.cancelled ? 'отменено' : result.error;
  } catch (err) {
    wizard.error = cleanError(err);
  }
  wizard.running = false;
  wizard.sni = null;
  if (ui.view === 'setup') renderSetup();
}

// «Заменить вход» на карточке: открываем мастер в режиме replace.
function startReplace(oldId) {
  if (wizard.running) return;
  Object.assign(wizard, { replaceId: oldId, steps: [], error: null, keys: null, sni: null, subs: null });
  setView('setup');
}

// Кнопка меню «Добавить сервер» выводит из режима замены (пока мастер не занят).
// capture: срабатываем раньше общего обработчика кликов из app.js.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-view="setup"]') && !wizard.running && !wizard.keys) wizard.replaceId = null;
}, true);

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'replace-form') {
    e.preventDefault();
    if (!wizard.running) submitReplace(e.target);
    return;
  }
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  if (wizard.running) return;
  const plan = buildPlan(e.target);
  Object.assign(wizard, { running: true, steps: [], error: null, keys: null, sni: null });
  e.target.reset(); // пароль не остаётся в поле
  renderSetup();
  try {
    const result = await window.api.provisionStart(plan);
    if (result.ok) wizard.keys = result.keys;
    else wizard.error = result.error;
  } catch (err) {
    wizard.error = cleanError(err);
  }
  wizard.running = false;
  wizard.sni = null;
  if (ui.view === 'setup') renderSetup();
});

window.api.onProvisionProgress((p) => {
  const existing = wizard.steps.find((s) => s.id === p.id);
  if (existing) Object.assign(existing, p);
  else wizard.steps.push({ ...p });
  if (ui.view === 'setup') renderSetup();
});

window.api.onProvisionChooseSni((request) => {
  wizard.sni = request;
  if (ui.view === 'setup') renderSetup();
});

// --- Окна администрирования ---

function openDialog(html) {
  const modal = $('modal');
  modal.innerHTML = `<div class="modal-box" role="dialog">${html}</div>`;
  modal.hidden = false;
}

function dialogHead(title) {
  return `<div class="modal-head"><span>${esc(title)}</span><button class="btn" data-modal-close>Закрыть</button></div>`;
}

function setActionMessage(id, text, error) {
  actionMessages.set(id, { text, error });
  closeModal();
  if (ui.view === 'overview') renderOverview();
}

async function guarded(id, fn, doneText) {
  try {
    const result = await fn();
    setActionMessage(id, result.cancelled ? '' : doneText);
  } catch (err) {
    setActionMessage(id, cleanError(err), true);
  }
}

// 64 символа и маска 63: каждый символ равновероятен.
const PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789-_+=.';

function generatePassword(length = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => PASS_ALPHABET[b & 63]).join('');
}

function handlePasswordDialog(d) {
  if (d.changePass) {
    const s = servers.get(d.changePass);
    openDialog(`${dialogHead(`Сменить пароль: ${s.name}`)}
      <input id="pass-new" type="password" class="wide" placeholder="Новый пароль (от 12 символов)" autocomplete="new-password">
      <input id="pass-repeat" type="password" class="wide" placeholder="Ещё раз" autocomplete="new-password" style="margin-top:8px">
      <div class="pass-actions">
        <button class="btn" data-pass-generate>Сгенерировать</button>
        <label><input type="checkbox" id="pass-show"> Показать</label>
      </div>
      <p class="note">Программа пароль не запоминает. Сохрани его сам, например в менеджере паролей.</p>
      <p class="key-msg error" id="pass-error"></p>
      <p class="setup-actions"><button class="btn danger" data-pass-save="${esc(s.id)}">Сменить пароль</button></p>`);
  }
  if ('passGenerate' in d) {
    const value = generatePassword();
    $('pass-new').value = value;
    $('pass-repeat').value = value;
    $('pass-show').checked = true;
    $('pass-new').type = 'text';
    $('pass-repeat').type = 'text';
  }
  if (d.passSave) {
    const password = $('pass-new').value;
    if (password !== $('pass-repeat').value) {
      $('pass-error').textContent = 'Пароли не совпадают';
      return;
    }
    guarded(d.passSave, () => window.api.changePassword(d.passSave, password), 'Пароль изменён');
  }
}

document.addEventListener('change', (e) => {
  if (e.target.id !== 'pass-show') return;
  const type = e.target.checked ? 'text' : 'password';
  $('pass-new').type = type;
  $('pass-repeat').type = type;
});

async function handleServerAdminClick(d) {
  handlePasswordDialog(d);
  const s = servers.get(d.removeSettings ?? d.removeKey ?? d.reconnect ?? d.editLimit);
  if (d.removeSettings) {
    openDialog(`${dialogHead('Удалить настройки')}
      <p>Будет удалено только то, что внедрила эта программа. Чтобы продолжить, введи название сервера: <b>${esc(s.name)}</b></p>
      <input id="remove-name" autocomplete="off" class="wide">
      ${s.managed ? '<label class="setup-clean"><input type="checkbox" id="remove-backup"> Сохранить бэкап конфига на ПК</label>' : ''}
      <p class="setup-actions"><button class="btn danger" data-confirm-remove="${esc(s.id)}">Удалить</button></p>`);
  }
  if (d.confirmRemove) {
    const id = d.confirmRemove;
    const typed = $('remove-name').value;
    const backup = Boolean($('remove-backup')?.checked);
    guarded(id, () => window.api.removeSettings(id, typed, backup), 'Настройки удалены');
  }
  if (d.replaceEntry) startReplace(d.replaceEntry);
  if (d.closeExit) {
    // Подтверждение спрашивает main (окно Windows), второе окно здесь не нужно.
    const id = d.closeExit;
    try {
      const result = await window.api.closeExitAccess(id);
      // message — пояснение от main (например, что правило уже было закрыто)
      setActionMessage(id, result.cancelled ? '' : `Доступ на выходе закрыт.${result.message ? ` ${result.message}` : ''}`);
    } catch (err) {
      setActionMessage(id, cleanError(err), true);
    }
  }
  if (d.undoReplace) {
    const id = d.undoReplace;
    try {
      const result = await window.api.undoReplace(id);
      const subsNote = result.subs?.message ? ` ${result.subs.message}` : '';
      setActionMessage(id, result.cancelled ? '' : `Замена отменена.${subsNote}`, Boolean(result.subs?.error));
    } catch (err) {
      setActionMessage(id, cleanError(err), true);
    }
  }
  if (d.forget) guarded(d.forget, () => window.api.forgetServer(d.forget), 'Сервер убран из программы');
  if (d.removeKey) guarded(s.id, () => window.api.removeAppKey(s.id), 'Ключ доступа удалён, вход по паролю остался');
  if (d.reconnect) {
    openDialog(`${dialogHead(`Подключить снова: ${s.name}`)}
      <input id="reconnect-pass" type="password" placeholder="Пароль root" autocomplete="off" class="wide">
      <p class="setup-actions"><button class="btn" data-confirm-reconnect="${esc(s.id)}">Подключить</button></p>`);
  }
  if (d.confirmReconnect) {
    const password = $('reconnect-pass').value;
    guarded(d.confirmReconnect, () => window.api.reconnect(d.confirmReconnect, password), 'Доступ восстановлен');
  }
  if (d.editLimit) {
    const c = s.limit?.config ?? { tb: 3, resetDay: 1, mode: 'both' };
    const opt = (v, t) => `<option value="${v}" ${c.mode === v ? 'selected' : ''}>${t}</option>`;
    openDialog(`${dialogHead(`Лимит: ${s.name}`)}
      <div class="fields">
        <label>Лимит, ТБ<input id="limit-tb" type="number" min="0.1" step="0.1" value="${esc(c.tb)}"></label>
        <label>День сброса<input id="limit-day" type="number" min="1" max="31" value="${esc(c.resetDay)}"></label>
        <label>Что считать<select id="limit-mode">${opt('both', 'Оба направления')}${opt('down', 'Только входящий')}${opt('up', 'Только исходящий')}</select></label>
        <label>Израсходовано по панели, ТБ<input id="limit-panel" type="number" min="0" step="0.01" placeholder="необязательно"></label>
      </div>
      <p class="note">Сейчас учтено ${s.limit ? formatTb(s.limit.usedBytes) : '—'} с ${s.limit ? esc(s.limit.periodStart) : '—'}${s.limit?.includesBaseline ? ', включая объём до начала учёта' : ''}. Цифра из панели хостера точнее: она поправит учёт до конца этого периода.</p>
      <p class="setup-actions"><button class="btn" data-save-limit="${esc(s.id)}">Сохранить</button></p>`);
  }
  if (d.saveLimit) {
    const panel = $('limit-panel').value.trim();
    const limit = { tb: Number($('limit-tb').value), resetDay: Number($('limit-day').value), mode: $('limit-mode').value, panelTb: panel === '' ? undefined : Number(panel) };
    guarded(d.saveLimit, () => window.api.setLimit(d.saveLimit, limit), 'Лимит сохранён');
  }
  if ('sniConfirm' in d) {
    const custom = $('sni-custom').value.trim();
    const picked = custom || document.querySelector('input[name="sni"]:checked')?.value;
    if (!picked) return;
    wizard.sni = null;
    window.api.provisionSni(picked);
    renderSetup();
  }
  if (d.setupKey) {
    const k = wizard.keys[Number(d.setupKey)];
    showLinks(`Ключ: ${k.name}`, k.links);
  }
  if ('setupReset' in d) {
    Object.assign(wizard, { steps: [], error: null, keys: null, sni: null, replaceId: null, subs: null });
    renderSetup();
  }
}
