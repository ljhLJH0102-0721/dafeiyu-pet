// preload-menu.js —— 右键菜单窗口与主进程之间的桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petMenu', {
  act: (id) => ipcRenderer.send('menu:act', id),
  close: () => ipcRenderer.send('menu:close'),
  resize: (h, w) => ipcRenderer.send('menu:resize', { h, w }),
  onItems: (cb) => ipcRenderer.on('menu:items', (_e, data) => cb(data)),
});
