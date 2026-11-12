'use strict';
// Мастер добавления сервера и окна администрирования (лимит, удаление, повторное подключение).
// Использует esc, $, servers, ui, showLinks и другие функции из app.js.

const wizard = { running: false, mode: 'single', entry: 0, steps: [], error: null, keys: null, sni: null, replaceId: null, subs: null };

const value = (form, name) => form.elements[name].value.trim();
const num = (form, name) => Number(value(form, name));

function serverFields(n, label) {
  return `<fieldset class="setup-box"><legend>${label}</legend>
    <div class="fields">
      <label>${t('setup.name')}<input name="name${n}" required autocomplete="off"></label>
      <label>${t('setup.ip')}<input name="host${n}" required autocomplete="off"></label>
      <label>${t('setup.rootPass')}<input name="pass${n}" type="password" required autocomplete="off"></label>
      <label>${t('setup.limitTb')}<input name="tb${n}" type="number" min="0.1" step="0.1" value="3" required></label>
      <label>${t('setup.resetDay')}<input name="reset${n}" type="number" min="1" max="31" value="1" required></label>
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
    <p class="note">${esc(t('setup.replaceNote', { name: old?.name ?? wizard.replaceId }))}</p>
    <fieldset class="setup-box"><legend>${t('setup.newServer')}</legend>
      <div class="fields">
        <label>${t('setup.name')}<input name="name" required autocomplete="off" value="${esc(old ? t('setup.newName', { name: old.name }) : '')}"></label>
        <label>${t('setup.ip')}<input name="host" required autocomplete="off"></label>
        <label>${t('setup.rootPass')}<input name="pass" type="password" required autocomplete="off"></label>
        <label>${t('setup.limitTb')}<input name="tb" type="number" min="0.1" step="0.1" value="${esc(tb)}" required></label>
        <label>${t('setup.resetDay')}<input name="resetDay" type="number" min="1" max="31" value="${esc(day)}" required></label>
      </div>
    </fieldset>
    ${wizard.error?.includes(t('prov.incomplete')) ? `<label class="setup-clean"><input type="checkbox" name="clean" checked> ${t('setup.cleanRetry')}</label>` : ''}
    <p class="note">${t('setup.checksNote')}</p>
    <button class="btn setup-start">${t('setup.replaceBtn')}</button>
  </form>`;
}

