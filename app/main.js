// 大肥鱼桌宠主程序
// ─────────────────────────────────────────────────────────
// 1) 内置静态服务器（把 dist 发给窗口，不依赖 vite）
// 2) 透明 / 无边框 / 置顶 / 不进任务栏 的窗口
// 3) 逐像素命中的点击穿透：透明区域放行，点她身上才接管鼠标
// 4) 可拖动（位置会记住），拖动时带动摆动
// 5) 托盘图标（显示/隐藏、复位、退出）
// 6) 本地控制接口（127.0.0.1:5011）：口型 / 参数 / 反应

const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage, session, globalShortcut } = require('electron');

// 单实例：开机时「启动文件夹快捷方式」和「计划任务」可能同时拉起，第二份直接退出，
// 否则两个进程会抢 5011 端口，出现一个空白窗口。
if (!app.requestSingleInstanceLock()) {
  try { console.log("[pet] 已有一个实例在跑，本实例退出"); } catch (e) {}
  app.exit(0);
}
app.on('second-instance', () => {
  try {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  } catch (e) {}
});
const { createWindowState } = require('./shell/windowState');
const pageCommand = require('./shell/pageCommand');
const settingsStore = require('./shell/settingsStore');
const settingsApply = require('./shell/settingsApply');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'Demo', 'dist');
// 语音文件目录（pet_voice.py 用 edge-tts 生成 mp3，这里发给页面播放）
const AUDIO_DIR =
  process.env.PET_AUDIO_DIR ||
  'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace\\dafeiyu-pet\\audio';
const STATIC_PORT = 5010;
const API_PORT = 5011;
const LOG_PATH = path.join(__dirname, 'pet-shell.log');
const POS_PATH = path.join(__dirname, 'pet-window.json');

let win = null;
// 待打字的文本队列：DSH 的打字插件会轮询 /pending 取走并写进输入框
const textQueue = [];
let tray = null;
// 是否允许鼠标落在窗口上（拖动/点她）。默认 false = 整窗点击穿透，不打扰你。
let interactive = process.argv.includes('--interactive');
let interactiveTimer = null;   // 整窗交互的自动恢复定时器

/** 调页面命令（参数走 JSON，唯一的手拼 JS 在 shell/pageCommand.js 里） */
function cmd(name, args) {
  return pageCommand.command(win, name, args);
}
/** 只给 /eval 调试通道用 */
function runJs(js) {
  return pageCommand.run(win, js);
}

function log() {
  const line =
    '[' + new Date().toISOString() + '] ' +
    Array.prototype.map
      .call(arguments, (a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ') + '\n';
  try { fs.appendFileSync(LOG_PATH, line); } catch (e) {}
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const MODEL = arg('model', '大肥鱼');
const WIDTH = parseInt(arg('w', '420'), 10);
const HEIGHT = parseInt(arg('h', '620'), 10);

// 窗口几何的唯一真相。见 shell/windowState.js 的注释：
// desiredW/H 只能由 geo.setSize() 改，拖动中不采信 resize，坐标对齐设备像素。
let geo = null;

function initGeometry() {
  geo = createWindowState({
    screen,
    fs,
    posPath: POS_PATH,
    defaults: { width: WIDTH, height: HEIGHT },
    log,
  });
  return geo;
}

// ── 拖动状态（几何/尺寸归 geo 管，这里只记拖动的起点和速度） ──────
const drag = { active: false, sx: 0, sy: 0, wx: 0, wy: 0, lx: 0, ly: 0, lt: 0 };

function savePos() {
  if (geo) geo.savePos();
}

// ── 静态服务器 ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.moc3': 'application/octet-stream',
  '.frag': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

function startStaticServer() {
  const staticServer = http.createServer((req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';

      // /audio/xxx.mp3 → 语音目录（供页面 <audio> 播放）
      if (rel.startsWith('/audio/')) {
        const name = path.basename(rel);
        const file = path.join(AUDIO_DIR, name);
        if (!fs.existsSync(file)) { res.writeHead(404); res.end('no audio'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'audio/mpeg',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      const full = path.join(DIST, rel);
      if (!path.resolve(full).startsWith(path.resolve(DIST))) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end('error');
    }
  });
  staticServer.listen(STATIC_PORT, '127.0.0.1', () => log('static on', STATIC_PORT));

  staticServer.on('error', (e) => {
    log('[static] 监听失败', e.code, '（可能另一份在跑）');
  });
}

// ── 窗口 ──────────────────────────────────────────────────
// 允许页面使用摄像头/麦克风（透明桌宠窗口里 getUserMedia 需要显式放行）
function allowMediaPermissions() {
  try {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      log('permission request:', permission);
      callback(true);
    });
    ses.setPermissionCheckHandler(() => true);
  } catch (e) {
    log('permission handler failed', String(e));
  }
}

function createWindow() {
  const bounds = geo.initialBounds();

  win = new BrowserWindow({
    title: '大肥鱼',
    focusable: false,          // 永不抢键盘焦点：她在前台也不影响你打字
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,           // 允许拖窗口边缘缩放（几何对账已能吸收 1px 抖动，不再越拖越大）
    useContentSize: false,
    alwaysOnTop: true,
    skipTaskbar: true,          // 后台运行：不占任务栏
    show: false,                // 先不显示，等页面就绪再 showInactive（不抢焦点）
    backgroundColor: '#00000000',
    webPreferences: {
      icon: path.join(__dirname, 'assets', 'icon_256.png'),
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  geo.bind(win);

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.showInactive();   // 关键：inactive 显示，不抢焦点
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // 默认整窗放行鼠标（不影响你点桌面）；需要拖她时用托盘菜单或 Ctrl+Alt+P 切换。
  win.setIgnoreMouseEvents(!interactive, { forward: true });

  win.loadURL(`http://127.0.0.1:${STATIC_PORT}/?model=${encodeURIComponent(MODEL)}`);

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log('[page]', message);
  });
  win.webContents.on('did-finish-load', () => log('page loaded'));

  // 用户手动拖边缩放 → 交给 geo 对账（拖动中一律忽略，≤2px 抖动忽略）
  let resizeSaveTimer = null;
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    skipUntil = Date.now() + 600;   // 缩放期间不做命中检测（否则穿透开关会抖）
    const r = geo.reconcile(win.getBounds(), { dragging: drag.active });
    if (!r.changed) return;
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      try { savePos(); } catch (e) {}
    }, 600);
  });

  win.on('closed', () => { win = null; });
}

