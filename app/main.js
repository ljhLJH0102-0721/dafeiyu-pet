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
const { createPluginHost } = require('./shell/plugins');
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

// ── 插件宿主（创意工坊）────────────────────────────────
const pluginHost = createPluginHost({
  dir: path.join(__dirname, 'plugins'),
  log,
  getSettings: () => settingsStore.getSettings(),
  savePlugins: (id, on) => {
    const s = settingsStore.getSettings();
    const map = Object.assign({}, s.plugins || {});
    map[id] = !!on;
    settingsStore.setSettings({ plugins: map });
  },
});

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
let dragToMsgs = 0;   // 收到的 drag-to 消息数（调试）
let dragWrites = 0;   // 实际执行的窗口移动次数（去重后）
// 衣柜状态缓存（页面是真相，这里只给右键菜单打勾用）
let wardrobeState = {};
const drag = { active: false, sx: 0, sy: 0, wx: 0, wy: 0, lx: 0, ly: 0, lt: 0, tx: -99999, ty: -99999,
  gx: 0, gy: 0, px: 0, py: 0, timer: 0 };

/**
 * 舞台尺寸：窗口固定这么大，缩放只改舞台里的角色大小。
 *
 * 为什么这么做：每次改窗口尺寸都要重建透明表面 + 重新投影模型，
 * 合成器还会先显示"旧画面按新窗口裁剪"的一帧（她脚离底边只有 30px，一裁就是腿）。
 * 固定窗口后，缩放完全在渲染层做，连续、平滑、也不会再触发 setBounds 崩溃。
 */
