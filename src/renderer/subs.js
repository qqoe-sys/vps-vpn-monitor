'use strict';
// Раздел «Подписки»: люди и их личные ссылки, настройки сайта, инструкции по приложениям.
// Использует esc, $, cleanError из app.js. Все изменения уходят в главный процесс,
// а он перед публикацией на сервер показывает окно подтверждения.

const subsState = { data: null, msg: null, busy: false };
const OS_NAMES = { android: 'Android', ios: 'iOS', windows: 'Windows', linux: 'Linux' };

function subsMessage() {
  const m = subsState.msg;
  return m ? `<p class="key-msg ${m.error ? 'error' : ''}">${esc(m.text)}</p>` : '';
}

function peopleTable(d) {
  if (!d.subs.people.length) return '<p class="empty">Пока никого нет. Добавь человека и выбери ему ключ.</p>';
  const live = new Set(d.liveKeys);
  return `<table><thead><tr><th>Имя</th><th>Ключ</th><th>Ссылка</th><th></th></tr></thead><tbody>
    ${d.subs.people.map((p) => {
    const url = d.links[p.id];
    const missing = d.liveKeys.length && !live.has(p.key);
    return `<tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.key)}${missing ? '<span class="tag-deleted">нет на входе</span>' : ''}</td>
      <td>${url ? `<button class="btn" data-copy="${esc(url)}">Копировать</button> <button class="btn" data-subs-qr="${esc(url)}" data-subs-name="${esc(p.name)}">QR</button>` : '<span class="source">нужен домен</span>'}</td>
      <td class="key-actions">
        <button class="btn" data-subs-reissue="${esc(p.id)}">Перевыпустить</button>
        <button class="btn" data-subs-remove="${esc(p.id)}">Удалить</button>
      </td></tr>`;
  }).join('')}</tbody></table>`;
}

function siteForm(d) {
  const { site, cascade } = d.subs;
  return `<form class="setup-box" data-subs-settings>
    <div class="fields">
      <label>Домен<input name="domain" value="${esc(site.domain ?? '')}" placeholder="example.ru" autocomplete="off"></label>
      <label>Порт<input name="port" type="number" min="1" max="65535" value="${site.port}"></label>
      <label>Название в Happ<input name="title" maxlength="40" value="${esc(site.title)}"></label>
      <label>Обновлять, ч<input name="updateHours" type="number" min="1" max="168" value="${site.updateHours}"></label>
      <label>Вход каскада${d.entries.length
    ? `<select name="entry">${d.entries.map((e) => `<option value="${esc(e.id)}" ${e.id === cascade.entry ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`
    : '<span class="source">нет каскада — добавь вход и выход</span>'}</label>
    </div>
    <div class="setup-actions">
      <button class="btn">Сохранить</button>
      <button class="btn" type="button" data-subs-install>Установить сайт на сервер</button>
      <button class="btn" type="button" data-subs-publish>Опубликовать</button>
    </div>
  </form>`;
}

function appsForm(apps) {
  return `<form class="setup-box" data-subs-apps>
    ${Object.entries(OS_NAMES).map(([os, label]) => `<fieldset class="setup-box"><legend>${label}</legend>
      <div class="fields">
        <label>Приложение<input name="${os}-name" value="${esc(apps[os].name)}" maxlength="40"></label>
        <label>Ссылка (https://)<input name="${os}-url" value="${esc(apps[os].url)}"></label>
      </div>
      <label>Шаги, по одному в строке<textarea name="${os}-steps" rows="3">${esc(apps[os].steps.join('\n'))}</textarea></label>
    </fieldset>`).join('')}
    <div class="setup-actions"><button class="btn">Сохранить инструкции</button></div>
  </form>`;
}

function renderSubs() {
  const d = subsState.data;
  if (!d) { $('subs').innerHTML = '<h2>Подписки</h2><p class="empty">Загрузка…</p>'; return; }
  $('subs').innerHTML = `<h2>Подписки</h2>
    ${subsMessage()}
    ${d.pending ? '<p class="key-msg error">Есть неопубликованные изменения.</p>' : ''}
    ${d.warning ? `<p class="key-msg error">${esc(d.warning)}</p>` : ''}
    <article class="card">
      <div class="card-title">Люди</div>
      <form class="key-form" data-subs-add>
        <input name="name" placeholder="Имя" maxlength="40" autocomplete="off" aria-label="Имя">
        <select name="key" aria-label="Ключ">${d.freeKeys.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
        <button class="btn" ${d.freeKeys.length && !subsState.busy ? '' : 'disabled'}>Добавить</button>
      </form>
      ${peopleTable(d)}
    </article>
    <article class="card"><div class="card-title">Сайт</div>${siteForm(d)}
      <p class="note">Ссылка у человека не меняется, пока ты её не перевыпустишь. При смене входа Happ подтянет новый ключ сам.</p>
    </article>
    <article class="card"><div class="card-title">Приложения на странице</div>${appsForm(d.subs.apps)}</article>`;
}

async function refreshSubs() {
  try {
    subsState.data = await window.api.subsGet();
  } catch (err) {
    subsState.msg = { text: cleanError(err), error: true };
  }
  if (ui.view === 'subs') renderSubs();
}

async function subsOperation(pendingText, fn) {
  if (subsState.busy) return;
  subsState.busy = true;
  subsState.msg = { text: pendingText };
  renderSubs();
  try {
    const r = await fn();
    subsState.msg = r?.cancelled && !r.message ? null : { text: r?.message ?? 'Готово', error: !!r?.error };
  } catch (err) {
    subsState.msg = { text: cleanError(err), error: true };
  } finally {
    subsState.busy = false;
  }
  await refreshSubs();
}

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.matches('[data-subs-add]')) {
    e.preventDefault();
    const name = f.elements.name.value.trim();
    if (!name) return;
    subsOperation(`Добавляю ${name}…`, () => window.api.subsAdd(name, f.elements.key.value));
  } else if (f.matches('[data-subs-settings]')) {
    e.preventDefault();
    const v = (n) => f.elements[n].value.trim();
    subsOperation('Сохраняю настройки…', () => window.api.subsSettings({
      domain: v('domain') || null, port: Number(v('port')), title: v('title'), updateHours: Number(v('updateHours')), entry: v('entry'),
    }));
  } else if (f.matches('[data-subs-apps]')) {
    e.preventDefault();
    const apps = Object.fromEntries(Object.keys(OS_NAMES).map((os) => [os, {
      name: f.elements[`${os}-name`].value.trim(),
      url: f.elements[`${os}-url`].value.trim(),
      steps: f.elements[`${os}-steps`].value.split('\n').map((s) => s.trim()).filter(Boolean),
    }]));
    subsOperation('Сохраняю инструкции…', () => window.api.subsApps(apps));
  }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el || subsState.busy) return;
  const d = el.dataset;
  if (d.subsReissue) subsOperation('Перевыпускаю ссылку…', () => window.api.subsReissue(d.subsReissue));
  if (d.subsRemove) subsOperation('Удаляю…', () => window.api.subsRemove(d.subsRemove));
  if ('subsPublish' in d) subsOperation('Публикую сайт…', () => window.api.subsPublish());
  if ('subsInstall' in d) subsOperation('Устанавливаю сайт на сервер (до пары минут)…', () => window.api.subsInstall());
  if (d.subsQr) {
    window.api.subsQr(d.subsQr)
      .then((qr) => showLinks(`Подписка: ${d.subsName}`, [{ label: 'Ссылка-подписка', url: d.subsQr, qr }]))
      .catch((err) => { subsState.msg = { text: cleanError(err), error: true }; renderSubs(); });
  }
});
