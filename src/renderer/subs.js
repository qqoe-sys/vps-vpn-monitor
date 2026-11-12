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
  if (!d.subs.people.length) return `<p class="empty">${t('subs.nobody')}</p>`;
  const live = new Set(d.liveKeys);
  return `<table><thead><tr><th>${t('subs.colName')}</th><th>${t('keys.colKey')}</th><th>${t('subs.colLink')}</th><th></th></tr></thead><tbody>
    ${d.subs.people.map((p) => {
    const url = d.links[p.id];
    const missing = d.liveKeys.length && !live.has(p.key);
    return `<tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.key)}${missing ? `<span class="tag-deleted">${t('subs.missing')}</span>` : ''}</td>
      <td>${url ? `<button class="btn" data-copy="${esc(url)}">${t('subs.copy')}</button> <button class="btn" data-subs-qr="${esc(url)}" data-subs-name="${esc(p.name)}">QR</button>` : `<span class="source">${t('subs.needDomain')}</span>`}</td>
      <td class="key-actions">
        <button class="btn" data-subs-reissue="${esc(p.id)}">${t('subs.reissue')}</button>
        <button class="btn" data-subs-remove="${esc(p.id)}">${t('common.delete')}</button>
      </td></tr>`;
  }).join('')}</tbody></table>`;
}

function siteForm(d) {
  const { site, cascade } = d.subs;
  return `<form class="setup-box" data-subs-settings>
    <div class="fields">
      <label>${t('subs.domain')}<input name="domain" value="${esc(site.domain ?? '')}" placeholder="example.ru" autocomplete="off"></label>
      <label>${t('subs.port')}<input name="port" type="number" min="1" max="65535" value="${site.port}"></label>
      <label>${t('subs.title')}<input name="title" maxlength="40" value="${esc(site.title)}"></label>
      <label>${t('subs.updateHours')}<input name="updateHours" type="number" min="1" max="168" value="${site.updateHours}"></label>
      <label>${t('subs.entry')}${d.entries.length
    ? `<select name="entry">${d.entries.map((e) => `<option value="${esc(e.id)}" ${e.id === cascade.entry ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`
    : `<span class="source">${t('subs.noCascade')}</span>`}</label>
      <label>${t('subs.siteLang')}<select name="lang">${I18N.LANGS.map((l) => `<option value="${l}" ${l === (site.lang ?? 'ru') ? 'selected' : ''}>${t(`lang.${l}`)}</option>`).join('')}</select></label>
    </div>
    <div class="setup-actions">
      <button class="btn">${t('common.save')}</button>
      <button class="btn" type="button" data-subs-install>${t('subs.install')}</button>
      <button class="btn" type="button" data-subs-publish>${t('subs.publish')}</button>
    </div>
  </form>`;
}

function appsForm(apps) {
  return `<form class="setup-box" data-subs-apps>
    ${Object.entries(OS_NAMES).map(([os, label]) => `<fieldset class="setup-box"><legend>${label}</legend>
      <div class="fields">
        <label>${t('subs.app')}<input name="${os}-name" value="${esc(apps[os].name)}" maxlength="40"></label>
        <label>${t('subs.appUrl')}<input name="${os}-url" value="${esc(apps[os].url)}"></label>
      </div>
      <label>${t('subs.steps')}<textarea name="${os}-steps" rows="3">${esc(apps[os].steps.join('\n'))}</textarea></label>
    </fieldset>`).join('')}
    <div class="setup-actions"><button class="btn">${t('subs.saveApps')}</button></div>
  </form>`;
}

function renderSubs() {
  const d = subsState.data;
  if (!d) { $('subs').innerHTML = `<h2>${t('nav.subs')}</h2><p class="empty">${t('subs.loading')}</p>`; return; }
  $('subs').innerHTML = `<h2>${t('nav.subs')}</h2>
    ${subsMessage()}
    ${d.pending ? `<p class="key-msg error">${t('subs.pending')}</p>` : ''}
    ${d.warning ? `<p class="key-msg error">${esc(d.warning)}</p>` : ''}
    <article class="card">
      <div class="card-title">${t('subs.people')}</div>
      <form class="key-form" data-subs-add>
        <input name="name" placeholder="${t('subs.colName')}" maxlength="40" autocomplete="off" aria-label="${t('subs.colName')}">
        <select name="key" aria-label="${t('keys.colKey')}">${d.freeKeys.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
        <button class="btn" ${d.freeKeys.length && !subsState.busy ? '' : 'disabled'}>${t('subs.add')}</button>
      </form>
      ${peopleTable(d)}
    </article>
    <article class="card"><div class="card-title">${t('subs.site')}</div>${siteForm(d)}
      <p class="note">${t('subs.siteNote')}</p>
    </article>
    <article class="card"><div class="card-title">${t('subs.apps')}</div>${appsForm(d.subs.apps)}</article>`;
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
    subsState.msg = r?.cancelled && !r.message ? null : { text: r?.message ?? t('common.done'), error: !!r?.error };
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
    subsOperation(t('keys.adding', { name }), () => window.api.subsAdd(name, f.elements.key.value));
  } else if (f.matches('[data-subs-settings]')) {
    e.preventDefault();
    const v = (n) => f.elements[n].value.trim();
    subsOperation(t('subs.savingSettings'), () => window.api.subsSettings({
      domain: v('domain') || null, port: Number(v('port')), title: v('title'), updateHours: Number(v('updateHours')), entry: f.elements.entry ? v('entry') : null, lang: v('lang'),
    }));
  } else if (f.matches('[data-subs-apps]')) {
    e.preventDefault();
    const apps = Object.fromEntries(Object.keys(OS_NAMES).map((os) => [os, {
      name: f.elements[`${os}-name`].value.trim(),
      url: f.elements[`${os}-url`].value.trim(),
      steps: f.elements[`${os}-steps`].value.split('\n').map((s) => s.trim()).filter(Boolean),
    }]));
    subsOperation(t('subs.savingApps'), () => window.api.subsApps(apps));
  }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el || subsState.busy) return;
  const d = el.dataset;
  if (d.subsReissue) subsOperation(t('subs.reissuing'), () => window.api.subsReissue(d.subsReissue));
  if (d.subsRemove) subsOperation(t('subs.removing'), () => window.api.subsRemove(d.subsRemove));
  if ('subsPublish' in d) subsOperation(t('subs.publishing'), () => window.api.subsPublish());
  if ('subsInstall' in d) subsOperation(t('subs.installing'), () => window.api.subsInstall());
  if (d.subsQr) {
    window.api.subsQr(d.subsQr)
      .then((qr) => showLinks(t('subs.qrTitle', { name: d.subsName }), [{ label: t('subs.qrLabel'), url: d.subsQr, qr }]))
      .catch((err) => { subsState.msg = { text: cleanError(err), error: true }; renderSubs(); });
  }
});
