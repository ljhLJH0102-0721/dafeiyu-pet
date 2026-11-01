/**
 * DSH 桌宠交互层
 * ─────────────────────────────────────────────────────────
 * 1) 逐像素命中：读光标下的 alpha，决定「点在角色身上」还是「点在透明区域」；
 *    透明区域让窗口忽略鼠标 → 桌面照常可点（不影响你操作别的软件）。
 * 2) 拖动：按住角色拖动窗口，带动摆动动画（被拎起来会晃）。
 * 3) 待机：呼吸 + 轻微身体摆动 + 视线跟着鼠标走。
 * 4) 反应：点击/被拎起时有一个小小的惊讶动作。
 */

import { canvas } from './lappglmanager';
import { computePose, stepSway, RELEASE_EYES_KEY, type SwayState } from './pet/pose';
import { createTimerBag } from './pet/timers';
import { createModelFit } from './pet/modelFit';
import { install, register } from './pet/commandBus';
import { createSfx } from './pet/sfx';

interface PetBridge {
  setIgnore?: (ignore: boolean) => void;
  dragStart?: (sx: number, sy: number) => void;
  dragMove?: (sx: number, sy: number) => void;
  dragEnd?: () => void;
  onDrag?: (cb: (info: { vx: number; vy: number }) => void) => void;
  /** 设置变化：触摸音效 / 音量 / 漫游 */
  onOptions?: (cb: (opt: any) => void) => void;
  /** 滚轮缩放：让外壳把窗口改大/改小（几何由 shell 的 windowState 统一处理） */
  scaleBy?: (factor: number) => void;
}

function bridge(): PetBridge {
  return ((window as any).pet || {}) as PetBridge;
}

/** 让窗口忽略/接收鼠标（透明区域 = 忽略） */
let ignoring = true;
function setIgnore(next: boolean): void {
  if (next === ignoring) return;
  ignoring = next;
  const b = bridge();
  if (b.setIgnore) b.setIgnore(next);
}

/**
 * 参数注入面板。
 *
 * 重要：**永远不要缓存 window.__paramHold 的引用**。
 * lappmodel 每帧读的是 window.__paramHold 当前指向的对象，
 * 一旦别处（/clear、旧代码、控制台）把它整体替换成新对象，
 * 缓存下来的旧引用就成了「没人读的孤儿」，她的动作会全部静默消失。
 * 所以这里每次按 window 现值取，缺了就补上。
 */
function paramHold(): Record<string, number> {
  const w = window as any;
  if (!w.__paramHold) w.__paramHold = {};
  return w.__paramHold;
}

// 诊断计数器（调试接口 /debug 会读）
const diag = { moves: 0, hits: 0, lastAlpha: -1, lastXY: [0, 0] as number[] };

function setParam(name: string, value: number): void {
  paramHold()[name] = value;
}

/**
 * 读光标位置的像素，判断是否落在角色身上。
 * WebGL 的 y 轴与 DOM 相反，需要翻转。
 */
