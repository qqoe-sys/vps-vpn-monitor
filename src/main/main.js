'use strict';
// Главный процесс Electron: окно, опрос серверов и SSH-терминалы.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, Notification, session } = require('electron');
const QRCode = require('qrcode');
const { connect, configureTrust } = require('./ssh-transport');
const { registerProvisionIpc } = require('./provision-ipc');
const { registerSubsIpc } = require('./subs-ipc');
const { loadServers, saveServers, activeEntryForExit } = require('../core/app-config');
const { saveInventoryCache } = require('../core/subs-publish');
const { validName, readKeys, changeKeys, linksFor, FINGERPRINTS } = require('../core/xray-keys');
const { restartXray, rebootServer, setPasswordLogin, changeRootPassword, validateNewPassword } = require('../core/server-actions');
const { ServerMonitor } = require('../core/monitor');
const { loadStore, saveStore } = require('../core/traffic-store');
const { loadSettings, saveSettings } = require('../core/settings');
const i18n = require('../i18n');

const { t } = i18n;

// Папка данных не зависит от названия программы: установленная версия видит те же
// серверы, историю и ключи, что и запуск из папки проекта.
app.setPath('userData', path.join(app.getPath('appData'), 'vps-monitor'));
const serversFile = path.join(app.getPath('userData'), 'servers.json');
// В установщик не вкладываем список личных серверов: на новом ПК программа стартует пустой.
// При запуске из исходников можно положить свой config/servers.json (он в .gitignore).
const configDir = path.join(__dirname, '../../config');
const localSeed = path.join(configDir, 'servers.json');
const seedFile = !app.isPackaged && fs.existsSync(localSeed) ? localSeed : path.join(configDir, 'servers.default.json');
let config = loadServers(serversFile, seedFile);
// Язык выбирается до первого сообщения: из settings.json, иначе по языку Windows (см. app ready).
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const SAVE_INTERVAL_MS = 60000;
// Снимки списка клиентов входов: из них мастер замены берёт клиентов, если старый вход не отвечает.
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOT_FIRST_MS = 30 * 1000;

let win = null;
let store = null;
let storeFile = null;
const monitors = new Map();
const latest = new Map();
const knownProblems = new Map();
const quietUntil = new Map();
const XRAY_QUIET_MS = 60000;
const REBOOT_QUIET_MS = 240000;
const terminals = new Map();
let nextTerminalId = 1;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Уведомляем только о НОВЫХ проблемах, иначе Windows завалит окнами.
function notifyProblems(state) {
  // Сбой во время перезапуска, запущенного нами, ожидаем и не сообщаем о нём.
  if (Date.now() < (quietUntil.get(state.id) ?? 0)) return;
  const seen = knownProblems.get(state.id) ?? new Set();
  const current = new Set(state.health.problems.map((p) => p.key));
  for (const p of state.health.problems) {
    if (!seen.has(p.key) && Notification.isSupported()) {
      new Notification({ title: `VPS-VPN Monitor: ${state.name}`, body: p.text }).show();
    }
  }
  knownProblems.set(state.id, current);
}

function addMonitor(server) {
  const monitor = new ServerMonitor(server, {
    connect,
    store,
    pollMs: config.pollSeconds * 1000,
    slowEvery: config.slowEveryPolls,
    onUpdate: (state) => {
      latest.set(state.id, state);
      send('server:update', state);
      notifyProblems(state);
    },
  });
  monitors.set(server.id, monitor);
  if (server.noAccess) {
    // Ключ доступа удалён: показываем сервер, но не опрашиваем его.
    Object.assign(monitor.state, { connection: 'offline', error: t('main.keyRemoved') });
  } else {
    monitor.start();
  }
  const state = monitor.publicState();
  latest.set(server.id, state);
  send('server:update', state);
}

function dropMonitor(id) {
  monitors.get(id)?.stop();
  monitors.delete(id);
  latest.delete(id);
  knownProblems.delete(id);
  send('server:removed', id);
}

