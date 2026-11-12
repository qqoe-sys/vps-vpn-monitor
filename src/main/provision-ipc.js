'use strict';
// Мастер настройки серверов и удаление настроек: связь интерфейса с шагами установки.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dialog, ipcMain } = require('electron');
const { utils } = require('ssh2');
const { connect } = require('./ssh-transport');
const { runSteps } = require('../core/provision/runner');
const { runDetached } = require('../core/provision/remote-run');
const { buildSteps, closeAll, py, b64 } = require('../core/provision/steps');
const { validatePlan, serverIdFor } = require('../core/provision/validate');
const { buildReplaceSteps, makeReplacePlan } = require('../core/replace/steps');
const { pickClients } = require('../core/replace/source');
const { loadInventoryCache } = require('../core/subs-publish');
const { withPanelUsage } = require('../core/limits');
const { assertCanDropAppKey } = require('../core/server-actions');
const { readKeys, linksFor } = require('../core/xray-keys');
const {
  addServers, removeServer, markReplaced, exitAccessDeleteCommand, clearReplacedBy, undoReplace, canCloseExitAccess,
} = require('../core/app-config');

const REMOVE_SCRIPT = path.join(__dirname, '../../server/provision/remove.py');
const EXIT_LINK_SCRIPT = path.join(__dirname, '../../server/replace/exit-link.py');
const LIVE_INVENTORY_MS = 20000; // сколько ждём ответа старого входа, потом берём снимок

async function runRemove(connectFn, server, flags) {
  const keyRemoved = flags.includes('app-key');
  const { text, assumed } = await runDetached(connectFn, server, fs.readFileSync(REMOVE_SCRIPT, 'utf8'), flags, { keyRemoved });
  if (!assumed && !text.includes('"removed"')) throw new Error('Сервер не смог выполнить удаление');
}

