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
});