// ── IPC：点击穿透 + 拖动 ──────────────────────────────────
// ── 设置窗口 ──────────────────────────────────────────────
let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 780,
    minHeight: 600,
    title: '大肥鱼 · 设置',
    frame: false,                 // 自绘标题栏：圆角 + 蓝白，且能用 CSS 做拖动区
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    resizable: false,           // 透明无边框窗口四周有隐形缩放手柄，鼠标靠近会被当成拖拽（"自己变大"），关掉
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon_256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  log('[settings] 创建窗口');
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  try { settingsWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
  settingsWin.webContents.on('did-fail-load', (_e, code, desc) => log('[settings] 加载失败', code, desc));
  settingsWin.once('ready-to-show', () => {
    try { settingsWin.show(); settingsWin.focus(); settingsWin.moveTop(); } catch (e) {}
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// 设置窗口需要的 IPC
ipcMain.handle('settings:get', () => settingsStore.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  try {
    const before = settingsStore.getSettings();
    const next = settingsStore.setSettings(patch || {});
    settingsApply.apply(win, next, log, { setRoam: (on) => { try { geo.setRoam(on); } catch (e) {} } });
    syncPttShortcut();
    // 只有音色这类启动时才读的配置需要重启；API 配置支持热重载
    // 只有音色真的变了才重启语音桥（否则每次保存都会重启，白等 10 秒）
    if (patch && patch.voice && patch.voice.voiceName && patch.voice.voiceName !== before.voice.voiceName) settingsApply.restartBridge(log);
    return { ok: true, settings: next };
  } catch (err) {
    log('[settings] 保存失败', String(err));
    return { ok: false, error: String(err) };
  }
});
ipcMain.handle('settings:test', async (_e, llm) => {
  const https = require('https');
  const http = require('http');
  const store = settingsStore.getSettings();
  const base = String((llm && llm.base_url) || store.llm.base_url || '').replace(/\/+$/, '');
  const model = String((llm && llm.model) || store.llm.model || '');
  let key = String((llm && llm.api_key) || store.llm.api_key || '').trim();
  if (!key) key = String(process.env[(llm && llm.api_key_env) || store.llm.api_key_env] || '').trim();
  if (!base) return { ok: false, error: '没有填接口地址' };
  if (!key) return { ok: false, error: '没有可用的 API Key' };
  const payload = JSON.stringify({
    model, messages: [{ role: 'user', content: '只回两个字：你好' }],
    max_tokens: 16, stream: false,
  });
  const url = new URL(base + '/chat/completions');
  const lib = url.protocol === 'http:' ? http : https;
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer ' + key,
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          const txt = ((d.choices || [{}])[0].message || {}).content || '' ;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, ms: Date.now() - t0, reply: String(txt).slice(0, 30) });
          } else {
            resolve({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + body.slice(0, 160) });
          }
        } catch (e) {
          resolve({ ok: false, error: '返回不是 JSON：' + body.slice(0, 120) });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.write(payload);
    req.end();
  });
});
ipcMain.on('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

function setupIpc() {
  ipcMain.on('pet:ignore', (_e, ignore) => {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.on('pet:scale', (_e, k) => {
    const f = Number(k) || 1;
    const g = geo.get();
    applySize(g.w * f, g.h * f);
  });

  ipcMain.on('pet:drag-start', (_e, p) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const g = geo.get();
    drag.active = true;
    drag.sx = p.x; drag.sy = p.y;
    drag.wx = b.x; drag.wy = b.y;
    drag.lx = p.x; drag.ly = p.y; drag.lt = Date.now();
    log('[drag] start geo=', g.w, g.h);
  });

  ipcMain.on('pet:drag-move', (_e, p) => {
    if (!win || win.isDestroyed() || !drag.active) return;
    const g = geo.get();
    let nx = drag.wx + (p.x - drag.sx);
    let ny = drag.wy + (p.y - drag.sy);

    // 别让她被拖丢：至少留 90px 在屏幕内（geo.moveTo 还会夹到工作区）
    const d = screen.getPrimaryDisplay().workAreaSize;
    const keep = 90;
    nx = Math.max(-g.w + keep, Math.min(d.width - keep, nx));
    ny = Math.max(0, Math.min(d.height - keep, ny));

    // 几何交给 geo：一次 setBounds 同时钉住尺寸 + 坐标对齐设备像素
    geo.moveTo(nx, ny);

    // 速度回传给页面做摆动
    const now = Date.now();
    const dt = Math.max(1, now - drag.lt);
    const vx = ((p.x - drag.lx) / dt) * 16;
    const vy = ((p.y - drag.ly) / dt) * 16;
    drag.lx = p.x; drag.ly = p.y; drag.lt = now;
    win.webContents.send('pet:drag-info', { vx, vy });
  });

  ipcMain.on('pet:drag-end', () => {
    drag.active = false;
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:drag-info', { vx: 0, vy: 0 });
      savePos();
    }
  });
}

  // ── 右键菜单：设置 / 互动 ────────────────────────────────
  ipcMain.on('pet:menu', () => {
    if (!win || win.isDestroyed()) return;
    const fire = (name, args) => cmd(name, args).catch(() => {});
    const menu = Menu.buildFromTemplate([
      {
        label: '互动',
        submenu: [
          { label: '打个招呼', click: () => { fire('bubble', { text: '主人好呀～', seconds: 3 }); fire('react', { kind: 'happy' }); } },
          { label: '说一句话（测试语音）', click: () => {
              fetch('http://127.0.0.1:5011/play', { method: 'POST' }).catch(() => {});
              fire('bubble', { text: '语音测试：你好，我是大肥鱼', seconds: 3 });
              try { require('child_process').spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:5011/state'], { windowsHide: true }); } catch (e) {}
            } },
          { label: '摸摸头', click: () => { fire('expression', { name: '爱心眼', ms: 2500 }); fire('react', { kind: 'happy' }); } },
        ],
      },
      {
        label: '表情',
        submenu: [
          ...['脸红', '爱心眼', '＞＜', '兔牙', '屑屑眼', '圈圈眼', '黑脸', '流泪', '流冷汗'].map((n) => ({
            label: n,
            click: () => fire('expression', { name: n, ms: 3000 }),
          })),
          { type: 'separator' },
          { label: '清除表情', click: () => fire('expression', { name: '', ms: 0 }) },
        ],
      },
      {
        label: '动作',
        submenu: [
          ...['举手', '放手', '竖手指开', '竖手指关', '狗尾草开', '狗尾草关'].map((g) => ({
            label: g,
            click: () => fire('motion', { group: g, no: 0 }),
          })),
        ],
      },
      { type: 'separator' },
      { label: '设置…', click: () => openSettings() },
      {
        label: '大小',
        submenu: [
          { label: '小', click: () => applySize(360, 520) },
          { label: '中', click: () => applySize(420, 620) },
          { label: '大', click: () => applySize(520, 760) },
          { label: '特大', click: () => applySize(640, 900) },
        ],
      },
      {
        label: '摄像头面捕',
        type: 'checkbox',
        checked: false,
        click: (item) => fire('camera', { on: !!item.checked }),
      },
      { type: 'separator' },
      { label: '隐藏（托盘可唤回）', click: () => { if (win) win.hide(); } },
      { label: '打开配置目录', click: () => { try { require('electron').shell.openPath(__dirname); } catch (e) {} } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit(); } },
    ]);
    // 自绘菜单接管右键（原生菜单保留为兜底，不再弹出）
    openContextMenu();
  });
// ── 自绘右键菜单（蓝白圆角，跟着鼠标弹） ──────────────────
const EXPRESSIONS = ['脸红', '爱心眼', '＞＜', '兔牙', '屑屑眼', '圈圈眼', '黑脸', '流泪', '流冷汗'];
const MOTIONS = ['举手', '放手', '竖手指开', '竖手指关', '狗尾草开', '狗尾草关'];

function buildMenuData() {
  const s = settingsStore.getSettings();
  return {
    title: '大肥鱼',
    hint: s.voiceMode === 'ptt' ? '按键说话' : '一直听',
    items: [
      { id: 'hello', label: '打个招呼', icon: '👋' },
      { id: 'pat', label: '摸摸头', icon: '♡' },
      { sep: true },
      { id: 'g-exp', label: '表情', icon: '', chips: EXPRESSIONS.map((n) => ({ id: 'exp:' + n, label: n })) },
      { id: 'g-mot', label: '动作', icon: '', chips: MOTIONS.map((n) => ({ id: 'mot:' + n, label: n })) },
      { sep: true },
      { id: 'settings', label: '设置…', icon: '⚙' },
      { id: 'size-up', label: '大一点', icon: '⤢' },
      { id: 'size-down', label: '小一点', icon: '⤡' },
      { id: 'center', label: '回到屏幕中央', icon: '◎' },
      { sep: true },
      { id: 'hide', label: '隐藏她', icon: '◡' },
      { id: 'quit', label: '退出', icon: '×', danger: true },
    ],
  };
}

/** 让她用她的声音说一句话（走语音桥的 SAY: 通道，不经过模型、不花 token） */
function speak(text) {
  const line = String(text || '').trim();
  if (!line) return;
  try {
    const p = path.join(settingsStore.PET_DIR, 'command.txt');
    fs.writeFileSync(p, 'SAY:' + line, 'utf8');
  } catch (e) { log('[say] 写入失败', String(e)); }
}

function handleMenuAction(id) {
  const fire = (name, args) => cmd(name, args).catch(() => {});
  if (id.startsWith('exp:')) {
    fire('expression', { name: id.slice(4), ms: 3000 });
    return;
  }
  if (id.startsWith('mot:')) {
    fire('motion', { group: id.slice(4), no: 0 });
    return;
  }
  switch (id) {
    case 'hello':
      fire('bubble', { text: '主人好呀～', seconds: 3 });
      fire('react', { kind: 'happy' });
      speak('主人好呀～想让我做点什么？');
      break;
    case 'pat':
      fire('expression', { name: '爱心眼', ms: 2500 });
      fire('react', { kind: 'happy' });
      speak('嘿嘿，摸摸头好舒服～');
      break;
    case 'settings':
      openSettings();
      break;
    case 'size-up':
      applySize(geo.get().w * 1.15, geo.get().h * 1.15);
      break;
    case 'size-down':
      applySize(geo.get().w / 1.15, geo.get().h / 1.15);
      break;
    case 'roam': {
      const s = settingsStore.getSettings();
      const next = settingsStore.setSettings({ roamMode: !s.roamMode });
      settingsApply.apply(win, next, log, { setRoam: (on) => { try { geo.setRoam(on); } catch (e) {} } });
          try { syncPttShortcut(); } catch (e) {}
      break;
    }
    case 'center': {
      try {
        const isRoam = !!(geo.isRoam && geo.isRoam());
        if (isRoam) {
          // 漫游时窗口铺满屏幕，移动窗口没有意义：要移的是角色本身
          runJs('window.__setRoamOffset && window.__setRoamOffset(0, 0)').catch(() => {});
        } else {
          const area = screen.getPrimaryDisplay().workArea;
          const b = geo.get();
          const nx = Math.round(area.x + (area.width - b.w) / 2);
          const ny = Math.round(area.y + (area.height - b.h) / 2);
          geo.moveTo(nx, ny);
        }
      } catch (e) { log('[menu] center 失败:', String(e)); }
      break;
    }
    case 'hide':
      try { win.hide(); } catch (e) {}
      break;
    case 'quit':
      app.quit();
      break;
  }
}

let menuWin = null;
/** 把菜单框拉回可见桌面：返回一个一定在屏幕内的坐标 */
function clampMenuPos(x, y, w, h) {
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    area = d.workArea || area;
  } catch (e) {}
  const minX = area.x + 8;
  const maxX = area.x + area.width - w - 8;
  const minY = area.y + 8;
  const maxY = area.y + area.height - h - 8;
  return {
    x: Math.max(minX, Math.min(Math.round(x), Math.max(minX, maxX))),
    y: Math.max(minY, Math.min(Math.round(y), Math.max(minY, maxY))),
    area,
  };
}

