// 沙箱化的 preload：只暴露具名方法，不暴露 ipcRenderer 本身。
// 任何新增通道都必须在这里显式登记，主进程侧再做一次参数校验。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openferry', {
  getStatus: () => ipcRenderer.invoke('gateway:status'),
  start: () => ipcRenderer.invoke('gateway:start'),
  stop: () => ipcRenderer.invoke('gateway:stop'),
  restart: () => ipcRenderer.invoke('gateway:restart'),
  recentLogs: (limit) => ipcRenderer.invoke('logs:recent', { limit }),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    create: (input) => ipcRenderer.invoke('providers:create', input),
    update: (input) => ipcRenderer.invoke('providers:update', input),
    remove: (id) => ipcRenderer.invoke('providers:remove', { id }),
    test: (input) => ipcRenderer.invoke('providers:test', input),
  },

  clients: {
    state: () => ipcRenderer.invoke('clients:state'),
    preview: (modelIds) => ipcRenderer.invoke('clients:preview', { modelIds }),
    apply: (modelIds) => ipcRenderer.invoke('clients:apply', { modelIds }),
    restore: (name) => ipcRenderer.invoke('clients:restore', { name }),
  },

  models: {
    list: () => ipcRenderer.invoke('models:list'),
    refresh: () => ipcRenderer.invoke('models:refresh'),
    probe: (modelId) => ipcRenderer.invoke('models:probe', { modelId }),
  },
});