function registerProvisionIpc(app) {
  const { send, win, getConfig, setConfig, addMonitor, dropMonitor, userData, withQr, withInventory, confirmChange, subs } = app;
  const cacheFile = path.join(userData, 'inventory-cache.json');
  let running = false;
  let pendingSni = null;

  const askHostKey = (host) => async (fp) => {
    const { response } = await dialog.showMessageBox(win(), {
      type: 'question',
      buttons: ['Отмена', 'Доверять'],
      defaultId: 1,
      cancelId: 0,
      title: 'Новый сервер',
      message: `Подключиться к ${host}?`,
      detail: `Отпечаток сервера:\n${fp}\n\nОн будет запомнен: при подмене сервера программа откажется подключаться.`,
    });
    return response === 1;
  };

  const keyAuth = (server) => connect({ host: server.host, user: 'root', keyPath: server.keyPath });

  async function keysFor(servers) {
    const result = [];
    for (const server of servers.filter((s) => s.statsPort)) {
      const transport = await keyAuth(server);
      try {
        const inv = await readKeys(transport);
        for (const k of inv.keys) {
          result.push({ server: server.name, name: k.name, links: await withQr(linksFor(server, inv, k.name)) });
        }
      } finally {
        transport.close();
      }
    }
    return result;
  }

  ipcMain.on('provision:sni', (_e, domain) => {
    pendingSni?.(typeof domain === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(domain) ? domain : null);
    pendingSni = null;
  });

  // Окружение шагов мастера: общее у настройки серверов и замены входа.
  // secrets — пароли, которые runner вычищает из ошибок и прогресса.
  function makeCtx(secrets) {
    return {
      connect: (t, auth) => connect(
        { host: t.host, user: 'root', keyPath: auth.keyPath },
        { password: auth.password, onHostKey: askHostKey(t.host) },
      ),
      makeKey: () => {
        const k = utils.generateKeyPairSync('ed25519', { comment: 'vpsmon' });
        return { private: k.private, public: k.public.trim() };
      },
      saveKey: (id, priv) => {
        const dir = path.join(userData, 'keys');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}_ed25519`);
        fs.writeFileSync(file, priv, { mode: 0o600 });
        return file;
      },
      chooseSni: (t, list) => new Promise((resolve) => {
        pendingSni = resolve;
        send('provision:choose-sni', { host: t.host, list });
      }),
      uuid: () => crypto.randomUUID(),
      randomHex: (bytes) => crypto.randomBytes(bytes).toString('hex'),
      secrets,
      deleteKey: (id) => fs.rmSync(path.join(userData, 'keys', `${id}_ed25519`), { force: true }),
    };
  }

  const progress = (e) => send('provision:progress', e);

  ipcMain.handle('provision:start', async (_e, plan) => {
    if (running) throw new Error('Настройка уже идёт');
    validatePlan(plan);
    for (const t of plan.targets) t.id = serverIdFor(t.host);
    addServers(getConfig(), plan.targets); // заранее отказывает, если сервер уже добавлен

    running = true;
    const ctx = makeCtx(plan.targets.map((t) => t.password));

    try {
      const result = await runSteps(buildSteps(plan), ctx, progress);
      if (!result.ok) return result;
      setConfig(addServers(getConfig(), ctx.result.servers));
      ctx.result.servers.forEach(addMonitor);
      return { ok: true, keys: await keysFor(ctx.result.servers) };
    } finally {
      closeAll(plan);
      for (const t of plan.targets) t.password = null;
      running = false;
    }
  });

  // Живой список клиентов со старого входа; null, если он не ответил за LIVE_INVENTORY_MS.
  async function liveInventory(old) {
    if (old.noAccess) return null;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), LIVE_INVENTORY_MS); });
    try {
      return await Promise.race([withInventory(old).catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Замена входа: новый VPS получает тех же клиентов и подключается к тому же выходу.
  ipcMain.handle('provision:replace', async (_e, oldId, form) => {
    if (running) throw new Error('Настройка уже идёт');
    const old = findServer(oldId);
    const target = { host: form?.host, password: form?.password, name: String(form?.name ?? '').trim(), limit: form?.limit };
    // Форма проверяется теми же правилами, что в мастере. Порты здесь не задаются (их берём
    // со старого входа), поэтому для проверки подставлены роль выхода и порт 443.
    validatePlan({ targets: [{ ...target, role: 'exit', ports: { exit: 443 } }] });
    target.id = serverIdFor(target.host);
    // Всухую: отказ для выхода, уже заменённого входа или адреса, который уже есть в программе.
    markReplaced(getConfig(), oldId, { id: target.id, host: target.host });
    const exit = getConfig().servers.find((s) => s.host === old.exitHost);
    if (!exit) throw new Error(`Выход ${old.exitHost} не найден в программе`);

    running = true;
    try {
      const picked = pickClients({ live: await liveInventory(old), cache: loadInventoryCache(cacheFile, old.id) });
      if (picked.stale && !(await confirmChange(
        'Старый вход не отвечает, а копия клиентов устарела',
        `Копия списка клиентов сохранена ${new Date(picked.savedAt).toLocaleString('ru-RU')}. Ключи, добавленные позже, на новый вход не попадут. Продолжить с этой копией?`,
        'Замена входа',
      ))) return { cancelled: true };
      const plan = makeReplacePlan({ target, old, exit, picked, cleanIncomplete: form?.cleanIncomplete });

      const ctx = makeCtx([target.password]);
      const result = await runSteps(buildReplaceSteps(plan), ctx, progress);
      if (!result.ok) return result;
      const server = ctx.result.server;
      setConfig(markReplaced(getConfig(), oldId, server));
      addMonitor(server);
      // Старый вход остаётся в списке: перезапускаем его монитор, чтобы страница увидела replacedBy.
      dropMonitor(oldId);
      addMonitor(findServer(oldId));
      // Подписки переключаем, только если они вели на заменённый вход.
      let subsResult = null;
      if (subs.currentEntry() === oldId) {
        try {
          subsResult = await subs.switchEntry(server.id);
        } catch (err) {
          subsResult = { published: false, error: true, message: `Подписки не переключены: ${err.message}` };
        }
      }
      return { ok: true, keys: await keysFor([server]), subs: subsResult };
    } finally {
      target.password = null;
      if (form) form.password = null;
      running = false;
    }
  });

  const findServer = (id) => {
    const server = getConfig().servers.find((s) => s.id === id);
    if (!server) throw new Error('Неизвестный сервер');
    return server;
  };

  // Пока мастер работает, он держит записи серверов: менять список под ним нельзя.
  const assertIdle = () => {
    if (running) throw new Error('Сейчас идёт настройка или замена сервера: дождись её окончания');
  };

  // Сервер id убран из программы: снимаем пометку «заменён» со старых входов, которые на него
  // указывали, и перезапускаем их мониторы, чтобы страница это увидела.
  function dropFromConfig(id) {
    const affected = getConfig().servers.filter((s) => s.replacedBy === id).map((s) => s.id);
    setConfig(clearReplacedBy(removeServer(getConfig(), id), id));
    for (const oldId of affected) {
      dropMonitor(oldId);
      addMonitor(findServer(oldId));
    }
  }

  async function confirm(message, detail) {
    const { response } = await dialog.showMessageBox(win(), {
      type: 'warning', buttons: ['Отмена', 'Да, удалить'], defaultId: 0, cancelId: 0, title: 'Удаление', message, detail,
    });
    return response === 1;
  }

  async function saveConfigBackup(server, transport) {
    const out = await transport.exec('cat "$(systemctl show xray -p ExecStart --value | grep -oE \'/[^ ;]*config.json\' | head -1)"', 15000);
    const { canceled, filePath } = await dialog.showSaveDialog(win(), { title: 'Бэкап конфига Xray', defaultPath: `xray-${server.id}.json` });
    if (!canceled && filePath) fs.writeFileSync(filePath, out, { mode: 0o600 });
  }

  ipcMain.handle('server:remove-settings', async (_e, id, typedName, wantBackup) => {
    assertIdle();
    const server = findServer(id);
    if (typedName !== server.name) throw new Error('Имя сервера введено неверно');
    if (server.managed) assertCanDropAppKey(app.getState(id));
    const related = getConfig().servers.find((s) => s.exitHost === server.host || server.exitHost === s.host);
    const scope = server.managed
      ? 'Будут удалены Xray, ключи VPN, учёт трафика и правила файрвола для VPN. Вход по паролю останется.'
      : 'Этот сервер настраивался вручную: будет удалён только сборщик трафика и его история. Xray и ключи останутся.';
    const cascadeNote = server.managed && related ? `\n\nКаскад с ${related.name} перестанет работать.` : '';
    if (!(await confirm('Вы точно хотите удалить все настройки?', `${server.name}. ${scope}${cascadeNote}`))) return { cancelled: true };
    if (wantBackup && server.managed) {
      const transport = await keyAuth(server);
      try {
        await saveConfigBackup(server, transport);
      } finally {
        transport.close();
      }
    }
    await runRemove(keyAuth, server, server.managed ? '--drop-app-key' : '');
    if (server.managed) {
      dropMonitor(id);
      dropFromConfig(id);
    }
    return { removed: true, managed: Boolean(server.managed) };
  });

  ipcMain.handle('server:remove-app-key', async (_e, id) => {
    const server = findServer(id);
    if (!server.managed) throw new Error('У этого сервера ключ управляется вручную');
    assertCanDropAppKey(app.getState(id));
    if (!(await confirm('Удалить ключ доступа приложения?', `${server.name}. Вход по паролю останется. Программа перестанет видеть сервер, пока ты не подключишь его снова.`))) return { cancelled: true };
    await runRemove(keyAuth, server, '--only-app-key');
    dropMonitor(id);
    const updated = { ...server, noAccess: true };
    setConfig({ ...getConfig(), servers: getConfig().servers.map((s) => (s.id === id ? updated : s)) });
    addMonitor(updated);
    return { done: true };
  });

  // Запасной выход: сервер недоступен, но запись в программе больше не нужна. На сервер не ходит.
  ipcMain.handle('server:forget', async (_e, id) => {
    assertIdle();
    const server = findServer(id);
    // Заменённый вход тоже можно убрать: его клиенты уже на новом входе.
    if (!server.managed && !server.replacedBy) throw new Error('Нынешние серверы так убрать нельзя');
    if (!(await confirm(`Убрать ${server.name} из программы?`, 'На самом сервере ничего не изменится: настройки и ключ приложения останутся там.'))) return { cancelled: true };
    dropMonitor(id);
    dropFromConfig(id);
    return { done: true };
  });

  // Заменённый вход больше не нужен выходу: убираем правило UFW, которое пускало его на звено.
  ipcMain.handle('server:close-exit-access', async (_e, id) => {
    const old = findServer(id);
    // Нельзя, пока подписки ведут на старый вход или новый вход в них не опубликован.
    const subsState = subs.state();
    const allowed = canCloseExitAccess({ server: old, subsEntry: subsState.entry, subsPending: subsState.pending, subsInUse: subsState.inUse });
    if (!allowed.ok) throw new Error(allowed.reason);
    const exit = getConfig().servers.find((s) => s.host === old.exitHost);
    if (!exit?.keyPath) throw new Error('Выход не найден в программе или у него нет ключа доступа');
    exitAccessDeleteCommand(old.host, 1); // адрес проверяем ещё до окна подтверждения
    if (!(await confirmChange(
      `Закрыть доступ ${old.name} на ${exit.name}?`,
      `На выходе будет удалено правило UFW, которое пускает ${old.host} на порт звена. Xray выхода не перезапускается. Старый вход перестанет выводить клиентов в интернет.`,
      'Замена входа',
    ))) return { cancelled: true };
    const transport = await keyAuth(exit);
    try {
      // Порт звена читаем с выхода. Скрипт печатает и UUID звена, но из этой функции он не выходит.
      const out = await py({ transport }, fs.readFileSync(EXIT_LINK_SCRIPT, 'utf8'), [b64(JSON.stringify({ entryHost: old.host }))], 60000);
      let port = null;
      try { port = JSON.parse(out.trim().split('\n').pop()).port; } catch { /* ниже — понятная ошибка про порт */ }
      const command = exitAccessDeleteCommand(old.host, port);
      // Так правило выглядит в `ufw show added`: удаляем, только если оно есть.
      const rule = command.replace(/^ufw delete /, 'ufw ');
      const res = await transport.exec(`if ufw show added | grep -qxF '${rule}'; then ${command} >/dev/null 2>&1 && echo '@@removed'; else echo '@@absent'; fi`, 30000);
      if (res.includes('@@absent')) return { done: true, message: 'Правила для старого входа на выходе уже нет.' };
      if (!res.includes('@@removed')) throw new Error('Не удалось удалить правило на выходе');
      return { done: true, message: 'Доступ старому входу на выходе закрыт.' };
    } finally {
      transport.close();
    }
  });

  // «Отменить замену»: старый вход снова действующий. Новый вход остаётся в списке обычным входом
  // (его можно потом удалить «Удалить настройки» или убрать из программы). На серверы не ходит.
  ipcMain.handle('server:undo-replace', async (_e, oldId) => {
    assertIdle();
    const old = findServer(oldId);
    const { newId } = undoReplace(getConfig(), oldId); // всухую: отказ, если вход не заменён
    const newName = getConfig().servers.find((s) => s.id === newId)?.name ?? newId;
    const subsOnNew = subs.currentEntry() === newId;
    if (!(await confirmChange(
      `Отменить замену ${old.name}?`,
      `${old.name} снова станет действующим входом, ${newName} останется в списке обычным входом. Если доступ старому входу на выходе уже закрыт, клиенты через него не пойдут.${subsOnNew ? ' Подписки будут переключены обратно на старый вход (с подтверждением публикации).' : ''}`,
      'Замена входа',
    ))) return { cancelled: true };
    setConfig(undoReplace(getConfig(), oldId).config); // заново от текущего конфига: он мог измениться, пока ждали ответа
    dropMonitor(oldId);
    addMonitor(findServer(oldId));
    let subsResult = null;
    if (subs.currentEntry() === newId) {
      try {
        subsResult = await subs.switchEntry(oldId);
      } catch (err) {
        subsResult = { published: false, error: true, message: `Подписки не переключены: ${err.message}` };
      }
    }
    return { done: true, subs: subsResult };
  });

  ipcMain.handle('server:reconnect', async (_e, id, password) => {
    const server = findServer(id);
    if (typeof password !== 'string' || !password) throw new Error('Введи пароль');
    const parsed = utils.parseKey(fs.readFileSync(server.keyPath));
    const line = `${parsed.type} ${parsed.getPublicSSH().toString('base64')} vpsmon`;
    const transport = await connect({ host: server.host, user: 'root' }, { password, onHostKey: askHostKey(server.host) });
    try {
      const script = Buffer.from(`touch /root/.ssh/authorized_keys
[ -z "$(tail -c1 /root/.ssh/authorized_keys)" ] || echo >> /root/.ssh/authorized_keys
grep -qxF '${line}' /root/.ssh/authorized_keys || echo '${line}' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
`).toString('base64');
      const out = await transport.exec(`echo ${script} | base64 -d | bash 2>&1; echo "@@rc=$?"`, 20000);
      if (!/@@rc=0\s*$/.test(out)) throw new Error('Не удалось вернуть ключ');
    } finally {
      transport.close();
    }
    dropMonitor(id);
    const { noAccess, ...updated } = server;
    void noAccess;
    setConfig({ ...getConfig(), servers: getConfig().servers.map((s) => (s.id === id ? updated : s)) });
    addMonitor(updated);
    return { done: true };
  });

  ipcMain.handle('limits:set', (_e, id, limit) => {
    if (!(limit?.tb > 0) || !Number.isInteger(limit.resetDay) || limit.resetDay < 1 || limit.resetDay > 31 || !['both', 'down', 'up'].includes(limit.mode)) {
      throw new Error('Некорректный лимит');
    }
    const server = findServer(id);
    const core = { tb: limit.tb, resetDay: limit.resetDay, mode: limit.mode };
    // Цифра из панели необязательна: без неё остаётся прежняя поправка.
    const { adjustBytes, adjustPeriod } = server.limit ?? {};
    const next = Number.isFinite(limit.panelTb) && limit.panelTb >= 0
      ? withPanelUsage(core, app.getTrafficRecord(id), limit.panelTb)
      : { ...core, ...(adjustPeriod ? { adjustBytes, adjustPeriod } : {}) };
    const updated = { ...server, limit: next };
    setConfig({ ...getConfig(), servers: getConfig().servers.map((s) => (s.id === id ? updated : s)) });
    dropMonitor(id);
    addMonitor(updated);
    return { done: true };
  });
}

module.exports = { registerProvisionIpc };