// 漫游模式下"她"在屏幕上的位置 = 窗口 + 画布位移，这里缓存一下画布位移
let roamShift = { x: 0, y: 0 };
let menuFollowTimer = null;

function refreshRoamShift() {
  try {
    if (!geo.isRoam || !geo.isRoam()) { roamShift = { x: 0, y: 0 }; return; }
    runJs('(function(){var c=document.querySelector("canvas");return c?(c.style.transform||""):""})()')
      .then((tf) => {
        const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(String(tf || ''));
        if (m) roamShift = { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) };
      })
      .catch(() => {});
  } catch (e) {}
}

/** 菜单该出现在哪：贴着她（优先右侧，没地方就左侧），并夹在可见桌面内 */
function menuAnchorPos(w, h) {
  const b = geo.get();
  const ox = roamShift.x;
  const oy = roamShift.y;
  // 她的"头"在屏幕上的大概位置
  const headX = b.x + ox + Math.round(b.w * 0.55);
  const headY = b.y + oy + Math.round(b.h * 0.28);
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  try { area = screen.getDisplayNearestPoint({ x: headX, y: headY }).workArea; } catch (e) {}

  let x = headX + 24;
  if (x + w > area.x + area.width - 8) x = headX - 24 - w;   // 右边放不下就换左边
  let y = headY - Math.round(h * 0.18);
  const pos = clampMenuPos(x, y, w, h);
  return pos;
}