function setupForm() {
  if (wizard.replaceId) return replaceForm();
  const two = wizard.mode !== 'single';
  const both = wizard.mode === 'both';
  return `<form id="setup-form">
    <div class="setup-modes">
      ${[['single', 'setup.modeSingle'], ['cascade', 'setup.modeCascade'], ['both', 'setup.modeBoth']].map(([m, k]) => `
        <label><input type="radio" name="mode" value="${m}" ${m === wizard.mode ? 'checked' : ''}> ${t(k)}</label>`).join('')}
    </div>
    ${serverFields(0, two ? t('setup.serverN', { n: 1 }) : t('setup.server'))}
    ${two ? serverFields(1, t('setup.serverN', { n: 2 })) : ''}
    ${two ? `<fieldset class="setup-box"><legend>${t('setup.whichEntry')}</legend>
      <div class="setup-modes">
        <label><input type="radio" name="entry" value="0" ${wizard.entry === 0 ? 'checked' : ''}> ${t('setup.serverN', { n: 1 })}</label>
        <label><input type="radio" name="entry" value="1" ${wizard.entry === 1 ? 'checked' : ''}> ${t('setup.serverN', { n: 2 })}</label>
      </div></fieldset>` : ''}
    <fieldset class="setup-box"><legend>${t('setup.ports')}</legend>
      <div class="fields">
        ${portField('XHTTP', 'xhttp', 443)}${portField('Vision', 'vision', 8443)}
        ${both ? `${portField(t('setup.singleXhttp'), 'xhttp2', 2053)}${portField(t('setup.singleVision'), 'vision2', 2083)}` : ''}
        ${two ? portField(t('setup.exitPort'), 'exitPort', 443) : ''}
      </div></fieldset>
    ${wizard.error?.includes(t('prov.incomplete')) ? `<label class="setup-clean"><input type="checkbox" name="clean" checked> ${t('setup.cleanRetry')}</label>` : ''}
    <p class="note">${t('setup.passKept')} ${t('setup.checksNote')}</p>
    <button class="btn setup-start">${t('setup.start')}</button>
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
  const sni = wizard.sni ? `<div class="setup-box"><b>${esc(t('setup.sniPick', { host: wizard.sni.host }))}</b>
    ${wizard.sni.list.length ? wizard.sni.list.map((x, i) => `<label class="sni-row"><input type="radio" name="sni" value="${esc(x.domain)}" ${i === 0 ? 'checked' : ''}> ${esc(x.domain)} <small>${esc(t('setup.ms', { ms: x.ms }))}</small></label>`).join('') : `<p class="empty">${t('setup.sniNone')}</p>`}
    <label class="sni-row">${t('setup.sniCustom')} <input id="sni-custom" autocomplete="off"></label>
    <button class="btn" data-sni-confirm>${t('setup.continue')}</button></div>` : '';
  return `<ul class="steps">${steps}</ul>${sni}`;
}

function setupResult() {
  if (wizard.error) return `<p class="key-msg error">${esc(t('setup.stopped', { err: wizard.error }))}</p>`;
  if (!wizard.keys) return '';
  const subsNote = wizard.subs?.message ? `<p class="key-msg subs-note ${wizard.subs.error ? 'error' : ''}">${esc(wizard.subs.message)}</p>` : '';
  const title = `✓ ${t(wizard.replaceId ? 'setup.replaced' : 'setup.added')}`;
  return `<p class="status ok">${title}</p>${subsNote}
    ${wizard.keys.length ? `<table><tbody>${wizard.keys.map((k, i) => `<tr><td>${esc(k.server)}</td><td>${esc(k.name)}</td><td class="key-actions"><button class="btn" data-setup-key="${i}">${t('setup.linksQr')}</button></td></tr>`).join('')}</tbody></table>` : ''}
    <p class="setup-actions"><button class="btn" data-setup-reset>${t(wizard.replaceId ? 'common.done' : 'setup.addMore')}</button></p>`;
}

function renderSetup() {
  const form = wizard.steps.length && (wizard.running || wizard.keys) ? '' : setupForm();
  $('setup').innerHTML = `<h2>${t(wizard.replaceId ? 'ov.replaceEntry' : 'setup.title')}</h2>${form}${setupProgress()}${setupResult()}`;
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
    } else wizard.error = result.cancelled ? t('common.cancelled') : result.error;
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
  return `<div class="modal-head"><span>${esc(title)}</span><button class="btn" data-modal-close>${t('common.close')}</button></div>`;
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
    openDialog(`${dialogHead(t('pass.title', { name: s.name }))}
      <input id="pass-new" type="password" class="wide" placeholder="${t('pass.new')}" autocomplete="new-password">
      <input id="pass-repeat" type="password" class="wide" placeholder="${t('pass.repeat')}" autocomplete="new-password" style="margin-top:8px">
      <div class="pass-actions">
        <button class="btn" data-pass-generate>${t('pass.generate')}</button>
        <label><input type="checkbox" id="pass-show"> ${t('pass.show')}</label>
      </div>
      <p class="note">${t('pass.note')}</p>
      <p class="key-msg error" id="pass-error"></p>
      <p class="setup-actions"><button class="btn danger" data-pass-save="${esc(s.id)}">${t('ov.changePass')}</button></p>`);
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
      $('pass-error').textContent = t('pass.mismatch');
      return;
    }
    guarded(d.passSave, () => window.api.changePassword(d.passSave, password), t('pass.changed'));
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
    openDialog(`${dialogHead(t('ov.removeSettings'))}
      <p>${t('remove.prompt')} <b>${esc(s.name)}</b></p>
      <input id="remove-name" autocomplete="off" class="wide">
      ${s.managed ? `<label class="setup-clean"><input type="checkbox" id="remove-backup"> ${t('remove.backup')}</label>` : ''}
      <p class="setup-actions"><button class="btn danger" data-confirm-remove="${esc(s.id)}">${t('common.delete')}</button></p>`);
  }
  if (d.confirmRemove) {
    const id = d.confirmRemove;
    const typed = $('remove-name').value;
    const backup = Boolean($('remove-backup')?.checked);
    guarded(id, () => window.api.removeSettings(id, typed, backup), t('remove.done'));
  }
  if (d.replaceEntry) startReplace(d.replaceEntry);
  if (d.closeExit) {
    // Подтверждение спрашивает main (окно Windows), второе окно здесь не нужно.
    const id = d.closeExit;
    try {
      const result = await window.api.closeExitAccess(id);
      // message — пояснение от main (например, что правило уже было закрыто)
      setActionMessage(id, result.cancelled ? '' : `${t('replace.exitClosed')}${result.message ? ` ${result.message}` : ''}`);
    } catch (err) {
      setActionMessage(id, cleanError(err), true);
    }
  }
  if (d.undoReplace) {
    const id = d.undoReplace;
    try {
      const result = await window.api.undoReplace(id);
      const subsNote = result.subs?.message ? ` ${result.subs.message}` : '';
      setActionMessage(id, result.cancelled ? '' : `${t('replace.undone')}${subsNote}`, Boolean(result.subs?.error));
    } catch (err) {
      setActionMessage(id, cleanError(err), true);
    }
  }
  if (d.forget) guarded(d.forget, () => window.api.forgetServer(d.forget), t('admin.forgotten'));
  if (d.removeKey) guarded(s.id, () => window.api.removeAppKey(s.id), t('admin.keyRemoved'));
  if (d.reconnect) {
    openDialog(`${dialogHead(t('admin.reconnectTitle', { name: s.name }))}
      <input id="reconnect-pass" type="password" placeholder="${t('setup.rootPass')}" autocomplete="off" class="wide">
      <p class="setup-actions"><button class="btn" data-confirm-reconnect="${esc(s.id)}">${t('admin.connect')}</button></p>`);
  }
  if (d.confirmReconnect) {
    const password = $('reconnect-pass').value;
    guarded(d.confirmReconnect, () => window.api.reconnect(d.confirmReconnect, password), t('admin.restored'));
  }
  if (d.editLimit) {
    const c = s.limit?.config ?? { tb: 3, resetDay: 1, mode: 'both' };
    const opt = (v, k) => `<option value="${v}" ${c.mode === v ? 'selected' : ''}>${t(k)}</option>`;
    openDialog(`${dialogHead(t('limit.title', { name: s.name }))}
      <div class="fields">
        <label>${t('setup.limitTb')}<input id="limit-tb" type="number" min="0.1" step="0.1" value="${esc(c.tb)}"></label>
        <label>${t('setup.resetDay')}<input id="limit-day" type="number" min="1" max="31" value="${esc(c.resetDay)}"></label>
        <label>${t('limit.count')}<select id="limit-mode">${opt('both', 'limit.both')}${opt('down', 'limit.down')}${opt('up', 'limit.up')}</select></label>
        <label>${t('limit.panel')}<input id="limit-panel" type="number" min="0" step="0.01" placeholder="${t('limit.optional')}"></label>
      </div>
      <p class="note">${esc(t(s.limit?.includesBaseline ? 'limit.usedBaseline' : 'limit.used', { used: s.limit ? formatTb(s.limit.usedBytes) : '—', since: s.limit ? s.limit.periodStart : '—' }))} ${t('limit.panelNote')}</p>
      <p class="setup-actions"><button class="btn" data-save-limit="${esc(s.id)}">${t('common.save')}</button></p>`);
  }
  if (d.saveLimit) {
    const panel = $('limit-panel').value.trim();
    const limit = { tb: Number($('limit-tb').value), resetDay: Number($('limit-day').value), mode: $('limit-mode').value, panelTb: panel === '' ? undefined : Number(panel) };
    guarded(d.saveLimit, () => window.api.setLimit(d.saveLimit, limit), t('limit.saved'));
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
    showLinks(t('keys.keyTitle', { name: k.name }), k.links);
  }
  if ('setupReset' in d) {
    Object.assign(wizard, { steps: [], error: null, keys: null, sni: null, replaceId: null, subs: null });
    renderSetup();
  }
}
