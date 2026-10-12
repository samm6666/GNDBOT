'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

// The renderer never sees the API key: every request goes through the main process.
contextBridge.exposeInMainWorld('gnd', {
  config: () => invoke('config:get'),
  connect: (server, key) => invoke('config:connect', { server, key }),
  setPrefs: (prefs) => invoke('config:prefs', prefs),
  forgetKey: () => invoke('config:forget'),
  api: (method, path, body) => invoke('api', { method, path, body }),
  reconnect: () => invoke('live:reconnect'),
  saveReport: (markdown, name) => invoke('report:save', { markdown, name }),
  copy: (text) => invoke('clipboard:write', text),
  openExternal: (url) => invoke('open:external', url),
  pickAvatar: () => invoke('avatar:pick'),
  onLive: (fn) => ipcRenderer.on('live:message', (_e, msg) => fn(msg)),
  onLiveState: (fn) => ipcRenderer.on('live:state', (_e, state) => fn(state)),
});