function positionMenu(follow) {
  if (!menuWin || menuWin.isDestroyed()) return;
  const b = menuWin.getBounds();
  const w = 276;                 // 宽度固定，见 menu:resize 里的说明
  const h = b.height || 420;
  const pos = menuAnchorPos(w, h);
  // 必须用 setBounds 一起钉住尺寸：只调 setPosition 时，Windows 为了保持
  // 客户区会反推窗口大小 —— 每调一次就变宽几像素（这个坑 windowState 里踩过，
  // 菜单这边没跟上，表现为"右键菜单一直变大"）。
  try {
    menuWin.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  } catch (e) {}
}

function startMenuFollow() {
  stopMenuFollow();
  refreshRoamShift();
  menuFollowTimer = setInterval(() => {
    if (!menuWin || menuWin.isDestroyed() || !menuWin.isVisible()) { stopMenuFollow(); return; }
    if (!win || win.isDestroyed() || !win.isVisible()) { stopMenuFollow(); return; }
    refreshRoamShift();
    positionMenu(true);
  }, 150);
}

function stopMenuFollow() {
  if (menuFollowTimer) { clearInterval(menuFollowTimer); menuFollowTimer = null; }
}

function openContextMenu() {
  if (!menuWin || menuWin.isDestroyed()) {
    menuWin = new BrowserWindow({
      width: 272,
      height: 420,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      icon: path.join(__dirname, 'assets', 'icon_256.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-menu.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    menuWin.loadFile(path.join(__dirname, 'menu.html'));
    menuWin.on('hide', () => stopMenuFollow());
    menuWin.on('blur', () => { try { if (menuWin && !menuWin.isDestroyed()) menuWin.hide(); } catch (e) {} });
    menuWin.once('ready-to-show', () => {
      menuWin.webContents.send('menu:items', buildMenuData());
      menuWin.show();
    });
  } else {
    menuWin.webContents.send('menu:items', buildMenuData());
  }

  positionMenu(false);
  try { menuWin.show(); menuWin.focus(); menuWin.moveTop(); } catch (e) {}
  // 跟着她走：她在屏幕上移动时菜单跟着重排（仍夹在可见桌面内）
  startMenuFollow();
}

ipcMain.on('menu:act', (_e, id) => {
  try { if (menuWin && !menuWin.isDestroyed()) menuWin.hide(); } catch (e) {}
  try { handleMenuAction(String(id || '')); } catch (e) { log('[menu] 动作失败', String(e)); }
});
ipcMain.on('menu:close', () => {
  try { if (menuWin && !menuWin.isDestroyed()) menuWin.hide(); } catch (e) {}
});
ipcMain.on('menu:resize', (_e, size) => {
  try {
    if (!menuWin || menuWin.isDestroyed()) return;
    const b = menuWin.getBounds();
    const h = Math.max(160, Math.min(720, Math.round((size && size.h) || 420)));
    // 宽度写死：菜单内容宽度是「窗口宽度 100%」，量出来再设回去会自我放大（越点越宽）
    const w = 276;
    // 变高之后重新夹一次，保证整块菜单都在可见桌面内
    const pos = clampMenuPos(b.x, b.y, w, h);
    menuWin.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
    if (menuWin.isVisible()) positionMenu(true);
  } catch (e) {}
});

// ── 几何看门狗 ────────────────────────────────────────────
// 两个职责：
//   1. drag.active 卡死时强制结束（丢了 mouseup / 合成事件 / 焦点丢失）
//   2. 定期对账：OS 实际尺寸与 geo 基准差 >4px 就自愈，避免长期脱节
let geoWatchTimer = null;
function startGeometryWatchdog() {
  if (geoWatchTimer) clearInterval(geoWatchTimer);
  geoWatchTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !geo) return;
    const now = Date.now();
    // 拖动中但 1.5 秒没有任何 move → 判定卡死
    if (drag.active && now - drag.lt > 1500) {
      log('[drag] 看门狗：1.5s 无移动，强制结束拖动');
      drag.active = false;
      try { win.webContents.send('pet:drag-info', { vx: 0, vy: 0 }); } catch (e) {}
    }
    try { geo.ensureRoamBounds(); } catch (e) {}
    // 置顶守护：别的程序（老桌宠、全屏应用）抢到顶层后，她的窗口会"消失"
    if (Date.now() - lastTopmostCheck > 5000) {
      lastTopmostCheck = Date.now();
      try {
        const wantTop = !!(settingsStore.getSettings().alwaysOnTop);
        if (wantTop && !win.isAlwaysOnTop()) {
          win.setAlwaysOnTop(true, 'screen-saver');
          log('[geo] 置顶被抢，已重新置顶');
        }
      } catch (e) {}
    }
    const r = geo.assertConsistent(win.getBounds(), { dragging: drag.active });
    if (!r.ok && r.reason === 'healed') {
      try { savePos(); } catch (e) {}
    }
  }, 1500);
}
// ── 逐像素点击穿透 ────────────────────────────────────────
// 主进程用「全局光标位置」轮询，问页面这个点是不是落在角色身上：
//   落在身上 → 窗口接收鼠标（可拖动 / 可点她）
//   透明区域 → 窗口放行鼠标（不影响你点桌面上的东西）
//
// 注意：setIgnoreMouseEvents 会让窗口重新合成一层，切换太频繁会"闪"。
// 所以这里做了三道闸：光标没动不测、缩放期间不测、切换要连续确认。
let ignoringNow = true;
let lastIgnoreChange = 0;
let pendingHit = null;
let pendingCount = 0;
let lastCursorSent = { x: -1, y: -1 };   // 上次推给页面的光标位置
let lastCursorSentAt = 0;
let cursorPinUntil = 0;   // 测试时钉住光标，别被真实光标覆盖
let lastTopmostCheck = 0;   // 上次确认置顶的时间
let lastHitAt = 0;      // 上次命中检测时间（光标静止也要复测）
let hitToken = 0;       // 丢弃过期的异步结果
let skipUntil = 0;              // 窗口正在改尺寸的这段时间不做命中检测
let lastCursor = { x: -1, y: -1 };
let ignoreToggles = 0;          // 调试用：切换了多少次
let hitTests = 0;               // 调试用：做了多少次命中检测

