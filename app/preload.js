// 大肥鱼桌宠 preload：把最小必要能力暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 透明区域点击穿透开关
  setIgnore: (ignore) => ipcRenderer.send('pet:ignore', !!ignore),
  // 拖动
  dragStart: (x, y) => ipcRenderer.send('pet:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('pet:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  // 右键菜单（设置 / 互动）
  showMenu: () => ipcRenderer.send('pet:menu'),
  // 缩放（Ctrl+滚轮用）：k 是倍率，比如 1.1 / 0.9
  scaleBy: (k) => ipcRenderer.send('pet:scale', Number(k) || 1),
  // 设置变化（触摸音效 / 音量 / 漫游）
  onOptions: (cb) => {
    ipcRenderer.on('pet:options', (_event, opt) => {
      try { cb(opt || {}); } catch (e) {}
    });
  },
  // 外壳回传拖动速度，给摆动动画用
  onDrag: (cb) => {
    ipcRenderer.on('pet:drag-info', (_event, info) => {
      try { cb(info || { vx: 0, vy: 0 }); } catch (e) {}
    });
  },
  // 外壳回传全屏光标位置：鼠标离开她的窗口（比如移到头顶上方）也能跟随
  onCursor: (cb) => {
    ipcRenderer.on('pet:cursor', (_event, pos) => {
      try { cb(pos || {}); } catch (e) {}
    });
  },
});
