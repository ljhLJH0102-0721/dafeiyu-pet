// preload-workshop.js —— 创意工坊窗口与主进程之间的桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petWorkshop', {
  list: () => ipcRenderer.invoke('workshop:list'),
  toggle: (id, on) => ipcRenderer.invoke('workshop:toggle', { id, on }),
  rescan: () => ipcRenderer.invoke('workshop:rescan'),
  openDir: () => ipcRenderer.invoke('workshop:openDir'),
  template: (id) => ipcRenderer.invoke('workshop:template', { id }),
  close: () => ipcRenderer.send('workshop:close'),
});