function applyIgnore(next, force) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (next === ignoringNow) {
    pendingHit = null;
    pendingCount = 0;
    return;
  }
  if (!force) {
    // 连续两次结果一致才切，而且两次切换至少隔 200ms
    if (pendingHit !== next) {
      pendingHit = next;
      pendingCount = 1;
      return;
    }
    pendingCount++;
    if (pendingCount < 2) return;
    if (now - lastIgnoreChange < 200) return;
  }
  ignoringNow = next;
  lastIgnoreChange = now;
  pendingHit = null;
  pendingCount = 0;
  ignoreToggles++;
  win.setIgnoreMouseEvents(next, { forward: true });
}

function startHitTestLoop() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;

    // 拖动过程中始终保持可交互，避免鼠标滑出身体时丢掉 mouseup
    if (drag.active) { applyIgnore(false, true); lastHitAt = Date.now(); return; }

    // 托盘/热键的「允许整窗交互」（排障用，会让整块窗口吃掉鼠标）
    if (interactive) { applyIgnore(false, true); lastHitAt = Date.now(); return; }

    // 窗口正在缩放/移动：这期间坐标对不上，检测结果没意义，直接跳过
    if (Date.now() < skipUntil) return;

    const p = screen.getCursorScreenPoint();

    // 把全屏光标位置推给页面：鼠标移出她的窗口（比如移到头顶上方）后，
    // 页面收不到 mousemove，视线就会"卡住不动"。这里由外壳统一供坐标。
    const nowC = Date.now();
    if (Date.now() >= cursorPinUntil && (p.x !== lastCursorSent.x || p.y !== lastCursorSent.y) && nowC - lastCursorSentAt > 40) {
      lastCursorSent = { x: p.x, y: p.y };
      lastCursorSentAt = nowC;
      try { win.webContents.send('pet:cursor', { x: p.x, y: p.y }); } catch (e) {}
    }

    const moved = p.x !== lastCursor.x || p.y !== lastCursor.y;
    // 关键修复：以前「光标不动就 return」，导致状态永久冻结在"接收鼠标"，
    // 结果是窗口变成一块挡板，她周围的东西全点不了。
    // 现在即使光标不动，也每 700ms 复测一次（readPixels 会打断 GPU 流水线）。
    if (!moved && Date.now() - lastHitAt < 700) return;
    if (moved) lastCursor = { x: p.x, y: p.y };
    lastHitAt = Date.now();

    const b = win.getBounds();
    const inWin = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (!inWin) { applyIgnore(true); return; }

    const cx = p.x - b.x;
    const cy = p.y - b.y;
    hitTests++;
    const token = ++hitToken;
    cmd('hitTest', { x: cx, y: cy })
      .then((hit) => {
        if (token !== hitToken) return;   // 有更新的一次检测了，丢弃旧结果
        applyIgnore(!hit);
      })
      .catch(() => {
        // 页面没响应时宁可放行鼠标：挡住整个桌面比点不到她严重得多
        try { applyIgnore(true); } catch (e) {}
      });
  }, 90);
}

// ── 托盘 ──────────────────────────────────────────────────
let sizeSaveTimer = null;
function applySize(w, h) {
  if (!geo) return;
  // 夹取 / 等比 / 位置回拉 / 尺寸落盘，全部交给 windowState（唯一真相）
  if (!geo.setSize(w, h)) return;
  skipUntil = Date.now() + 600;
  if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
  sizeSaveTimer = setTimeout(() => {
    try { savePos(); } catch (e) {}
  }, 800);
}