function startMonitoring() {
  config.servers.forEach(addMonitor);
}

function validSize(size) {
  const ok = (n, max) => Number.isInteger(n) && n > 0 && n <= max;
  return size && ok(size.cols, 1000) && ok(size.rows, 500);
}

function closeTerminal(id) {
  const t = terminals.get(id);
  if (!t) return;
  terminals.delete(id);
  try { t.transport.close(); } catch { /* уже закрыт */ }
}

function keyServer(serverId) {
  const server = config.servers.find((s) => s.id === serverId && s.statsPort);
  if (!server) throw new Error(t('main.noKeyMgmt'));
  return server;
}

async function withInventory(server) {
  const transport = await connect(server);
  try {
    return await readKeys(transport);
  } finally {
    transport.close();
  }
}

// Подтверждение спрашивает главный процесс: страница не может его обойти.
async function confirmChange(message, detail, title = t('main.confirmTitle')) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('main.cancel'), t('main.run')],
    defaultId: 0,
    cancelId: 0,
    title,
    message,
    detail,
  });
  return response === 1;
}

async function withQr(links) {
  return Promise.all(links.map(async (l) => ({ ...l, qr: await QRCode.toDataURL(l.url, { margin: 2, width: 280 }) })));
}

// Для каждого сервера одновременно идёт только одно изменение.
const keyOpsBusy = new Set();
async function exclusive(serverId, fn) {
  if (keyOpsBusy.has(serverId)) throw new Error(t('main.busy'));
  keyOpsBusy.add(serverId);
  try {
    return await fn();
  } finally {
    keyOpsBusy.delete(serverId);
  }
}

// Снимаем счётчики прямо перед рестартом, чтобы не потерять трафик последних секунд.
async function saveCountersBeforeRestart(serverId) {
  await monitors.get(serverId)?.flushCounters();
  saveStore(store, storeFile);
}

function impactNote(server) {
  const entry = activeEntryForExit(config, server.host);
  return entry ? t('main.impactExit', { name: entry.name }) : t('main.impactClients');
}

// Снимок клиентов каждого действующего входа. Ошибки молча: сервер мог быть недоступен,
// тогда в файле остаётся прошлый снимок со своей датой.
async function snapshotInventories(cacheFile) {
  const entries = config.servers.filter((s) => s.exitHost && s.statsPort && !s.replacedBy && !s.noAccess);
  for (const server of entries) {
    try {
      saveInventoryCache(cacheFile, server.id, await withInventory(server));
    } catch { /* вход не ответил — попробуем в следующий раз */ }
  }
}

function registerServerIpc() {
  const find = (serverId) => {
    const server = config.servers.find((s) => s.id === serverId);
    if (!server) throw new Error(t('main.unknownServer'));
    return server;
  };

  ipcMain.handle('server:restart-xray', async (_e, serverId) => {
    const server = find(serverId);
    if (!(await confirmChange(t('main.restartQ', { name: server.name }), `${t('main.restartDetail')} ${impactNote(server)}`))) return { cancelled: true };
    return exclusive(serverId, async () => {
      quietUntil.set(serverId, Date.now() + XRAY_QUIET_MS);
      await saveCountersBeforeRestart(serverId);
      await restartXray(connect, server);
      await monitors.get(serverId)?.pollNow();
      return { done: true };
    });
  });

  ipcMain.handle('server:change-password', async (_e, serverId, password) => {
    const server = find(serverId);
    validateNewPassword(password);
    if (server.noAccess) throw new Error(t('main.reconnectFirst'));
    const passwordOn = monitors.get(serverId)?.state.passwordAuth === true;
    const note = t(passwordOn ? 'main.passVerify' : 'main.passUnused');
    if (!(await confirmChange(t('main.passQ', { name: server.name }), `${t('main.passDetail')} ${note}`))) return { cancelled: true };
    return exclusive(serverId, async () => {
      await changeRootPassword(connect, server, password, { verify: passwordOn });
      return { done: true };
    });
  });

  ipcMain.handle('server:toggle-password', async (_e, serverId) => {
    const server = find(serverId);
    const monitor = monitors.get(serverId);
    const current = monitor?.state.passwordAuth;
    if (server.noAccess || current === undefined) throw new Error(t('main.passUnknown'));
    const enabling = !current;
    const detail = t(enabling ? 'main.passOnDetail' : 'main.passOffDetail');
    if (!(await confirmChange(t(enabling ? 'main.passOnQ' : 'main.passOffQ', { name: server.name }), detail))) return { cancelled: true };
    return exclusive(serverId, async () => {
      await setPasswordLogin(connect, server, enabling);
      monitor.round = 0; // следующий опрос будет полным и покажет новое состояние
      await monitor.pollNow();
      return { done: true };
    });
  });

  ipcMain.handle('server:reboot', async (_e, serverId) => {
    const server = find(serverId);
    if (!(await confirmChange(t('main.rebootQ', { name: server.name }), `${t('main.rebootDetail')} ${impactNote(server)}`))) return { cancelled: true };
    return exclusive(serverId, async () => {
      quietUntil.set(serverId, Date.now() + REBOOT_QUIET_MS);
      await saveCountersBeforeRestart(serverId);
      await rebootServer(connect, server);
      return { done: true };
    });
  });
}

