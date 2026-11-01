/**
 * windowState.js — 窗口几何的唯一真相。
 *
 * 为什么需要它：以前尺寸有 4 份拷贝（curWidth/curHeight、drag.width/height、
 * OS getBounds、pet-window.json），resize 事件还会把 OS 的 ±1px 抖动写成新基准，
 * 造成「越拖越大」「缩放漂移」「复位不准」这几个反复出现的 bug。
 *
 * 这里的规则：
 *   · desiredW/H 只能由 setSize() 改（用户缩放 / API / 托盘）
 *   · 拖动中一律不采信 resize（reconcile 收到 dragging 直接忽略）
 *   · 与当前值差 ≤2px 的抖动忽略
 *   · 所有坐标写入前先对齐到设备像素，避免 125% 缩放下的取整漂移
 */

'use strict';

const MIN_W = 240;
const MIN_H = 320;
const MAX_W = 1200;
const MAX_H = 1400;
const EPS = 8; // px：小于等于这个值的差异视为抖动（拖边缩放会移动几十 px，仍能采纳）

function createWindowState({ screen, fs, posPath, defaults, log }) {
  const st = {
    w: Math.round(defaults.width),
    h: Math.round(defaults.height),
    x: Math.round(defaults.x || 0),
    y: Math.round(defaults.y || 0),
    bound: false,
    roam: false,
  };

  let roamSaved = null;


  let win = null;
  const logger = typeof log === 'function' ? log : () => {};

  function display() {
    const d = screen.getPrimaryDisplay();
    return { wa: d.workAreaSize, dpr: d.scaleFactor || 1 };
  }

  /** 对齐到设备像素：125% 缩放下 1 DIP = 1.25 物理像素，不取整就会漂 */
  function snap(v) {
    const { dpr } = display();
    return Math.round(Math.round(v * dpr) / dpr);
  }

  function clampSize(w, h) {
    const { wa } = display();
    const maxW = Math.min(MAX_W, wa.width - 20);
    const maxH = Math.min(MAX_H, wa.height - 20);
    // 宽高比一律沿用**当前**窗口形状：桌宠变形没有意义，
    // 而按请求的 w/h 取比例会让 /size {600,600} 这种请求把她拉成方块。
    const ar = st.w / st.h;
    // 以请求尺寸里较大的那个量纲为主，另一维按比例推出来（永远锁形状）
    const baseW = w > 0 ? w : (h > 0 ? h * ar : st.w);
    let nw = Math.round(baseW);
    let nh = Math.round(nw / ar);
    if (nw > maxW) { nw = maxW; nh = Math.round(nw / ar); }
    if (nh > maxH) { nh = maxH; nw = Math.round(nh * ar); }
    if (nw < MIN_W) { nw = MIN_W; nh = Math.round(nw / ar); }
    if (nh < MIN_H) { nh = MIN_H; nw = Math.round(nh * ar); }
    nw = Math.max(MIN_W, Math.min(maxW, nw));
    nh = Math.max(MIN_H, Math.min(maxH, nh));
    return { w: nw, h: nh };
  }

  function clampPosition(x, y, w, h) {
    // 允许她贴到（甚至探出）屏幕外沿：只要求至少 40% 留在屏幕内，方便抓回来。
    // 以前是"整窗必须完全在屏幕内"，结果她永远到不了最边上。
    const { wa } = display();
    const minX = -Math.round(w * 0.6);
    const maxX = Math.round(wa.width - w * 0.4);
    const minY = -Math.round(h * 0.6);
    const maxY = Math.round(wa.height - h * 0.4);
    return {
      x: snap(Math.max(minX, Math.min(Math.round(x), maxX))),
      y: snap(Math.max(minY, Math.min(Math.round(y), maxY))),
    };
  }

  // ── 磁盘 ────────────────────────────────────────────────
  function loadPos() {
    try {
      if (fs.existsSync(posPath)) return JSON.parse(fs.readFileSync(posPath, 'utf8'));
    } catch (e) {}
    return null;
  }

  function savePos() {
    try {
      fs.writeFileSync(posPath, JSON.stringify({ x: st.x, y: st.y, w: st.w, h: st.h }));
    } catch (e) {}
  }

  /** 给 createWindow 用：算好首帧的 bounds（含磁盘位置 + 工作区夹取） */
  function initialBounds() {
    const { wa } = display();
    const saved = loadPos();
    if (saved) {
      if (Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
        const s = clampSize(saved.w, saved.h);
        st.w = s.w;
        st.h = s.h;
      }
    }
    const px = Number.isFinite(saved && saved.x) ? saved.x : wa.width - st.w - 24;
    const py = Number.isFinite(saved && saved.y) ? saved.y : wa.height - st.h - 24;
    const p = clampPosition(px, py, st.w, st.h);
    st.x = p.x;
    st.y = p.y;
    return { x: st.x, y: st.y, width: st.w, height: st.h };
  }

  /**
   * 全屏漫游开关。
   * 开：窗口铺满整个工作区（她可以在屏幕任意位置活动），记住当前尺寸以便恢复。
   * 关：恢复进入漫游前的尺寸与位置。
   */
  function setRoam(on) {
    on = !!on;
    if (on === st.roam) return { w: st.w, h: st.h };
    if (on) {
      roamSaved = { w: st.w, h: st.h, x: st.x, y: st.y };
      const { wa } = display();
      st.roam = true;
      st.x = 0;
      st.y = 0;
      st.w = wa.width;
      st.h = wa.height;
      if (alive()) {
        try { win.setResizable(false); } catch (e) {}
        win.setBounds({ x: 0, y: 0, width: st.w, height: st.h });
      }
      logger('[geo] 进入全屏漫游', st.w + 'x' + st.h);
    } else {
      const s = roamSaved || { w: 520, h: 760, x: 0, y: 0 };
      roamSaved = null;
      st.roam = false;
      st.w = s.w;
      st.h = s.h;
      const p = clampPosition(s.x, s.y, st.w, st.h);
      st.x = p.x;
      st.y = p.y;
      if (alive()) {
        try { win.setResizable(true); } catch (e) {}
        win.setBounds({ x: st.x, y: st.y, width: st.w, height: st.h });
      }
      logger('[geo] 退出全屏漫游', st.w + 'x' + st.h);
    }
    return { w: st.w, h: st.h };
  }

  function isRoam() {
    return !!st.roam;
  }

  /** 漫游时把窗口钉回工作区（防止任何路径把它缩小后她半个身子在外） */
  function ensureRoamBounds() {
    if (!st.roam || !alive()) return false;
    const { wa } = display();
    const b = win.getBounds();
    if (b.width === wa.width && b.height === wa.height && b.x === 0 && b.y === 0) return false;
    st.w = wa.width;
    st.h = wa.height;
    st.x = 0;
    st.y = 0;
    try { win.setBounds({ x: 0, y: 0, width: st.w, height: st.h }); } catch (e) {}
    logger('[geo] 漫游窗口已钉回', st.w + 'x' + st.h);
    return true;
  }

  function bind(w) {
    win = w;
    st.bound = true;
  }

  function alive() {
    return !!win && !win.isDestroyed();
  }

  // ── 写 ──────────────────────────────────────────────────
  /** 设置目标尺寸；返回是否真的变了 */
  function setSize(w, h) {
    // 漫游模式下窗口必须铺满屏幕，任何缩小都会让她被裁掉（踩过：滚轮把窗口缩到 1200x644）
    if (st.roam) {
      logger('[geo] 漫游中忽略改尺寸请求', w + 'x' + h);
      return false;
    }
    const s = clampSize(w, h);
    if (s.w === st.w && s.h === st.h) return false;
    const before = st.w + 'x' + st.h;
    st.w = s.w;
    st.h = s.h;
    logger('[geo] size', before, '->', st.w + 'x' + st.h);

    if (alive()) {
      const b = win.getBounds();
      const p = clampPosition(b.x, b.y, st.w, st.h);
      st.x = p.x;
      st.y = p.y;
      win.setBounds({ x: st.x, y: st.y, width: st.w, height: st.h });
    }
    return true;
  }

  /** 移动（拖动用）：坐标对齐设备像素，不改尺寸 */
  function moveTo(x, y, { keepSize = true } = {}) {
    const p = clampPosition(x, y, st.w, st.h);
    st.x = p.x;
    st.y = p.y;
    if (!alive()) return { x: st.x, y: st.y };
    if (keepSize) {
      // 一次 setBounds 同时钉住尺寸：只调 setPosition 时 Windows 会为了保持
      // 客户区而反推窗口大小，拖几次就变大 1px。
      win.setBounds({ x: st.x, y: st.y, width: st.w, height: st.h });
    } else {
      win.setPosition(st.x, st.y);
    }
    return { x: st.x, y: st.y };
  }

  /**
   * 收到 resize 事件后调用。
   * @returns {{changed:boolean, reason:string}}
   */
  function reconcile(bounds, { dragging = false } = {}) {
    if (st.roam) return { changed: false, reason: 'roam' };
    if (dragging) return { changed: false, reason: 'dragging' };
    if (!bounds) return { changed: false, reason: 'no-bounds' };
    const dw = Math.abs(bounds.width - st.w);
    const dh = Math.abs(bounds.height - st.h);
    if (dw <= EPS && dh <= EPS) {
      // 位置也要跟上（用户可能只是移动窗口）
      st.x = bounds.x;
      st.y = bounds.y;
      return { changed: false, reason: 'jitter' };
    }
    logger('[geo] adopt', st.w + 'x' + st.h, '->', bounds.width + 'x' + bounds.height);
    st.w = bounds.width;
    st.h = bounds.height;
    st.x = bounds.x;
    st.y = bounds.y;
    return { changed: true, reason: 'user-resize' };
  }

  /**
   * 自愈对账：定期比对 OS 实际 bounds 与基准。
   *
   * 这个函数专门兜住「drag.active 卡死」这类意外：如果拖动状态因为丢了
   * mouseup 而永远为 true，正常的 reconcile 会一直忽略 resize，
   * 结果外壳以为窗口是 520x760，实际早被缩到 355x518。
   * 这里只要差值超过 4px 就把 OS 的尺寸采信回来，保证两边不会长期脱节。
   */
  function assertConsistent(bounds, { dragging = false } = {}) {
    if (st.roam) return { ok: true, reason: 'roam' };
    if (!bounds) return { ok: true, reason: 'no-bounds' };
    if (dragging) return { ok: true, reason: 'dragging' };
    const dw = Math.abs(bounds.width - st.w);
    const dh = Math.abs(bounds.height - st.h);
    if (dw <= 4 && dh <= 4) return { ok: true, reason: 'consistent' };
    logger('[geo] 自愈：OS=' + bounds.width + 'x' + bounds.height + ' 基准=' + st.w + 'x' + st.h);
    st.w = bounds.width;
    st.h = bounds.height;
    st.x = bounds.x;
    st.y = bounds.y;
    return { ok: false, reason: 'healed', w: st.w, h: st.h };
  }
  function get() {
    if (st.roam) {
      const { wa } = display();
      return { x: 0, y: 0, w: wa.width, h: wa.height };
    }
    return { x: st.x, y: st.y, w: st.w, h: st.h };
  }

  return {
    bind,
    initialBounds,
    clampSize,
    clampPosition,
    snap,
    setSize,
    setRoam,
    isRoam,
    ensureRoamBounds,
    moveTo,
    reconcile,
    get,
    assertConsistent,
    savePos,
    loadPos,
  };
}

module.exports = { createWindowState, MIN_W, MIN_H, MAX_W, MAX_H };