function applyInteractive() {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  }
  refreshTrayMenu();
}

function setInteractive(on) {
  interactive = !!on;
  applyInteractive();
  ignoringNow = !interactive;   // 账目同步，别让 /debug 显示假的
  log('interactive =', interactive);
  // 整窗交互会让整块窗口吃掉鼠标（她周围的桌面点不了），所以 60 秒后自动回到穿透
  if (interactiveTimer) clearTimeout(interactiveTimer);
  if (interactive) {
    interactiveTimer = setTimeout(() => {
      if (interactive) {
        setInteractive(false);
        log('整窗交互 60 秒超时，已自动恢复点击穿透');
      }
    }, 60000);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: interactive ? '⚠️ 整窗吞鼠标（60 秒后自动恢复穿透）' : '点击穿透（只在她身上接收鼠标）',
      click: () => setInteractive(!interactive),
    },
    { type: 'separator' },
    {
      label: '摄像头面捕',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        cmd('camera', { on: !!item.checked })
          .then((r) => log('camera ->', JSON.stringify(r)))
          .catch((e) => log('camera failed', String(e)));
      },
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    {
      label: '大小',
      submenu: [
        { label: '小', click: () => applySize(360, 520) },
        { label: '中', click: () => applySize(420, 620) },
        { label: '大', click: () => applySize(520, 760) },
        { label: '特大', click: () => applySize(640, 900) },
      ],
    },
    { type: 'separator' },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!win) return createWindow();
        if (win.isVisible()) win.hide(); else win.showInactive();
      },
    },
    {
      label: '回到右下角',
      click: () => {
        if (!win) return;
        const d = screen.getPrimaryDisplay().workAreaSize;
        const g = geo.get();
        geo.moveTo(Math.max(0, d.width - g.w - 24), Math.max(0, d.height - g.h - 24));
        savePos();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

// ── 按键说话：Electron 收键 → 写标记文件 → 语音桥读 ──────────────
// 为什么不用 python 读键盘：这台机器不给 python 进程键盘权限（GetAsyncKeyState 恒 0），
// 而 globalShortcut 是系统级注册，不受影响。
let pttAccel = null;

function toAccelerator(code) {
  if (!code) return null;
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const map = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Space: 'Space', Tab: 'Tab', CapsLock: 'Capslock', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  return map[code] || null;
}

function syncPttShortcut() {
  try {
    if (pttAccel) { globalShortcut.unregister(pttAccel); pttAccel = null; }
  } catch (e) {}
  let s = {};
  try { s = settingsStore.getSettings(); } catch (e) { return; }
  if (s.voiceMode !== 'ptt') { log('[ptt] 一直听模式，不注册快捷键'); return; }
  const accel = toAccelerator(s.pttKey);
  if (!accel) { log('[ptt] 这个键不支持注册：', s.pttKey); return; }
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => {
      try {
        fs.writeFileSync(path.join(settingsStore.PET_DIR, 'data', 'ptt.flag'), String(Date.now()), 'utf8');
      } catch (e) { log('[ptt] 写标记失败', String(e)); }
      try { cmd('bubble', { text: '我在听…', seconds: 1.6 }).catch(() => {}); } catch (e) {}
    });
  } catch (e) { ok = false; }
  if (ok) { pttAccel = accel; log('[ptt] 已注册快捷键', accel); }
  else { log('[ptt] 注册失败（可能被别的程序占用）', accel); }
}

function setupTray() {
  // 托盘图标：优先用 assets 里的新图标（她的脸），取不到再退回内嵌的 dataURL
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon_256.png'));
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
  }
  try {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch (e) {
    log('tray failed', String(e));
    return;
  }
  tray.setToolTip('大肥鱼桌宠（托盘菜单可切换点击穿透）');
  refreshTrayMenu();
  log('tray ready');
}

// ── 控制接口 ──────────────────────────────────────────────
function jsSet(params) {
  const json = JSON.stringify(params || {});
  return `(function(){window.__paramHold = window.__paramHold || {};var p=${json};` +
    `for (var k in p) { window.__paramHold[k] = p[k]; } return Object.keys(window.__paramHold).length;})()`;
}