// Функция, а не константа: текст должен быть на текущем языке.
const restartNote = () => t('main.restartNote');

function registerKeysIpc() {
  ipcMain.handle('keys:list', async (_e, serverId) => {
    const server = keyServer(serverId);
    return (await withInventory(server)).keys.map((k) => k.name);
  });

  ipcMain.handle('keys:links', async (_e, serverId, name, fp) => {
    const server = keyServer(serverId);
    if (!validName(name)) throw new Error(t('main.badKeyName'));
    const fingerprint = FINGERPRINTS.includes(fp) ? fp : 'firefox';
    return withQr(linksFor(server, await withInventory(server), name, fingerprint));
  });

  ipcMain.handle('keys:add', async (_e, serverId, name, profile) => {
    const server = keyServer(serverId);
    if (!validName(name)) throw new Error(t('main.keyNameRules'));
    // У серверов с двумя режимами ключ создаётся для одного из них.
    const chosen = server.modes?.includes(profile) ? profile : (server.modes?.[0] ?? undefined);
    if (!(await confirmChange(t('main.addKeyQ', { name, server: server.name }), restartNote()))) return { cancelled: true };
    return exclusive(serverId, async () => {
      quietUntil.set(serverId, Date.now() + XRAY_QUIET_MS);
      await saveCountersBeforeRestart(serverId);
      const inventory = await changeKeys(connect, server, { action: 'add', name, uuid: crypto.randomUUID(), profile: chosen });
      return { links: await withQr(linksFor(server, inventory, name)) };
    });
  });

  ipcMain.handle('keys:delete', async (_e, serverId, name) => {
    const server = keyServer(serverId);
    if (!validName(name)) throw new Error(t('main.badKeyName'));
    if (!(await confirmChange(t('main.delKeyQ', { name, server: server.name }), `${t('main.delKeyDetail')} ${restartNote()}`))) return { cancelled: true };
    return exclusive(serverId, async () => {
      quietUntil.set(serverId, Date.now() + XRAY_QUIET_MS);
      await saveCountersBeforeRestart(serverId);
      await changeKeys(connect, server, { action: 'delete', name });
      return { deleted: true };
    });
  });
}

