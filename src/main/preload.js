'use strict';
// Мост между страницей и главным процессом. Странице видны только эти функции,
// доступа к файлам, ключам и Node.js у неё нет.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, fn) {
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

contextBridge.exposeInMainWorld('api', {
  getServers: () => ipcRenderer.invoke('servers:get'),
  getTraffic: (days) => ipcRenderer.invoke('traffic:get', days),
  onServerUpdate: (fn) => subscribe('server:update', fn),
  restartXray: (serverId) => ipcRenderer.invoke('server:restart-xray', serverId),
  rebootServer: (serverId) => ipcRenderer.invoke('server:reboot', serverId),
  keysList: (serverId) => ipcRenderer.invoke('keys:list', serverId),
  keysAdd: (serverId, name, profile) => ipcRenderer.invoke('keys:add', serverId, name, profile),
  onServerRemoved: (fn) => subscribe('server:removed', fn),
  provisionStart: (plan) => ipcRenderer.invoke('provision:start', plan),
  provisionSni: (domain) => ipcRenderer.send('provision:sni', domain),
  replaceEntry: (oldId, form) => ipcRenderer.invoke('provision:replace', oldId, form),
  closeExitAccess: (oldId) => ipcRenderer.invoke('server:close-exit-access', oldId),
  undoReplace: (oldId) => ipcRenderer.invoke('server:undo-replace', oldId),
  onProvisionProgress: (fn) => subscribe('provision:progress', fn),
  onProvisionChooseSni: (fn) => subscribe('provision:choose-sni', fn),
  removeSettings: (id, typedName, backup) => ipcRenderer.invoke('server:remove-settings', id, typedName, backup),
  changePassword: (id, password) => ipcRenderer.invoke('server:change-password', id, password),
  togglePassword: (id) => ipcRenderer.invoke('server:toggle-password', id),
  forgetServer: (id) => ipcRenderer.invoke('server:forget', id),
  removeAppKey: (id) => ipcRenderer.invoke('server:remove-app-key', id),
  reconnect: (id, password) => ipcRenderer.invoke('server:reconnect', id, password),
  setLimit: (id, limit) => ipcRenderer.invoke('limits:set', id, limit),
  keysDelete: (serverId, name) => ipcRenderer.invoke('keys:delete', serverId, name),
  keysLinks: (serverId, name, fp) => ipcRenderer.invoke('keys:links', serverId, name, fp),
  termOpen: (serverId, size) => ipcRenderer.invoke('term:open', serverId, size),
  termInput: (id, data) => ipcRenderer.send('term:input', id, data),
  termResize: (id, size) => ipcRenderer.send('term:resize', id, size),
  termClose: (id) => ipcRenderer.send('term:close', id),
  onTermData: (fn) => subscribe('term:data', fn),
  onTermExit: (fn) => subscribe('term:exit', fn),
  subsGet: () => ipcRenderer.invoke('subs:get'),
  subsAdd: (name, key) => ipcRenderer.invoke('subs:add', name, key),
  subsReissue: (id) => ipcRenderer.invoke('subs:reissue', id),
  subsRemove: (id) => ipcRenderer.invoke('subs:remove', id),
  subsSettings: (form) => ipcRenderer.invoke('subs:settings', form),
  subsApps: (apps) => ipcRenderer.invoke('subs:apps', apps),
  subsPublish: () => ipcRenderer.invoke('subs:publish'),
  subsInstall: () => ipcRenderer.invoke('subs:install'),
  subsQr: (url) => ipcRenderer.invoke('subs:qr', url),
});