function isOnCharacter(clientX: number, clientY: number): boolean {
  try {
    const gl = (canvas as any).getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext;
    if (!gl) { diag.lastAlpha = -2; return false; }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { diag.lastAlpha = -3; return false; }
    const x = Math.round(((clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.round((1 - (clientY - rect.top) / rect.height) * canvas.height);
    diag.lastXY = [x, y];
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) { diag.lastAlpha = -4; return false; }
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    diag.lastAlpha = px[3];
    return px[3] > 16; // alpha 阈值
  } catch (e) {
    diag.lastAlpha = -1;
    return false;
  }
}

/**
 * 自动适配：大肥鱼这个模型没有 Layout 段，画布比角色大很多，
 * 官方示例直接画会偏到右下角还被裁掉。这里用「像素扫描」实测角色
 * 在屏幕上的包围盒，再反推缩放和平移，把她居中并缩放到合适高度。
 * 任何窗口尺寸都适用，窗口变了重跑一次即可。
 */
// 模型适配（autoFit / resize 重算 / 矩阵唯一写者）都收在 pet/modelFit.ts
const fit = createModelFit({
  // 全屏漫游时窗口铺满屏幕，但她的体型按 760 逻辑像素封顶，不会变大成整屏
  maxLogicalHeight: 760,
  // getter：canvas 是 lappglmanager 的 live binding，模块初始化时还是 null
  getCanvas: () => canvas,
  isOnCharacter,
  getModel: () => (window as any).__model && (window as any).__model(),
  // 拟合结果按「页面参数 + 窗口尺寸」缓存：重启后同一尺寸不再重扫（扫描要卡几秒）
  getCacheKey: (w: number, h: number) => 'pet.fit|' + location.search + '|' + w + 'x' + h,
});

// 调试：查看当前适配基准和实际矩阵（矩阵读取统一走 fit，不直接摸 _modelMatrix）
(window as any).__fitInfo = () => {
  const cur = fit.getScale();
  const r = fit.getRef();
  return {
    fitRef: r ? { W: r.W, H: r.H, scale: Math.round(r.scale * 1e4) / 1e4 } : null,
    curScale: cur != null ? Math.round(cur * 1e4) / 1e4 : null,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  };
};

export function setupInteraction(): void {
  // ── 触摸音效（WebAudio 合成，无外部素材） ─────────────
  const sfx = createSfx({ enabled: true, volume: 0.5 });

  // ── 全屏漫游：窗口铺满屏幕，拖动移动的是角色（画布位移），不是窗口 ──
  let roamMode = false;
  let roamOffset = { x: 0, y: 0 };
  let roamDrag: { sx: number; sy: number; ox: number; oy: number } | null = null;
  const ROAM_KEY = 'pet.roam.offset';

  function applyRoamOffset(): void {
    try {
      if (roamOffset.x || roamOffset.y) {
        canvas.style.transform = 'translate(' + roamOffset.x + 'px, ' + roamOffset.y + 'px)';
      } else {
        canvas.style.transform = '';
      }
    } catch (e) {}
  }

  try {
    const s = window.localStorage.getItem(ROAM_KEY);
    if (s) {
      const o = JSON.parse(s);
      if (o && isFinite(o.x) && isFinite(o.y)) {
        roamOffset = { x: Number(o.x), y: Number(o.y) };
      }
    }
  } catch (e) {}

  function saveRoamOffset(): void {
    try { window.localStorage.setItem(ROAM_KEY, JSON.stringify(roamOffset)); } catch (e) {}
  }

  try {
    const b0 = bridge();
    if (b0.onOptions) {
      b0.onOptions((opt: any) => {
        roamMode = !!opt.roamMode;
        if (roamMode) {
          try {
            const z = window.localStorage.getItem('pet.roam.zoom');
            if (z) fit.setZoom(Number(z));
          } catch (e) {}
        } else {
          // 回普通模式：窗口自己缩放，角色倍率复位
          try { fit.setZoom(1); window.localStorage.setItem('pet.roam.zoom', '1'); } catch (e) {}
        }
        if (!roamMode) {
          // 非漫游：位移一律清零（否则她会跑到小窗口外面去）
          roamOffset = { x: 0, y: 0 };
          roamDrag = null;
        } else {
          // 进入漫游：恢复上次在屏幕上的位置
          try {
            const s2 = window.localStorage.getItem(ROAM_KEY);
            if (s2) {
              const o2 = JSON.parse(s2);
              if (o2 && isFinite(o2.x) && isFinite(o2.y)) roamOffset = { x: Number(o2.x), y: Number(o2.y) };
            }
          } catch (e) {}
        }
        applyRoamOffset();
        sfx.setOptions({
          enabled: opt.touchSound != null ? !!opt.touchSound : true,
          volume: opt.soundVolume != null ? Number(opt.soundVolume) : 0.5,
        });
      });
    }
  } catch (e) {}

  const b = bridge();
  const state = {
    onChar: false,
    dragging: false,
    downX: 0,
    downY: 0,
    moved: false,
    vx: 0,
    vy: 0,       // 拖动速度（外壳回传）
    swayX: 0,    // 被拎起来的摆动角
    swayV: 0,
    surprise: 0, // 惊讶程度 0~1，随时间衰减
    sleepy: 0,   // 犯困程度 0~1（长时间没操作由外壳/感知脚本设置）
    gazeX: 0,
    gazeY: 0,
    targetGazeX: 0,
    targetGazeY: 0,
    lastMoveAt: performance.now(),
  };

  // 外壳回传拖动速度，用来算摆动
  if (b.onDrag) {
    b.onDrag((info) => {
      state.vx = info.vx || 0;
      state.vy = info.vy || 0;
    });
  }

  // 拖动节流：每帧最多发一次 IPC
  let pendingDrag: { x: number; y: number } | null = null;
  let dragRaf = 0;
  const flushDrag = () => {
    dragRaf = 0;
    if (!pendingDrag) return;
    const p = pendingDrag;
    pendingDrag = null;
    try {
      if (b.dragMove) b.dragMove(p.x, p.y);
    } catch (e) {}
  };

  let lastTouchAt = 0;
  let touchTimer = 0;

  // ── 鼠标位置：决定是否接管 + 影响视线 ──────────────────
  window.addEventListener(
    'mousemove',
    (ev: MouseEvent) => {
      state.lastMoveAt = performance.now();
      diag.moves++;
      const rect = canvas.getBoundingClientRect();
      // 视线目标（相对画布中心，-1~1）
      const nx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1;
      state.targetGazeX = Math.max(-1, Math.min(1, nx));
      state.targetGazeY = Math.max(-1, Math.min(1, ny));

      if (state.dragging) {
        state.moved = true;
        if (roamMode && roamDrag) {
          // 漫游模式：移动角色本身（画布位移），窗口不动
          roamOffset = {
            x: roamDrag.ox + (ev.screenX - roamDrag.sx),
            y: roamDrag.oy + (ev.screenY - roamDrag.sy),
          };
          state.vx = 0;
          state.vy = 0;
          // 位移上限要按「她自己的大小」算，而不是按画布百分比：
          // 按画布 55% 算，862 高的屏幕能把她推下去 474px，半个身子就切没了。
          const ref2 = fit.getRef();
          const herH = Math.min(760, ref2 ? ref2.H : window.innerHeight) * 0.85;
          const herW = herH * 0.55;
          const maxX = Math.max(0, window.innerWidth / 2 + herW * 0.35);
          const maxY = Math.max(0, window.innerHeight / 2 + herH * 0.15);
          roamOffset.x = Math.max(-maxX, Math.min(maxX, roamOffset.x));
          roamOffset.y = Math.max(-maxY, Math.min(maxY, roamOffset.y));
          applyRoamOffset();
          return;
        }
        // 每个 mousemove 都发 IPC 会淹掉主进程（一秒几十次窗口移动 → 掉帧）。
        // 这里只记最新位置，每帧最多发一次。
        pendingDrag = { x: ev.screenX, y: ev.screenY };
        if (!dragRaf) dragRaf = requestAnimationFrame(flushDrag);
        return;
      }

      const on = isOnCharacter(ev.clientX, ev.clientY);
      if (on) diag.hits++;
      // 鼠标「刚碰到她」→ 抖一下 / 歪个头，表示被摸到了
      // 鼠标「停在」她身上 250ms 才算摸到（只是路过不算），冷却 6 秒
      if (on && !state.onChar && !state.dragging) {
        const now = performance.now();
        if (now - lastTouchAt > 6000 && !touchTimer) {
          touchTimer = window.setTimeout(() => {
            touchTimer = 0;
            if (!state.onChar || state.dragging) return;
            if (performance.now() - lastTouchAt < 6000) return;
            lastTouchAt = performance.now();
            sfx.hover();
            const gs = ['wobble', 'tilt', 'nod'];   // 不再默认摇头（太频繁显眼）
            startGesture(gs[Math.floor(Math.random() * gs.length)]);
            if (Math.random() < 0.4) {
              flashExpression(CUTE[Math.floor(Math.random() * CUTE.length)], 1600);
            }
            state.surprise = Math.max(state.surprise, 0.4);
          }, 250);
        }
      }
      if (!on && touchTimer) {
        window.clearTimeout(touchTimer);
        touchTimer = 0;
      }
      state.onChar = on;
      // 注：click 穿透由主进程用「全局光标位置 + __hitTest」轮询驱动，
      // 页面这里不再切换，否则两边会打架。
    },
    { passive: true }
  );

  window.addEventListener(
    'mousedown',
    (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (!isOnCharacter(ev.clientX, ev.clientY)) return;
      state.dragging = true;
      state.moved = false;
      state.downX = ev.screenX;
      state.downY = ev.screenY;
      state.surprise = 1;
      state.swayV = 0;
      sfx.pick();
      if (roamMode) {
        roamDrag = { sx: ev.screenX, sy: ev.screenY, ox: roamOffset.x, oy: roamOffset.y };
      } else if (b.dragStart) {
        b.dragStart(ev.screenX, ev.screenY);
      }
    },
    { passive: true }
  );

  window.addEventListener(
    'mouseup',
    () => {
      if (!state.dragging) return;
      const clicked = !state.moved;   // 没怎么动 = 点了一下
      state.dragging = false;
      state.vx = 0;
      state.vy = 0;
      if (roamMode) {
        roamDrag = null;
        saveRoamOffset();
      } else if (b.dragEnd) {
        b.dragEnd();
      }
      sfx.drop();
      if (clicked) {
        // 点她一下 → 随机卖个萌
        try {
          sfx.click();
          const pool = ['脸红', '＞＜', '爱心眼', '兔牙', '屑屑眼'];
          flashExpression(pool[Math.floor(Math.random() * pool.length)], 2200);
          state.surprise = 0.7;
          state.swayV += 1.4;
          const gs = ['wobble', 'nod', 'tilt', 'shake'];
          startGesture(gs[Math.floor(Math.random() * gs.length)]);
        } catch (e) {}
      }
    },
    { passive: true }
  );

  window.addEventListener('mouseleave', () => {
    state.targetGazeX = 0;
    state.targetGazeY = 0;
  });

  // ── 小动作（摇头 / 点头 / 歪头 / 晃身子 / 晃脑袋） ──────
  // 做成"一次性手势"：开始后按时间算偏移量，叠加到头部/身体角度上。
  type Gesture = { kind: string; t0: number; dur: number };
  let gesture: Gesture | null = null;

  const GESTURE_DUR: Record<string, number> = {
    shake: 1.15,   // 摇头
    nod: 0.95,     // 点头
    tilt: 1.5,     // 歪头
    sway: 2.2,     // 晃身子
    wobble: 2.6,   // 晃脑袋
  };

  function startGesture(kind: string): boolean {
    if (!GESTURE_DUR[kind]) return false;
    // 时间基准要和 tick 里的 t 一致（t = (performance.now() - t0) / 1000）
    gesture = { kind, t0: (performance.now() - t0) / 1000, dur: GESTURE_DUR[kind] };
    return true;
  }

  // 返回当前手势对角度/身体的偏移（没有手势返回 null）
  function gestureOffset(t: number): { dx: number; dy: number; dz: number; body: number } | null {
    if (!gesture) return null;
    const el = t - gesture.t0;
    const p = el / gesture.dur;
    if (p >= 1 || p < 0) {
      gesture = null;
      return null;
    }
    const env = Math.sin(Math.PI * p);   // 0 → 1 → 0 的包络，起落自然
    switch (gesture.kind) {
      case 'shake': {
        const a = Math.sin(el * 15) * 30 * env;
        return { dx: a, dy: 0, dz: a * 0.22, body: a * 0.45 };
      }
      case 'nod': {
        const a = -Math.sin(el * 9.5) * 24 * env;
        return { dx: 0, dy: a, dz: 0, body: 0 };
      }
      case 'tilt': {
        const a = 30 * env;
        return { dx: 0, dy: -3 * env, dz: a, body: a * 0.35 };
      }
      case 'sway': {
        const a = Math.sin(el * 3.4) * 18 * env;
        return { dx: a * 0.35, dy: 0, dz: a * 0.5, body: a };
      }
      case 'wobble': {
        const a = Math.sin(el * 6.2) * 15 * env;
        return { dx: a * 0.7, dy: a * 0.55, dz: a * 1.0, body: a * 0.7 };
      }
    }
    return null;
  }

  (window as any).__gesture = (kind: string) => startGesture(String(kind));
  (window as any).__gestureList = () => Object.keys(GESTURE_DUR);

  // 摆动弹簧状态（pose 是纯函数，状态留在这里）
  let swayState: SwayState = { x: 0, v: 0 };

  // 本模块的定时器/帧注册表，热重载或卸载时统一清理
  const timers = createTimerBag();

  // ── 每帧：待机动作 + 摆动 + 惊讶衰减 ──────────────────
  const t0 = performance.now();
  function tick(): void {
    const now = performance.now();
    const t = (now - t0) / 1000;
    const dt = 1 / 60;

    // 视线平滑跟随
    state.gazeX += (state.targetGazeX - state.gazeX) * 0.18;
    state.gazeY += (state.targetGazeY - state.gazeY) * 0.18;

    // 摆动弹簧（纯函数，状态留在外面）
    swayState = stepSway(swayState, { dragging: state.dragging, vx: state.vx }, dt);
    state.swayX = swayState.x;
    state.swayV = swayState.v;

    // 惊讶衰减
    state.surprise = Math.max(0, state.surprise - dt * 1.4);

    // ★ 唯一写模型参数的地方：pose 算好一整帧，这里一次性提交
    const pose = computePose({
      t,
      gazeX: state.gazeX,
      gazeY: state.gazeY,
      onChar: state.onChar,
      surprise: state.surprise,
      sleepy: state.sleepy,
      swayX: swayState.x,
      gesture: gestureOffset(t),
    });
    let releaseEyes = false;
    for (const name in pose) {
      if (name === RELEASE_EYES_KEY) {
        releaseEyes = true;
        continue;
      }
      setParam(name, pose[name]);
    }
    if (releaseEyes) {
      // 交还给模型自己的眨眼（删掉我们按住的值）
      delete paramHold()['ParamEyeLOpen'];
      delete paramHold()['ParamEyeROpen'];
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // 播放语音（edge-tts 生成的 mp3），播放期间嘴巴跟着动
  (window as any).__playAudio = (src: string, duration: number): boolean => {
    try {
      const audio = new Audio(src);
      audio.volume = 1.0;
      (window as any).__petAudio = audio;
      const started = Date.now();
      const est = duration > 0 ? duration * 1000 : 4000;

      const tick = () => {
        const a = (window as any).__petAudio;
        if (!a) return;
        const playing = !a.paused && !a.ended && (Date.now() - started) < est + 800;
        if (playing) {
          // 用随机开合近似口型（以后可以换成真实音量包络）
          const lvl = Math.random() > 0.18 ? 0.2 + Math.random() * 0.6 : 0.02;
          setParam('ParamMouthOpenY', lvl);
          setTimeout(tick, 60 + Math.random() * 70);
        } else {
          setParam('ParamMouthOpenY', 0);
        }
      };

      audio.addEventListener('ended', () => {
        setParam('ParamMouthOpenY', 0);
      });
      audio.play().then(tick).catch(() => {
        // 播放失败（没声卡等）也让嘴动起来，至少看起来在说话
        const end = Date.now() + est;
        const fake = () => {
          if (Date.now() > end) { setParam('ParamMouthOpenY', 0); return; }
          setParam('ParamMouthOpenY', Math.random() > 0.18 ? 0.2 + Math.random() * 0.6 : 0.02);
          setTimeout(fake, 60 + Math.random() * 70);
        };
        fake();
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  // 给外壳/语音桥用：让桌宠做个小反应
  //   kind: 'surprise' | 'happy' | 'nod' | 'shake' | 'sleep' | 'wake'
  (window as any).__autoFit = () => fit.autoFit();

  // 启动时先藏住画布：自动适配过程中会先把角色缩到 20% 去量尺寸，
  // 不藏的话会看到"一闪"。适配完再淡入。
  let revealed = false;
  const revealCanvas = () => {
    if (revealed) return;
    revealed = true;
    try {
      canvas.style.transition = 'opacity .25s ease';
      canvas.style.opacity = '1';
    } catch (e) {}
  };
  try {
    canvas.style.opacity = '0';
  } catch (e) {}
  window.setTimeout(revealCanvas, 10000);   // 兜底：10 秒还没适配好也要显示

  // 等模型加载完成后自动适配一次（每 800ms 试一次，最多 20 秒）
  (function waitAndFit(tries: number) {
    if (tries <= 0) {
      revealCanvas();
      return;
    }
    if (fit.isReady()) {
      fit.autoFit().then((ok) => {
        if (ok) revealCanvas();
        else setTimeout(() => waitAndFit(tries - 1), 800);
      });
    } else {
      setTimeout(() => waitAndFit(tries - 1), 800);
    }
  })(25);

  // ── 气泡文字 ────────────────────────────────────────────
  let bubbleEl: HTMLDivElement | null = null;
  let bubbleTimer: number = 0;

  function ensureBubble(): HTMLDivElement {
    if (bubbleEl && bubbleEl.isConnected) return bubbleEl;
    if (!document.getElementById('pet-bubble-style')) {
      const st = document.createElement('style');
      st.id = 'pet-bubble-style';
      st.textContent = `
        #pet-bubble {
          position: fixed; left: 50%; top: 8px; transform: translateX(-50%) translateY(-6px);
          max-width: 94%; padding: 10px 14px; border-radius: 14px;
          background: rgba(255,255,255,0.96); color: #17212e;
          font: 15px/1.5 "Microsoft YaHei", "PingFang SC", sans-serif;
          box-shadow: 0 6px 22px rgba(0,0,0,0.22);
          border: 1.5px solid rgba(86,140,205,0.55);
          opacity: 0; transition: opacity .16s ease, transform .16s ease;
          pointer-events: none; z-index: 99999;
          max-height: 46vh; overflow: hidden; word-break: break-word;
          white-space: pre-wrap;
        }
        #pet-bubble.show { opacity: 1; transform: translateX(-50%) translateY(0); }
        #pet-bubble:after {
          content: ''; position: absolute; left: 50%; bottom: -8px; margin-left: -8px;
          width: 0; height: 0;
          border-left: 8px solid transparent; border-right: 8px solid transparent;
          border-top: 9px solid rgba(255,255,255,0.96);
        }
      `;
      document.head.appendChild(st);
    }
    bubbleEl = document.createElement('div');
    bubbleEl.id = 'pet-bubble';
    document.body.appendChild(bubbleEl);
    return bubbleEl;
  }

  // 显示一段气泡文字；seconds <= 0 时按文字长度估算
  (window as any).__bubble = (text: string, seconds: number): boolean => {
    try {
      const el = ensureBubble();
      const msg = String(text || '').trim();
      if (!msg) {
        el.classList.remove('show');
        return true;
      }
      const shown = msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
      el.textContent = shown;
      el.classList.add('show');
      const dur = seconds > 0 ? seconds : Math.min(20, Math.max(2.5, shown.length / 7));
      if (bubbleTimer) window.clearTimeout(bubbleTimer);
      bubbleTimer = window.setTimeout(() => el.classList.remove('show'), dur * 1000);
      return true;
    } catch (e) {
      return false;
    }
  };

  // ── 表情 / 动作 ─────────────────────────────────────────
  // 模型自带 23 个表情（脸红/＞＜/爱心眼/兔牙…）和 6 个手部动作
  // （举手、放手、竖手指、狗尾草）。这里包一层，供外部调用和自动互动。
  const CUTE = ['脸红', '＞＜', '爱心眼', '兔牙', '屑屑眼', '圈圈眼'];
  const HANDS = ['举手', '放手', '竖手指开', '竖手指关', '狗尾草开', '狗尾草关'];
  let expressionTimer = 0;

  const petModel = () => (window as any).__model && (window as any).__model();

  (window as any).__expression = (name: string): boolean => {
    const m = petModel();
    if (!m || !m.setExpression) return false;
    try { m.setExpression(String(name)); return true; } catch (e) { return false; }
  };

  (window as any).__clearExpression = (): boolean => {
    const m = petModel();
    try {
      const em = m && m._expressionManager;
      if (em && typeof em.stopAllMotions === 'function') { em.stopAllMotions(); return true; }
    } catch (e) {}
    return false;
  };

  (window as any).__motion = (group: string, no: number): boolean => {
    const m = petModel();
    if (!m || !m.startMotion) return false;
    try { m.startMotion(String(group), Number(no || 0), 3); return true; } catch (e) { return false; }
  };

  (window as any).__lists = () => ({ expressions: CUTE, motions: HANDS });

  // 做一个短表情，几秒后收回去
  function flashExpression(name: string, ms = 2600): boolean {
    if (!(window as any).__expression(name)) return false;
    if (expressionTimer) window.clearTimeout(expressionTimer);
    expressionTimer = window.setTimeout(() => {
      idleFires++;
      (window as any).__clearExpression();
    }, ms);
    return true;
  }
  (window as any).__flashExpression = flashExpression;

  // 待机小动作：隔一阵自己做个表情/手部动作，别像块木头
  // 下次待机动作的时间戳（毫秒），给调试/测试用，避免盲等
  let nextIdleAt = 0;
  let idleFires = 0;   // 待机动作实际触发次数（测试用）

  function scheduleIdlePlay(): void {
    const delay = 20000 + Math.random() * 25000;   // 20~45 秒（原来 9~27 秒太频繁）
    nextIdleAt = Date.now() + delay;
    window.setTimeout(() => {
      try {
        if (!state.dragging && !state.sleepy) {
          const r = Math.random();
          // 待机只做温和的（点头/歪头/晃身子），摇头留给"被摸到"和点击
          const GESTURES = ['nod', 'tilt', 'sway'];
          if (r < 0.22) {
            startGesture(GESTURES[Math.floor(Math.random() * GESTURES.length)]);
            if (Math.random() < 0.35) {
              flashExpression(CUTE[Math.floor(Math.random() * CUTE.length)], 1800);
            }
          } else if (r < 0.62) {
            flashExpression(CUTE[Math.floor(Math.random() * CUTE.length)], 2400);
          } else if (r < 0.82) {
            const g = HANDS[Math.floor(Math.random() * 4)];
            (window as any).__motion(g, 0);
            flashExpression('＞＜', 1500);
          } else {
            // 连着晃两下脑袋，看起来像在发呆
            startGesture('wobble');
            window.setTimeout(() => startGesture('tilt'), 900);
          }
        }
      } catch (e) {}
      scheduleIdlePlay();
    }, delay);
  }
  scheduleIdlePlay();

  // ── 滚轮 = 缩放 ────────────────────────────────────────
  // 之前的做法是"滚动时只在页面里放大，松手后再改窗口"，
  // 结果滚动过程中她会被窗口裁掉（头/脚被切），看起来像闪现。
  // 现在改成：**每 70ms 真改一次窗口**，全程不被裁，看起来是连续放大。
  // 窗口变化后的重适配是"按比例重算"，不是重新扫描，所以够快。
  let wheelAcc = 1;
  let lastCommit = 0;
  let trailTimer = 0;
  const COMMIT_MS = 70;

  const flushZoom = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastCommit < COMMIT_MS) return;
    if (Math.abs(wheelAcc - 1) < 0.002) {
      wheelAcc = 1;
      return;
    }
    const f = wheelAcc;
    wheelAcc = 1;
    lastCommit = now;
    try {
      if (roamMode) {
        // 漫游模式：窗口铺满屏幕不能改大小，滚轮缩放的是**角色本身**
        const z = fit.zoomBy(f);
        try { window.localStorage.setItem('pet.roam.zoom', String(z)); } catch (e) {}
      } else if (b.scaleBy) {
        b.scaleBy(f);
      }
    } catch (err) {}
  };

  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const k = Math.pow(1.08, -e.deltaY / 100);   // 一格约 ±8%
      wheelAcc *= k;
      flushZoom(false);
      // 保证最后一次滚动也生效
      if (trailTimer) window.clearTimeout(trailTimer);
      trailTimer = window.setTimeout(() => flushZoom(true), COMMIT_MS + 30);
    },
    { passive: false }
  );
  // 右键 = 打开设置/互动菜单（交给外壳弹原生菜单）
  window.addEventListener(
    'contextmenu',
    (e: MouseEvent) => {
      e.preventDefault();
      try {
        if ((b as any).showMenu) (b as any).showMenu();
      } catch (err) {}
    },
    { passive: false }
  );

  // 窗口尺寸变了 → 按比例缩放上一次的适配结果（瞬间完成，不重新扫描、不闪）
  window.addEventListener('resize', () => {
    // 只做等比换算，绝不重扫：autoFit 的测量过程会先把模型缩到 20% 扫 3136 个像素，
    // 肉眼就是「她突然变小又弹回来」。等比换算在数学上是精确的（投影随画布高度等比缩放）。
    // 只有还没有任何适配基准（首次启动）时才真的测一次。
    if (!fit.rescaleForWindow()) {
      fit.autoFit();
    }
  });

  // 给外壳/语音桥用：让桌宠做个小反应
  (window as any).__react = (kind: string): boolean => {
    switch (kind) {
      case 'surprise':
        state.surprise = 1;
        state.swayV += 2.2;
        startGesture('wobble');
        break;
      case 'happy':
        state.surprise = 0.55;
        state.swayV += 1.1;
        startGesture('wobble');
        break;
      case 'nod':
        startGesture('nod');
        break;
      case 'shake':
        startGesture('shake');
        break;
      case 'tilt':
        startGesture('tilt');
        break;
      case 'sway':
        startGesture('sway');
        break;
      case 'sleep':
        state.sleepy = 1;
        startGesture('tilt');
        break;
      case 'wake':
        state.sleepy = 0;
        state.surprise = 0.8;
        startGesture('nod');
        break;
      default:
        state.surprise = 0.4;
    }
    return true;
  };

  // 调试用：外部可以读当前状态（是否在接管鼠标 / 是否在拖 / 是否犯困）
  (window as any).__petState = () => ({
    ignoring,
    onChar: state.onChar,
    dragging: state.dragging,
    roam: roamMode,
    zoom: fit.getZoom(),
    sleepy: state.sleepy,
    moves: diag.moves,
    hits: diag.hits,
    lastAlpha: diag.lastAlpha,
    lastXY: diag.lastXY,
    canvasSize: [canvas.width, canvas.height],
    rect: (() => {
      const r = canvas.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    })(),
  });

  // 给主进程用：给定窗口内坐标，判断是否点在角色身上（逐像素 alpha）
  (window as any).__hitTest = (clientX: number, clientY: number): boolean => {
    const on = isOnCharacter(clientX, clientY);
    state.onChar = on;
    if (on) diag.hits++;
    return on;
  };
  // ── 统一命令通道 ────────────────────────────────────────
  // 外壳只调 window.__pet.command(name, args)；参数走 JSON，不再手拼字符串。
  const w = window as any;
  install();
  register('hitTest', (a) => w.__hitTest(a.x, a.y));
  register('state', () => w.__petState());
  register('bubble', (a) => w.__bubble(String(a.text || ''), Number(a.seconds || 3)));
  register('expression', (a) => {
    const ms = Number(a.ms || 0);
    return ms > 0 ? w.__flashExpression(String(a.name || ''), ms) : w.__expression(String(a.name || ''));
  });
  register('motion', (a) => w.__motion(String(a.group || ''), Number(a.no || 0)));
  register('gesture', (a) => w.__gesture(String(a.kind || '')));
  register('react', (a) => w.__react(String(a.kind || '')));
  register('lists', () => w.__lists());
  register('clear', () => {
    const h0 = w.__paramHold;
    if (h0) for (const k in h0) delete h0[k];
    // 只删键、不换对象：tick 每帧写入的目标必须始终是同一个
    return true;
  });
  register('setParams', (a) => {
    const p = a.params || a || {};
    const h = paramHold();
    for (const k in p) h[k] = p[k];
    return Object.keys(h).length;
  });
  register('mouth', (a) => {
    setParam('ParamMouthOpenY', Number(a.v || 0));
    return true;
  });
  register('play', (a) => {
    if (a.text) w.__bubble(String(a.text), Number(a.dur || 3));
    return w.__playAudio ? w.__playAudio(String(a.src || ''), Number(a.duration || 0)) : false;
  });
  register('camera', (a) => {
    if (!w.__face) return null;
    return a.on ? w.__face.start() : w.__face.stop();
  });
  register('faceStatus', () => (w.__face ? w.__face.status() : null));
  // 待机调度器的下次触发时间（测试用，避免盲等）
  register('idleInfo', () => ({ nextIdleAt, now: Date.now(), waiting: Math.max(0, nextIdleAt - Date.now()), fires: idleFires }));
  register('fit', () => fit.autoFit());
  register('fitInfo', () => w.__fitInfo());
}