function stageSize() {
  let wa = { width: 1536, height: 864 };
  try { wa = screen.getPrimaryDisplay().workAreaSize; } catch (e) {}
  const w = Math.max(360, Math.min(620, Math.round(wa.width) - 40));
  const h = Math.max(480, Math.min(Math.round(wa.height * 0.96), 860));
  return { w, h };
}

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
  // 舞台模式：窗口尺寸固定，缩放只改舞台里的角色大小（见 stageSize 注释）。
  // geo.initialBounds() 仍然读一次，只为了拿到"上次她占多大、在哪"，
  // 用来把舞台中心放到她原来的中心上——升级后位置不会突然跳。
  const saved = geo.initialBounds();
  const stage = stageSize();
  const cx = saved.x + saved.width / 2;
  const cy = saved.y + saved.height / 2;
  const bounds = {
    x: Math.round(cx - stage.w / 2),
    y: Math.round(cy - stage.h / 2),
    width: stage.w,
    height: stage.h,
  };
  geo.setStage(bounds);

  win = new BrowserWindow({
    title: '大肥鱼',
    // 必须是可聚焦窗口。
    // focusable:false 的窗口在 Windows 上"隐藏再显示"之后就再也收不到鼠标点击了
    // （WindowFromPoint 还能找到它，但 WM_LBUTTONDOWN 不投递）——
    // 实测：隐藏→showInactive 后点她毫无反应；setFocusable(true) 立刻恢复。
    // 代价：点她时她的窗口会拿到焦点（拖动必然要求能接收点击）。
    focusable: true,
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    // 关键：thickFrame 为真时 Windows 会给窗口一个"可调整大小的边框"，
    // 缩放瞬间会闪出一圈 1px 的框线（用户看到的"线条边边"）。
    // 我们缩放走的是滚轮/菜单（setBounds），不需要拖窗口边缘，所以关掉它。
    thickFrame: false,
    // 圆角也一样：Windows 11 的圆角遮罩在窗口尺寸变化时可能露出边缘
    roundedCorners: false,
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
  win.webContents.on('did-finish-load', () => {
    log('page loaded');
    injectPlugins();
    // 舞台模式下窗口尺寸不再承载"她多大"，所以首次升级时要按上次记录的尺寸换算出倍率；
    // 页面若已经存过 zoom（localStorage），以页面为准。
    setTimeout(() => {
      runJs('localStorage.getItem("pet.zoom")').then((z) => {
        if (z) return;
        const s = geo.loadPos ? geo.loadPos() : null;
        if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) applySize(s.w, s.h);
      }).catch(() => {});
    }, 1800);
  });

  // 用户手动拖边缩放 → 交给 geo 对账（拖动中一律忽略，≤2px 抖动忽略）
  let resizeSaveTimer = null;
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    noteResizeCooldown();
    const r = geo.reconcile(win.getBounds(), { dragging: drag.active });
    if (!r.changed) return;
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      try { savePos(); } catch (e) {}
    }, 600);
  });

  // 唤回瞬间把交互状态重置干净：不等防抖、立刻重测一次命中
  win.on('show', () => {
    try {
      // 唤回时重新隐藏任务栏按钮（hide/show 会让它回来）
      try { win.setSkipTaskbar(true); } catch (e) {}
      forceNextHit = true;
      drag.active = false;
      skipUntil = 0;
      lastHitAt = 0;
      pendingHit = null;
      pendingCount = 0;
      // 关键：唤回后直接让窗口接收鼠标 1.5 秒。
      // 命中检测要等光标移动 + 防抖，这期间窗口是点击穿透的，
      // 用户一唤回就去抓她会抓到桌面 → 体感"拖不动"。
      try { applyIgnore(false, true); } catch (e) {}
      setTimeout(() => { forceNextHit = true; lastHitAt = 0; }, 1500);
      runJs('(function(){ if (window.__resetDrag) window.__resetDrag(); return 1; })()').catch(() => {});
      log('[show] 已重置交互状态');
    } catch (e) {}
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


// ── 创意工坊窗口 ──────────────────────────────────────────
let workshopWin = null;

function openWorkshop() {
  if (workshopWin && !workshopWin.isDestroyed()) {
    workshopWin.show();
    workshopWin.focus();
    return;
  }
  workshopWin = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 540,
    title: '大肥鱼 · 创意工坊',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon_256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-workshop.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  workshopWin.loadFile(path.join(__dirname, 'workshop.html'));
  try { workshopWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
  workshopWin.once('ready-to-show', () => {
    try { workshopWin.show(); workshopWin.focus(); workshopWin.moveTop(); } catch (e) {}
  });
  workshopWin.on('closed', () => { workshopWin = null; });
}

ipcMain.handle('workshop:list', () => {
  try { pluginHost.scan(); } catch (e) {}
  return pluginHost.list();
});
ipcMain.handle('workshop:rescan', () => {
  const list = pluginHost.scan();
  injectPlugins();
  return list.length;
});
ipcMain.handle('workshop:toggle', (_e, d) => {
  pluginHost.setEnabled(String((d && d.id) || ''), !!(d && d.on));
  injectPlugins();
  return { ok: true };
});
ipcMain.handle('workshop:openDir', () => {
  try { require('electron').shell.openPath(pluginHost.baseDir); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('workshop:template', (_e, d) => {
  const r = pluginHost.createTemplate((d && d.id) || '');
  if (r && r.ok) {
    injectPlugins();
    try { require('electron').shell.openPath(r.dir); } catch (e) {}
  }
  return r;
});
ipcMain.on('workshop:close', () => { try { if (workshopWin && !workshopWin.isDestroyed()) workshopWin.close(); } catch (e) {} });

/** 把启用插件的入口 JS 注入页面（每次页面加载 / 插件变更后调用） */
function injectPlugins() {
  try {
    if (!win || win.isDestroyed()) return;
    const scripts = pluginHost.entryScripts();
    let chain = Promise.resolve();
    for (const s of scripts) {
      chain = chain.then(() => win.webContents.executeJavaScript(
        '(function(){try{\n' + s.code + '\n}catch(e){console.error("[plugin:' + s.id + ']", e);}return 1;})()',
        true
      ).catch((e) => log('[plugin] 注入失败 ' + s.id, String(e))));
    }
    chain.then(() => log('[plugins] 已注入 ' + scripts.length + ' 个插件'));
  } catch (e) {
    log('[plugins] 注入异常', String(e));
  }
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

  // ── 衣柜（原模型自带的服装/配件开关）──────────────────────
  // 页面是真相：它把参数写进 paramHold 并持久化；主进程只缓存一份给菜单打勾用。
  ipcMain.on('pet:wardrobe-state', (_e, st) => {
    if (st && typeof st === 'object') wardrobeState = st;
    try { refreshTrayMenu(); } catch (e) {}
  });


  /** 明确设置某个衣柜开关（关掉时传 false） */
  function setWardrobe(key, on) {
    runJs('window.__petWardrobe && window.__petWardrobe(' + JSON.stringify(key) + ', ' + (on ? 'true' : 'false') + ')').catch(() => {});
  }

  /** 菜单里点一下：切换某个衣柜开关 */
  function toggleWardrobe(key) {
    runJs('window.__petWardrobe && window.__petWardrobe(' + JSON.stringify(key) + ')').catch(() => {});
  }

  ipcMain.on('pet:scale', (_e, k) => {
    const f = Number(k) || 1;
    if (!Number.isFinite(f) || f <= 0 || f === 1) return;
    // 滚轮是「相对」缩放：必须交给页面按当前倍率乘。
    // 以前用窗口尺寸 × 系数 —— 舞台模式下窗口尺寸恒定，
    // 每次滚轮都算到同一个目标倍率，所以她看起来滚不动。
    runJs('window.__petZoomBy && window.__petZoomBy(' + f + ')').catch(() => {});
  });

  ipcMain.on('pet:drag-start', (_e, p) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const g = geo.get();
    drag.active = true;
    drag.sx = p.x; drag.sy = p.y;
    drag.wx = b.x; drag.wy = b.y;
    drag.lx = p.x; drag.ly = p.y; drag.lt = Date.now();
    drag.tx = -99999; drag.ty = -99999;   // 复位去重基准
    // 抓取偏移：光标 - 窗口位置。之后每帧用「当前光标 - 抓取偏移」算目标。
    // 用页面上报的 p.x/p.y（mousedown 那一刻的 screenX/Y），不要用
    // screen.getCursorScreenPoint()：光标刚瞬移过来时它可能还是旧值，
    // 偏移就会算错 → 拖动方向反了/拖不动（实测抓到过）。
    const cur = screen.getCursorScreenPoint();
    const grabX = Number.isFinite(p.x) ? p.x : cur.x;
    const grabY = Number.isFinite(p.y) ? p.y : cur.y;
    drag.gx = grabX - b.x;
    drag.gy = grabY - b.y;
    drag.px = b.x; drag.py = b.y;
    startDragLoop();
    log('[drag] start geo=', g.w, g.h);
  });

  /**
   * 拖动循环（主进程侧，~75Hz）。
   *
   * 为什么不放在页面里：门口那边要靠 mousemove，而窗口是在"追"光标的——
   * 弹簧稍微落后一点，光标就跑到窗口外面，页面收不到 mousemove，目标停止更新，
   * 窗口追上去、光标又进来……结果是"一顿一顿"。主进程直接读全局光标就没有这个问题。
   *
   * 弹簧：指数平滑（时间常数 34ms），把光标的高频抖动抹平，运动是连续的。
   */
  function startDragLoop() {
    if (drag.timer) return;
    // 刚性跟手：不做平滑。窗口移动由 100Hz 循环 + 去重控制，
    // 再叠一层指数平滑只会引入延迟（用户体感就是"粘"）。
    // 想恢复一点柔顺感，把 TAU 改成 8~12 即可。
    const TAU = 0;
    drag.timer = setInterval(() => {
      if (!drag.active || !win || win.isDestroyed()) {
        clearInterval(drag.timer);
        drag.timer = 0;
        return;
      }
      const cur = screen.getCursorScreenPoint();
      const targetX = cur.x - drag.gx;
      const targetY = cur.y - drag.gy;
      const a = TAU > 0 ? 1 - Math.exp(-10 / TAU) : 1;
      drag.px += (targetX - drag.px) * a;
      drag.py += (targetY - drag.py) * a;
      const x = Math.round(drag.px);
      const y = Math.round(drag.py);
      if (x === drag.tx && y === drag.ty) return;   // 同一像素不重复移动
      const now = Date.now();
      const dt = Math.max(1, now - drag.lt);
      const vx = drag.tx === -99999 ? 0 : ((x - drag.tx) / dt) * 16;
      const vy = drag.ty === -99999 ? 0 : ((y - drag.ty) / dt) * 16;
      drag.tx = x; drag.ty = y;
      drag.lt = now;
      const g = geo.get();
      const d = screen.getPrimaryDisplay().workAreaSize;
      // 任何一环变成 NaN 都会让 setBounds 抛 "conversion failure"，主进程弹窗崩掉。
      // 逐项守住：非有限值这一帧直接跳过。
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(g.w) || !Number.isFinite(g.h)) return;
      // 舞台模式：窗口比她大，按「窗口中心」夹 —— 中心最多贴到离屏幕边 80px，
      // 她最多挂出去一点，不会被整只拖到屏幕外（以前按窗口边夹，大窗口能拖没）。
      const margin = 80;
      const cx = Math.max(margin - g.w / 2, Math.min(d.width - margin - g.w / 2, x));
      const cy = Math.max(margin - g.h / 2, Math.min(d.height - margin - g.h / 2, y));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
      dragWrites++;
      geo.moveTo(cx, cy);
      try { win.webContents.send('pet:drag-info', { vx, vy }); } catch (e) {}
    }, 10);
  }

  // 拖动：页面侧弹簧算好的绝对窗口位置（每帧一次）。
  // 主进程只做三件事：夹到屏内、去重、移动窗口。
  // 去重是必须的：同一像素重复 setBounds 会白白触发一次窗口移动，
  // 而"读回值"不能拿来比较（DIP↔物理像素往返会永远差 1px，去重就失效）。

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
        label: '外观',
        submenu: [
          { label: '换裙子', type: 'checkbox', checked: !!wardrobeState.skirt, click: () => toggleWardrobe('skirt') },
          { label: '尾巴', type: 'checkbox', checked: !!wardrobeState.tail, click: () => toggleWardrobe('tail') },
          { label: '胸口衣服', type: 'checkbox', checked: !!wardrobeState.chest, click: () => toggleWardrobe('chest') },
          { label: '脱鞋', type: 'checkbox', checked: !!wardrobeState.shoes, click: () => toggleWardrobe('shoes') },
          { type: 'separator' },
          {
            label: '体型',
            submenu: [
              { label: '默认', type: 'checkbox', checked: !wardrobeState.body1 && !wardrobeState.body2, click: () => { setWardrobe('body1', false); setWardrobe('body2', false); } },
              { label: '体型1', type: 'checkbox', checked: !!wardrobeState.body1, click: () => toggleWardrobe('body1') },
              { label: '体型2', type: 'checkbox', checked: !!wardrobeState.body2, click: () => toggleWardrobe('body2') },
            ],
          },
          {
            label: '眼镜',
            submenu: [
              { label: '无', type: 'checkbox', checked: !wardrobeState.glassesBlack && !wardrobeState.glassesMono, click: () => { setWardrobe('glassesBlack', false); setWardrobe('glassesMono', false); } },
              { label: '黑框眼镜', type: 'checkbox', checked: !!wardrobeState.glassesBlack, click: () => toggleWardrobe('glassesBlack') },
              { label: '单片眼镜', type: 'checkbox', checked: !!wardrobeState.glassesMono, click: () => toggleWardrobe('glassesMono') },
            ],
          },
          { label: '钢盆', type: 'checkbox', checked: !!wardrobeState.bowl, click: () => toggleWardrobe('bowl') },
          { label: '加载条', type: 'checkbox', checked: !!wardrobeState.loading, click: () => toggleWardrobe('loading') },
          { label: '竖食指', type: 'checkbox', checked: !!wardrobeState.point, click: () => toggleWardrobe('point') },
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
      { id: 'miccheck', label: '麦克风自检', icon: '🎤' },
      { sep: true },
      { id: 'g-exp', label: '表情', icon: '', chips: EXPRESSIONS.map((n) => ({ id: 'exp:' + n, label: n })) },
      { id: 'g-mot', label: '动作', icon: '', chips: MOTIONS.map((n) => ({ id: 'mot:' + n, label: n })) },
      { sep: true },
      // 插件贡献的菜单项（创意工坊里装的）
      ...pluginHost.menuItems(),
      { id: 'workshop', label: '创意工坊', icon: '🧩' },
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
  if (id === 'miccheck') {
    // 麦克风自检：让语音桥录 5 秒，分析完用她的话报告结果
    try {
      const p = path.join(settingsStore.PET_DIR, 'command.txt');
      fs.writeFileSync(p, 'MICCHECK:', 'utf8');
      log('[miccheck] 已请求麦克风自检');
    } catch (e) { log('[miccheck] 写入失败', String(e)); }
    return;
  }
  if (id === 'workshop') {
    openWorkshop();
    return;
  }
  if (id.startsWith('plugin:')) {
    // plugin:<插件id>:<动作id>
    const parts = String(id).split(':');
    const pid = parts[1] || '';
    const act = parts.slice(2).join(':') || '';
    const js = '(function(){ try { return !!window.__runPlugin(' + JSON.stringify(pid) + ', ' + JSON.stringify(act) + '); } catch (e) { return false; } })()';
    runJs(js)
      .then((ok) => { if (!ok) log('[plugin] 未处理:', pid, act); })
      .catch(() => {});
    return;
  }
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
      runJs('window.__petZoomBy && window.__petZoomBy(1.06)').catch(() => {});
      break;
    case 'size-down':
      runJs('window.__petZoomBy && window.__petZoomBy(' + (1 / 1.06) + ')').catch(() => {});
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
      // 任务栏守护：skipTaskbar 在 hide/show 之后会失效（Electron 用
      // ITaskbarList::DeleteTab 实现，窗口重新映射时按钮会回来）。
      // 用户看到的就是"后台突然在任务栏冒出一个图标"。
      try { if (win.isVisible()) win.setSkipTaskbar(true); } catch (e) {}
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
let skipUntil = 0;
let lastHitBody = false;   // 上一次命中检测是否落在她身上

/**
 * 窗口尺寸刚变过：短暂跳过命中检测（避免穿透状态抖动），
 * 但别让人干等——光标如果就在她身上，直接给"可交互"，
 * 冷却结束立刻重测一次。
 *
 * 以前这里是 skipUntil = +600ms 且什么都不做：缩放后她要"卡" 0.6 秒才
 * 能被抓住（用户体感：放大缩小后拖不动一小会）。
 */
function noteResizeCooldown() {
  // 冷却 700ms：缩放后你会马上伸手去抓她，而页面在新尺寸下重画完之前，
  // 命中检测可能读到旧像素判成"不在她身上"。这段时间宁可先让她可交互，
  // 结束时再强制重测一次恢复正确状态（回归 C1 靠这个兜底）。
  skipUntil = Date.now() + 700;
  lastHitAt = 0;                  // 冷却一结束马上测
  lastCursor = { x: -1, y: -1 };
  try {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    // 缩放瞬间光标一般就在她身上（滚轮/快捷键都是在看她的时候按的）。
    // 这一小段先给"可交互"，否则缩放后立刻去抓她会抓到桌面（体感：拖不起来）。
    if (inside) applyIgnore(false, true);
    // 冷却结束强制重测一次，恢复正确的穿透状态
    // （否则光标在透明区时会一直保持可交互，变成挡板 —— 回归 C1 会抓到）
    setTimeout(() => {
      forceNextHit = true;
      lastHitAt = 0;
      lastCursor = { x: -1, y: -1 };
    }, 720);
  } catch (e) {}
}
let forceNextHit = false;   // 刚唤回时：第一次检测结果直接生效，不等防抖              // 窗口正在改尺寸的这段时间不做命中检测
let lastCursor = { x: -1, y: -1 };
// 上一次"命中她"时的光标位置（用来判断"没命中"是不是光标没动导致旧结果）
let lastCursorHit = { x: -1, y: -1 };
let ignoreToggles = 0;          // 调试用：切换了多少次
let hitTests = 0;               // 调试用：做了多少次命中检测

function applyIgnore(next, force) {
  // 拖动中绝不切成穿透：Windows 会因此丢掉鼠标捕获，mouseup 收不到，拖到一半就断
  if (next && drag.active) return;
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (next !== ignoringNow) log('[ignore]', ignoringNow ? '穿透' : '可交互', '→', next ? '穿透' : '可交互', force ? '(强制)' : '');
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

    // 调试：/test/cursor 带 forLoop 时，命中循环也吃注入坐标（真实鼠标在别处也能复现）
    const forced = globalThis.__forceCursor;
    const p = forced && Date.now() < (forced.until || 0)
      ? { x: forced.x, y: forced.y }
      : screen.getCursorScreenPoint();

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
    // 现在即使光标不动也定期复测：窗口刚缩放完的那一下，页面还没按新尺寸重画，
    // 立即测会读到旧/空的像素 → 判成"不在她身上"→ 变点击穿透，光标不动就一直错下去
    // （用户体感：缩放后手不挪直接点她，拖不起来）。所以间隔改短到 260ms。
    if (!moved && Date.now() - lastHitAt < 260) return;
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
        // 拖动已经开始：这次结果是"按下之前"发起的，作废。
        // 否则它会把窗口切成穿透 → 鼠标捕获丢失 → 拖动立刻中断（体感：拖不动/粘手）
        if (drag.active) return;
        // 非对称防抖：
        //   命中（光标确实落在她身上）→ 立刻切成可交互，否则用户一按下就落到桌面上；
        //   落空（透明处）→ 仍然防抖，避免边界抖动导致窗口状态来回闪。
        // 另外：光标**没动**时，这次"没命中"多半是窗口刚移动/刚重绘导致的旧结果，
        // 此时不许把"可交互"翻成"穿透" —— 否则鼠标在她身上也会被切成穿透，
        // 体感就是"手一停就拖不动了 / 发粘"。
        const movedSinceHit = Math.abs(p.x - lastCursorHit.x) > 2 || Math.abs(p.y - lastCursorHit.y) > 2;
        if (!hit && lastHitBody && !movedSinceHit) return;
        forceNextHit = false;
        lastHitBody = !!hit;
        if (hit) lastCursorHit = { x: p.x, y: p.y };
        applyIgnore(!hit, !!hit);
      })
      .catch(() => {
        // 页面没响应时宁可放行鼠标：挡住整个桌面比点不到她严重得多
        try { applyIgnore(true); } catch (e) {}
      });
  }, 60);
}

// ── 托盘 ──────────────────────────────────────────────────
let sizeSaveTimer = null;
// 缩放动画：以前每按一下快捷键，窗口尺寸"啪"地跳 8%，看起来就是一抖一抖的。
// 现在把尺寸变化摊成 ~130ms 的补间（ease-out），每次只走几像素，
// 肉眼是平滑放大/缩小，而不是一格一格跳。
const SIZE_ANIM_MS = 130;
let sizeAnim = { timer: 0, from: null, to: null, t0: 0 };
/**
 * 缩放 = 改「舞台里的角色大小」，**不再改窗口尺寸**。
 *
 * 参数沿用老的 (w, h)：表示"她大概占多大"。按舞台高度换算成倍率：
 * 舞台高 h_stage 时，倍率 1.0 的角色约高 0.82 × h_stage。
 * 倍率上下限交给页面（fit.setZoom 自己会夹）。
 */
function applySize(w, h) {
  if (!geo) return;
  const g = geo.get();
  const targetH = Number(h) || 0;
  if (!Number.isFinite(targetH) || targetH <= 0 || !Number.isFinite(g.h) || g.h <= 0) return;
  const z = Math.max(0.35, Math.min(1.4, targetH / (g.h * 0.82)));
  const js = '(function(){ try { return window.__petSetZoom(' + z.toFixed(4) + '); } catch (e) { return 0; } })()';
  runJs(js).catch(() => {});
  if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
  sizeSaveTimer = setTimeout(() => {
    try { savePos(); } catch (e) {}
  }, 400);
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
        if (win.isVisible()) {
          win.hide();
        } else {
          // 唤回时重新激活输入（focusable 窗口 + focus），否则可能收不到点击
          try { win.setFocusable(true); } catch (e) {}
          win.showInactive();
          setTimeout(() => { try { win.focus(); } catch (e) {} }, 60);
        }
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
    // 插件状态（调试 / 回归测试用）
    if (url === '/plugins') {
      try {
        return send(200, {
          ok: true,
          plugins: pluginHost.list(),
          menu: pluginHost.menuItems(),
          dir: pluginHost.baseDir,
        });
      } catch (e) { return send(500, { ok: false, error: String(e) }); }
    }
    if (url === '/debug/gpu') {
      const out = { featureStatus: {}, info: {} };
      try { out.featureStatus = app.getGPUFeatureStatus() || {}; } catch (e) {}
      try {
        const info = app.getGPUInfo ? app.getGPUInfo('basic') : Promise.resolve({});
        return Promise.resolve(info).then((i) => { out.info = i && i.gpuDevice ? i.gpuDevice : i; return send(200, out); });
      } catch (e) { return send(200, out); }
    }

    if (url === '/test/show' && req.method === 'POST') {
      try {
        if (!win || win.isDestroyed()) return send(503, { ok: false, error: 'no window' });
        win.showInactive();
        setTimeout(() => { try { win.focus(); } catch (e) {} }, 60);
        return send(200, { ok: true, visible: win.isVisible() });
      } catch (e) { return send(500, { ok: false, error: String(e) }); }
    }
    if (url === '/test/hide' && req.method === 'POST') {
      try {
        if (!win || win.isDestroyed()) return send(503, { ok: false, error: 'no window' });
        win.hide();
        return send(200, { ok: true, visible: win.isVisible() });
      } catch (e) { return send(500, { ok: false, error: String(e) }); }
    }
    // 测试：不带 forward 选项地恢复鼠标（验证 Electron forward:true 的残留问题）
    // 测试：唤回后换几种方式重新激活，看书能不能收到点击
    if (url === '/test/click' && req.method === 'POST') {
      try {
        if (!win || win.isDestroyed()) return send(503, { ok: false, error: 'no window' });
        return body((d) => {
          const x = Number((d && d.x) || 0);
          const y = Number((d && d.y) || 0);
          const opts = { x, y, button: 'left', clickCount: 1 };
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          win.webContents.sendInputEvent({ type: 'mouseDown', ...opts });
          setTimeout(() => {
            try {
              win.webContents.sendInputEvent({ type: 'mouseMove', x: x - 60, y: y + 40 });
              win.webContents.sendInputEvent({ type: 'mouseUp', ...opts });
            } catch (e) {}
          }, 120);
          return send(200, { ok: true, sent: [x, y] });
        });
      } catch (e) { return send(500, { ok: false, error: String(e) }); }
    }
    if (url === '/test/cursor' && req.method === 'POST') {
      return body((d) => {
        try {
          if (!win || win.isDestroyed()) return send(500, { ok: false, error: 'no window' });
          cursorPinUntil = Date.now() + Number((d && d.pinMs) || 3000);
          if (d && d.forLoop) {
            globalThis.__forceCursor = {
              x: Number(d.x) || 0,
              y: Number(d.y) || 0,
              until: cursorPinUntil,
            };
          }
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
        dragToMsgs, dragWrites,
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
  try { pluginHost.scan(); } catch (e) { log('[plugins] 启动扫描失败', String(e)); }
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
    if (!Number.isFinite(k) || k <= 0) return;
    // 相对缩放：交给页面（它才知道当前倍率；窗口是固定舞台，不能用它算）
    runJs('window.__petZoomBy && window.__petZoomBy(' + k + ')').catch(() => {});
  };
  globalShortcut.register('Control+Alt+=', () => scaleStep(1.04));
  globalShortcut.register('Control+Alt+-', () => scaleStep(1 / 1.04));
  globalShortcut.register('Control+Alt+0', () => applySize(520, 760));
  globalShortcut.register('Control+Alt+Up', () => scaleStep(1.04));
  globalShortcut.register('Control+Alt+Down', () => scaleStep(1 / 1.04));

  // ── 彩蛋：不写进任何文档的小惊喜 ────────────────────────
  // Python 读不到全局按键（被沙箱拦），但 Electron 的系统级热键可以。
  // 触发后她做一个小动作 + 冒一句话，不出声、不打扰。
  let lastEggAt = 0;
  const EGGS = {
    'Control+Alt+D': { line: '诶…你按到这个了？', expr: '脸红', react: 'surprise', twist: true },
    'Control+Alt+M': { line: '嘿嘿…', expr: '爱心眼', react: 'nod', twist: false },
    'Control+Alt+9': { line: '被发现啦～', expr: '兔牙', react: 'happy', twist: true },
    'Control+Alt+F': { line: '🐟', expr: '爱心眼', react: 'shake', twist: true },
  };
  const playEgg = (kind) => {
    try {
      const now = Date.now();
      if (now - lastEggAt < 180000) return;   // 全局至少隔 3 分钟
      const e = EGGS[kind];
      if (!e) return;
      lastEggAt = now;
      const js = '(function(){try{' +
        'window.__react && window.__react(' + JSON.stringify(e.react) + ');' +
        (e.twist ? 'window.__twist && window.__twist();' : '') +
        'window.__bubble && window.__bubble(' + JSON.stringify(e.line) + ', 3.5);' +
        '}catch(err){}return 1;})()';
      runJs(js).catch(() => {});
      try { cmd('expression', { name: e.expr, ms: 2600 }); } catch (err) {}
      log('[egg] 触发', kind);
    } catch (err) {}
  };
  for (const accel of Object.keys(EGGS)) {
    try { globalShortcut.register(accel, () => playEgg(accel)); } catch (err) {}
  }
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