function startApiServer() {
  const apiServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    // DSH 的打字插件在 web 页面里跨源调用这个 API，必须放行 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    };
    const body = (cb) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
      req.on('end', () => { try { cb(s ? JSON.parse(s) : {}); } catch (e) { send(400, { ok: false, error: 'bad json' }); } });
    };

    // 设置：GET 读当前配置，POST 打开设置窗口
    // 应用设置（JSON 补丁）：界面和脚本都走这里
    // 关闭设置窗口（脚本/测试用）
    // 脚本化退出（stop-pet.ps1 用）
    // 在设置窗口里执行 JS（调试 / 自动化测试用）
    // 直接触发一个菜单动作（自动化测试用）
    // 注入一个光标位置（自动化测试「全屏跟随」用；真实运行时由系统光标驱动）
    // GPU / 合成状态（掉帧排查）
    if (url === '/debug/gpu') {
      const out = { featureStatus: {}, info: {} };
      try { out.featureStatus = app.getGPUFeatureStatus() || {}; } catch (e) {}
      try {
        const info = app.getGPUInfo ? app.getGPUInfo('basic') : Promise.resolve({});
        return Promise.resolve(info).then((i) => { out.info = i && i.gpuDevice ? i.gpuDevice : i; return send(200, out); });
      } catch (e) { return send(200, out); }
    }

    if (url === '/test/cursor' && req.method === 'POST') {
      return body((d) => {
        try {
          if (!win || win.isDestroyed()) return send(500, { ok: false, error: 'no window' });
          cursorPinUntil = Date.now() + Number((d && d.pinMs) || 3000);
          try {
            win.webContents.executeJavaScript(
              'window.__cursorPinUntil = ' + cursorPinUntil + '; 1').catch(() => {});
          } catch (e) {}
          win.webContents.send('pet:cursor', { x: Number((d && d.x) || 0), y: Number((d && d.y) || 0) });
          return send(200, { ok: true });
        } catch (err) { return send(500, { ok: false, error: String(err) }); }
      });
    }

    if (url === '/menu/act' && req.method === 'POST') {
      return body((d) => {
        try {
          handleMenuAction(String((d && d.id) || ''));
          return send(200, { ok: true, id: (d && d.id) || '' });
        } catch (err) {
          return send(500, { ok: false, error: String(err) });
        }
      });
    }

    if (url === '/settings/eval' && req.method === 'POST') {
      return body((d) => {
        try {
          if (!settingsWin || settingsWin.isDestroyed()) return send(500, { ok: false, error: 'no settings window' });
          settingsWin.webContents.executeJavaScript(String((d && d.js) || 'null'), true)
            .then((result) => send(200, { ok: true, result: result === undefined ? null : result }))
            .catch((err) => send(500, { ok: false, error: String(err) }));
        } catch (err) {
          return send(500, { ok: false, error: String(err) });
        }
      });
    }

    if (url === '/quit' && req.method === 'POST') {
      send(200, { ok: true, quitting: true });
      setTimeout(() => { try { app.quit(); } catch (e) {} }, 150);
      return;
    }

    if (url === '/settings/close' && req.method === 'POST') {
      try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); } catch (e) {}
      return send(200, { ok: true });
    }

    if (url === '/settings/apply' && req.method === 'POST') {
      return body((d) => {
        try {
          const before = settingsStore.getSettings();
          const next = settingsStore.setSettings(d || {});
          settingsApply.apply(win, next, log, { setRoam: (on) => { try { geo.setRoam(on); } catch (e) {} } });
          try { syncPttShortcut(); } catch (e) {}
    // 只有音色这类启动时才读的配置需要重启；API 配置支持热重载
          if (d && d.voice && d.voice.voiceName && d.voice.voiceName !== before.voice.voiceName) settingsApply.restartBridge(log);
          return send(200, { ok: true, settings: next });
        } catch (err) {
          return send(500, { ok: false, error: String(err) });
        }
      });
    }

    if (url === '/settings') {
      if (req.method === 'POST') {
        openSettings();
        return send(200, { ok: true, opened: true });
      }
      return send(200, { ok: true, settings: settingsStore.getSettings(), windowOpen: !!settingsWin && !settingsWin.isDestroyed(), visible: !!settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible(), bounds: (settingsWin && !settingsWin.isDestroyed()) ? settingsWin.getBounds() : null });
    }

    if (url === '/state') {
      return send(200, {
        ok: true, model: MODEL,
        windowOpen: !!win && !win.isDestroyed(),
        visible: !!win && win.isVisible(),
        size: (function () { const g = geo.get(); return [g.w, g.h]; })(),
        staticPort: STATIC_PORT,
      });
    }
    // 调试：返回页面里的交互状态（是否接管鼠标 / 拖动中 / 犯困）
    if (url === '/debug') {
      if (!win || win.isDestroyed()) return send(503, { ok: false, error: 'no window' });
      return cmd('state')
        .then((s) => send(200, {
          ok: true,
          pet: s,
          main: {
        hitTests,
        ignoreToggles, ignoring: ignoringNow, interactive, dragging: drag.active },
        }))
        .catch((e) => send(500, { ok: false, error: String(e) }));
    }
    if (!win || win.isDestroyed()) return send(503, { ok: false, error: 'no window' });

    if ((url === '/set') && req.method === 'POST') {
      return body((d) => {
        cmd('setParams', { params: d.params || d })
          .then((n) => send(200, { ok: true, holding: n }))
          .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    if ((url === '/mouth' || url === '/say') && req.method === 'POST') {
      return body((d) => {
        const v = Math.max(0, Math.min(1, Number(d.open != null ? d.open : d.value || 0)));
        cmd('mouth', { v })
          .then(() => send(200, { ok: true, mouth: v }))
          .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 反应：surprise / happy / nod / shake / sleep / wake
    if (url === '/react' && req.method === 'POST') {
      return body((d) => {
        const kind = String(d.kind || d.name || 'happy');
        cmd('react', { kind })
          .then((r) => send(200, { ok: true, kind, applied: !!r }))
         .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 调试：在页面里执行一段 JS（仅本机，用于自动化测试）
    if (url === '/eval' && req.method === 'POST') {
      return body((d) => {
        const code = String(d.js || d.code || '');
        if (!code) return send(400, { ok: false, error: 'empty js' });
        runJs(code)
          .then((r) => send(200, { ok: true, result: r }))
          .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 播放语音文件（pet_voice.py 用 edge-tts 合成好的 mp3），并同步显示气泡文字
    if (url === '/play' && req.method === 'POST') {
      return body((d) => {
        const file = path.basename(String(d.file || ''));
        const dur = Number(d.duration || 0);
        const text = String(d.text || '');
        if (!file) return send(400, { ok: false, error: 'no file' });
        const src = '/audio/' + encodeURIComponent(file);
        cmd('play', { src, duration: dur, text, dur: dur > 0 ? dur + 0.6 : 0 })
          .then((r) => send(200, { ok: true, file, played: !!r, bubble: !!text }))
         .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 摄像头面捕开关
    if (url === '/camera' && req.method === 'POST') {
      return body((d) => {
        const on = !!(d.on != null ? d.on : d.value);
        cmd('camera', { on })
          .then((r) => send(200, { ok: true, on, result: r }))
          .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    if (url === '/camera') {
      return cmd('faceStatus')
        .then((r) => send(200, { ok: true, status: r }))
       .catch((e) => send(500, { ok: false, error: String(e) }));
    }
    // 插件回报日志（浏览器控制台我看不到，写进外壳日志方便排查）
    if (url === '/log' && req.method === 'POST') {
      return body((d) => {
        log('[plugin]', String(d.msg || '').slice(0, 400));
        return send(200, { ok: true });
      });
    }
    // 文本队列：外部把要打的字放进队列，DSH 插件轮询取走
    if (url === '/queue' && req.method === 'POST') {
      return body((d) => {
        const t = String(d.text || '');
        if (d.clear) textQueue.push({ clear: true, at: Date.now() });
        if (t) textQueue.push({ text: t, at: Date.now() });
        return send(200, { ok: true, queued: textQueue.length });
      });
    }
    if (url === '/pending') {
      const item = textQueue.shift();
      return send(200, { ok: true, text: item && item.text ? item.text : "", clear: !!(item && item.clear), left: textQueue.length });
    }
    // 调整窗口大小（页面 resize 后会自动重新适配角色）
    if (url === '/size' && req.method === 'POST') {
      return body((d) => {
        const w = Number(d.w || d.width || 0);
        const h = Number(d.h || d.height || 0);
        if (!(w > 0 && h > 0)) return send(400, { ok: false, error: 'need w/h' });
        applySize(w, h);
        const g2 = geo.get(); return send(200, { ok: true, w: g2.w, h: g2.h });
      });
    }
    // 移动窗口（不改尺寸），方便外部把她挪开
    if (url === '/position' && req.method === 'POST') {
      return body((d) => {
        const x = Number(d.x), y = Number(d.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return send(400, { ok: false, error: 'need x/y' });
        const p = geo.moveTo(x, y);
        savePos();
        return send(200, { ok: true, x: p.x, y: p.y });
      });
    }
    // 小动作：摇头 / 点头 / 歪头 / 晃身子 / 晃脑袋
    if (url === '/gesture' && req.method === 'POST') {
      return body((d) => {
        const kind = String(d.kind || d.name || '');
        cmd('gesture', { kind })
          .then((r) => send(200, { ok: true, kind, applied: !!r }))
         .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 表情 / 动作（模型自带 23 个表情 + 6 个手部动作）
    if (url === '/expression' && req.method === 'POST') {
      return body((d) => {
        const name = String(d.name || d.expression || '');
        const ms = Number(d.ms || 0);
        cmd('expression', { name, ms })
          .then((r) => send(200, { ok: true, name, applied: !!r }))
          .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    if (url === '/motion' && req.method === 'POST') {
      return body((d) => {
        const group = String(d.group || d.name || '');
        const no = Number(d.no || 0);
        cmd('motion', { group, no })
          .then((r) => send(200, { ok: true, group, applied: !!r }))
         .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    if (url === '/lists') {
      return cmd('lists')
        .then((r) => send(200, { ok: true, lists: r }))
        .catch((e) => send(500, { ok: false, error: String(e) }));
    }
    // 只显示气泡（不说话）
    if (url === '/bubble' && req.method === 'POST') {
      return body((d) => {
        const text = String(d.text || '');
        const dur = Number(d.seconds || 0);
        cmd('bubble', { text, seconds: dur })
         .then((r) => send(200, { ok: true, shown: !!r }))
         .catch((e) => send(500, { ok: false, error: String(e) }));
      });
    }
    // 交互开关：true = 窗口接收鼠标（可拖动/点击她），false = 点击穿透
    if (url === '/interactive' && req.method === 'POST') {
      return body((d) => {
        const on = !!(d.on != null ? d.on : d.value);
        setInteractive(on);   // 统一入口：账目、托盘菜单、60 秒自动恢复都走这里
        send(200, { ok: true, interactive });
      });
    }
    if (url === '/clear' && req.method === 'POST') {
      return cmd('clear')
        .then(() => send(200, { ok: true }))
        .catch((e) => send(500, { ok: false, error: String(e) }));
    }
    if (url === '/reload' && req.method === 'POST') {
      win.reload();
      return send(200, { ok: true });
    }
    return send(404, { ok: false, error: 'unknown endpoint' });
  });
  apiServer.listen(API_PORT, '127.0.0.1', () => log('api on', API_PORT));
  apiServer.on('error', (e) => log('[api] 监听失败', e.code, '（可能另一份在跑）'));
}

// ── 启动 ──────────────────────────────────────────────────
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

log('=== pet shell start pid=' + process.pid + ' model=' + MODEL);

app.whenReady().then(() => {
  allowMediaPermissions();
  initGeometry();   // 窗口几何唯一真相，必须在 createWindow 之前建好
  try {
    startStaticServer();
    startApiServer();
    setupIpc();
    createWindow();
    setupTray();
    applyInteractive();
    startHitTestLoop();
    startGeometryWatchdog();
    try { settingsApply.apply(win, settingsStore.getSettings(), log, { setRoam: (on) => { try { geo.setRoam(on); } catch (e) {} } }); } catch (e) {}
    // 按键说话：启动时按设置注册（一直听模式不会注册）
    try { syncPttShortcut(); } catch (e) { log('[ptt] 启动注册失败', String(e)); }

    // 全局热键：切换「点击穿透 / 可交互」。桌宠被堵住又不想开托盘时按这个。
    try {
      const { globalShortcut } = require('electron');
      const ok = globalShortcut.register('Control+Alt+P', () => setInteractive(!interactive));
  // 缩放快捷键：Ctrl+Alt+= 放大 / Ctrl+Alt+- 缩小 / Ctrl+Alt+0 复位
  const scaleStep = (k) => {
    const g = geo.get(); applySize(g.w * k, g.h * k);
  };
  globalShortcut.register('Control+Alt+=', () => scaleStep(1.1));
  globalShortcut.register('Control+Alt+-', () => scaleStep(1 / 1.1));
  globalShortcut.register('Control+Alt+0', () => applySize(520, 760));
  globalShortcut.register('Control+Alt+Up', () => scaleStep(1.1));
  globalShortcut.register('Control+Alt+Down', () => scaleStep(1 / 1.1));
      log('hotkey Ctrl+Alt+P registered =', ok);
    } catch (e) {
      log('hotkey failed', String(e));
    }
  } catch (e) {
    log('startup failed', e && e.stack ? e.stack : String(e));
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  try {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
  } catch (e) {}
});

app.on('window-all-closed', () => app.quit());
