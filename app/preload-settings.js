// preload-settings.js —— 设置窗口与主进程之间的最小桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  test: (llm) => ipcRenderer.invoke('settings:test', llm),
  close: () => ipcRenderer.send('settings:close'),
});