function registerIpc() {
  registerKeysIpc();
  registerServerIpc();
  ipcMain.handle('servers:get', () => [...latest.values()]);
  ipcMain.handle('lang:get', () => i18n.getLang());
  ipcMain.handle('lang:set', (_e, lang) => {
    const chosen = i18n.LANGS.includes(lang) ? lang : i18n.getLang();
    saveSettings(settingsFile, { ...loadSettings(settingsFile, app.getLocale()), lang: chosen });
    i18n.setLang(chosen);
    // Тексты проблем строит главный процесс: пересчитываем их сразу на новом языке.
    for (const [id, m] of monitors) {
      if (!config.servers.find((s) => s.id === id)?.noAccess) Promise.resolve(m.pollNow()).catch(() => {});
    }
    return chosen;
  });

  ipcMain.handle('traffic:get', (_e, days) => {
    const safeDays = Number.isInteger(days) && days >= 0 ? days : 7;
    return config.servers.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      hasKeyStats: Boolean(s.statsPort),
      modes: s.modes ?? [],
      exitId: config.servers.find((x) => x.host === s.exitHost)?.id ?? null,
      ...monitors.get(s.id).trafficSummary(safeDays),
    }));
  });

  ipcMain.handle('term:open', async (_e, serverId, size) => {
    const server = config.servers.find((s) => s.id === serverId);
    if (!server || !validSize(size)) throw new Error(t('main.badTerm'));
    const transport = await connect(server);
    let stream;
    try {
      stream = await transport.shell(size);
    } catch (err) {
      transport.close();
      throw err;
    }
    const id = nextTerminalId++;
    terminals.set(id, { transport, stream });
    stream.on('data', (data) => send('term:data', { id, data: new Uint8Array(data) }));
    stream.on('close', () => {
      closeTerminal(id);
      send('term:exit', { id });
    });
    return id;
  });

  ipcMain.on('term:input', (_e, id, data) => {
    if (typeof data === 'string') terminals.get(id)?.stream.write(data);
  });
  ipcMain.on('term:resize', (_e, id, size) => {
    // setWindow принимает строки, колонки, высоту и ширину в пикселях.
    if (validSize(size)) terminals.get(id)?.stream.setWindow(size.rows, size.cols, 0, 0);
  });
  ipcMain.on('term:close', (_e, id) => closeTerminal(id));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121211',
    autoHideMenuBar: true,
    title: 'VPS-VPN Monitor',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Приложение не должно уходить на внешние страницы.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// Вторая копия дублировала бы опрос и затирала файл статистики,
// поэтому при повторном запуске просто показываем уже открытое окно.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  i18n.setLang(loadSettings(settingsFile, app.getLocale()).lang);
  app.setAppUserModelId('io.github.vpsvpnmonitor'); // нужно для уведомлений Windows
  // Разрешаем только буфер обмена: без него не работает вставка в терминал.
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, done) => done(allowed.has(perm)));
  // Синхронные проверки разрешений (navigator.permissions и т.п.) — тот же короткий список.
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
  storeFile = path.join(app.getPath('userData'), 'traffic.json');
  store = loadStore(storeFile);
  configureTrust(path.join(app.getPath('userData'), 'known_hosts'));
  registerIpc();
  const subs = registerSubsIpc({
    getConfig: () => config,
    connect,
    withInventory,
    confirmChange,
    withQr,
    userData: app.getPath('userData'),
  });
  registerProvisionIpc({
    send,
    win: () => win,
    getConfig: () => config,
    setConfig: (next) => { config = next; saveServers(serversFile, config); },
    addMonitor,
    dropMonitor,
    getState: (id) => monitors.get(id)?.state,
    getTrafficRecord: (id) => monitors.get(id)?.remoteTraffic ?? store.data.servers[id],
    userData: app.getPath('userData'),
    withQr,
    withInventory,
    confirmChange,
    subs,
  });
  createWindow();
  startMonitoring();
  setInterval(() => saveStore(store, storeFile), SAVE_INTERVAL_MS);
  // Снимки не задерживают запуск: первый через 30 с, дальше раз в 10 минут.
  const cacheFile = path.join(app.getPath('userData'), 'inventory-cache.json');
  setTimeout(() => snapshotInventories(cacheFile), SNAPSHOT_FIRST_MS);
  setInterval(() => snapshotInventories(cacheFile), SNAPSHOT_INTERVAL_MS);
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  for (const m of monitors.values()) m.stop();
  for (const id of [...terminals.keys()]) closeTerminal(id);
  if (store) saveStore(store, storeFile);
});
