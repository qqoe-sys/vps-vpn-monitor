'use strict';
// Раздел «Подписки»: связь интерфейса с хранилищем подписок и публикацией сайта.
// Любое изменение на сервере идёт только после окна подтверждения (confirmChange).
// Коды ссылок и UUID в сообщения об ошибках не попадают.

const i18n = require('../i18n');
const path = require('node:path');
const { ipcMain } = require('electron');
const subsCfg = require('../core/subs-config');
const { buildSite, subUrl, xhttpKeys } = require('../core/subs-site');
const { publish, install, checkDns, readInventory } = require('../core/subs-publish');

function registerSubsIpc({ getConfig, connect, withInventory, confirmChange, withQr, userData }) {
  const subsFile = path.join(userData, 'subscriptions.json');
  const cacheFile = path.join(userData, 'inventory-cache.json');
  let subs = null;
  let busy = false;

  // Если вход/выход для подписок ещё не выбраны, подставляем первый каскад из списка серверов.
  const load = () => subsCfg.resolveCascade(subs ??= subsCfg.loadSubs(subsFile, i18n.getLang()), getConfig().servers);
  // Флаг pending хранится в файле: после перезапуска программа помнит, что сайт устарел.
  const save = (next, pending = true) => { const s = { ...next, pending }; subsCfg.saveSubs(subsFile, s); subs = s; };

  function server(id) {
    if (id === null) throw new Error(i18n.t('sipc.noCascade'));
    const s = getConfig().servers.find((x) => x.id === id);
    if (!s) throw new Error(i18n.t('sipc.serverNotFound', { id }));
    return s;
  }
  // Пока сайт не установлен (нет домена), можно выбрать вход любого каскада.
  // После установки — только входы, ведущие на тот же выход: сайт живёт на выходе.
  const entries = () => {
    const s = load();
    const servers = getConfig().servers;
    return subsCfg.entryChoices(servers, s.site.domain ? s.site.host : null)
      .map((e) => ({ id: e.id, name: `${e.name} → ${subsCfg.exitOf(servers, e)?.name ?? e.exitHost}` }));
  };

  async function inventory() {
    const entry = server(load().cascade.entry);
    return readInventory({ read: () => withInventory(entry), cacheFile, entryId: entry.id });
  }

  async function exclusive(fn) {
    if (busy) throw new Error(i18n.t('sipc.busy'));
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  async function withTransport(srv, fn) {
    const t = await connect(srv);
    try { return await fn(t); } finally { t.close(); }
  }

  function cacheNote(cachedAt) {
    return cachedAt ? i18n.t('sipc.cacheNote', { when: new Date(cachedAt).toLocaleString(i18n.locale()) }) : '';
  }

  // Публикация целиком: собрать сайт, спросить подтверждение, залить на выход.
  async function publishFlow({ askConfirm = true } = {}) {
    const s = load();
    if (!s.site.domain) return { published: false, message: i18n.t('sipc.needDomain') };
    const exit = server(s.site.host);
    const { inventory: inv, cachedAt } = await inventory();
    const built = await buildSite(s, inv, server(s.cascade.entry));
    if (askConfirm && !(await confirmChange(
      i18n.t('sipc.publishQ', { name: exit.name }),
      `${i18n.t('sipc.publishDetail', { n: s.people.length })} ${cacheNote(cachedAt)}`,
      i18n.t('sipc.title'),
    ))) return { published: false, cancelled: true, message: i18n.t('sipc.publishCancelled') };
    await withTransport(exit, (t) => publish(t, built));
    save(load(), false);
    return { published: true, message: `${i18n.t('sipc.published')} ${cacheNote(cachedAt)}`.trim() };
  }

  // После изменения сразу предлагаем опубликовать; отказ не отменяет локальное изменение.
  async function changeAndPublish(next) {
    save(next);
    try {
      return await publishFlow();
    } catch (err) {
      return { published: false, error: true, message: i18n.t('sipc.savedNotPublished', { err: err.message }) };
    }
  }

  ipcMain.handle('subs:get', async () => {
    const s = load();
    let keys = [];
    let warning = '';
    try {
      const { inventory: inv, cachedAt } = await inventory();
      keys = xhttpKeys(inv);
      warning = cacheNote(cachedAt);
    } catch (err) {
      warning = err.message;
    }
    return {
      subs: s,
      entries: entries(),
      freeKeys: subsCfg.freeKeys(keys, s),
      liveKeys: keys,
      links: Object.fromEntries(s.people.map((p) => [p.id, s.site.domain ? subUrl(s, p.token) : null])),
      pending: !!s.pending,
      warning,
    };
  });

  ipcMain.handle('subs:add', (_e, name, key) => exclusive(async () => {
    const { inventory: inv } = await inventory();
    if (!xhttpKeys(inv).includes(key)) throw new Error(i18n.t('sipc.noXhttpKey', { key }));
    return changeAndPublish(subsCfg.addPerson(load(), name, key));
  }));

  ipcMain.handle('subs:reissue', (_e, id) => exclusive(async () => {
    const p = load().people.find((x) => x.id === id);
    if (!p) throw new Error(i18n.t('sipc.personNotFound'));
    if (!(await confirmChange(i18n.t('sipc.reissueQ', { name: p.name }), i18n.t('sipc.reissueDetail'), i18n.t('sipc.title')))) return { cancelled: true };
    return changeAndPublish(subsCfg.reissue(load(), id));
  }));

  ipcMain.handle('subs:remove', (_e, id) => exclusive(async () => {
    const p = load().people.find((x) => x.id === id);
    if (!p) throw new Error(i18n.t('sipc.personNotFound'));
    if (!(await confirmChange(i18n.t('sipc.removeQ', { name: p.name }), i18n.t('sipc.removeDetail'), i18n.t('sipc.title')))) return { cancelled: true };
    return changeAndPublish(subsCfg.removePerson(load(), id));
  }));

  ipcMain.handle('subs:settings', (_e, form) => exclusive(async () => {
    const s = load();
    if (form.entry === null) throw new Error(i18n.t('sipc.noCascade'));
    if (!entries().some((e) => e.id === form.entry)) throw new Error(i18n.t('sipc.entryMismatch'));
    const exit = subsCfg.exitOf(getConfig().servers, server(form.entry));
    const next = {
      ...s,
      site: {
        ...s.site,
        host: exit.id,
        domain: form.domain ? String(form.domain).trim().toLowerCase() : null,
        port: Number(form.port),
        title: String(form.title ?? '').trim(),
        updateHours: Number(form.updateHours),
      },
      cascade: { entry: form.entry, exit: exit.id },
    };
    return changeAndPublish(subsCfg.switchSiteLang(next, form.lang));
  }));

  ipcMain.handle('subs:apps', (_e, apps) => exclusive(async () => changeAndPublish({ ...load(), apps })));

  ipcMain.handle('subs:publish', () => exclusive(() => publishFlow()));

  ipcMain.handle('subs:install', () => exclusive(async () => {
    const s = load();
    if (!s.site.domain) throw new Error(i18n.t('sipc.domainFirst'));
    const exit = server(s.site.host);
    await checkDns(s.site.domain, exit.host);
    if (!(await confirmChange(
      i18n.t('sipc.installQ', { name: exit.name }),
      i18n.t('sipc.installDetail', { port: s.site.port }),
      i18n.t('sipc.title'),
    ))) return { cancelled: true };
    await withTransport(exit, (t) => install(t, s.site.port));
    return publishFlow({ askConfirm: false });
  }));

  ipcMain.handle('subs:qr', async (_e, url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(i18n.t('sipc.badUrl'));
    return (await withQr([{ label: 'sub', url }]))[0].qr;
  });

  // Для мастера замены входа: какой вход сейчас у подписок и переключение на новый.
  return {
    currentEntry: () => load().cascade.entry,
    // Для «Закрыть доступ на выходе»: куда ведут подписки и есть ли неопубликованные изменения.
    state: () => ({ entry: load().cascade.entry, pending: Boolean(load().pending), inUse: Boolean(load().site.domain) }),
    // Сохраняем новый вход (выход и сайт прежние), затем обычная публикация с окном подтверждения.
    // Отказ или сбой публикации не отменяет сохранения: сайт можно опубликовать позже.
    switchEntry: (newId) => exclusive(async () => {
      const s = load();
      return changeAndPublish({ ...s, cascade: { entry: newId, exit: s.site.host } });
    }),
  };
}

module.exports = { registerSubsIpc };
