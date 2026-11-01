/**
 * modelFit.ts — 模型矩阵的唯一写者。
 *
 * 历史问题：
 *   · autoFit 会被并发调用（窗口 resize + 启动 + 手动），互相打断 → 越缩越小
 *   · 滚轮缩放直接改矩阵，留下的缩放不会被清掉 → 窗口尺寸回来她还是小的
 *   · 适配结果没有单一口径，各处各算一遍
 *
 * 这里的原则：
 *   · 只有本模块能改 modelMatrix
 *   · autoFit 单飞（同一时刻只跑一个）
 *   · 同一个窗口尺寸只扫描一次，结果缓存（幂等：连调 5 次结果相同）
 *   · 尺寸变化走 rescaleForWindow，按比例换算，不再重扫（重扫会先缩到 20% 测尺寸，看起来是闪）
 */

export interface FitRef {
  W: number;
  H: number;
  scale: number;
  tx: number;
  ty: number;
}

export interface ModelFitDeps {
  /** 注意必须用 getter：canvas 是 lappglmanager 的 live binding，
   *  模块初始化时还是 null，直接传值会拿到 null 快照 */
  getCanvas: () => HTMLCanvasElement;
  isOnCharacter: (x: number, y: number) => boolean;
  getModel: () => any;
  /** 目标高度占比（默认 0.82） */
  targetHeightRatio?: number;
  /** 拟合结果的持久化 key（同 key 直接复用缓存，避免每次启动都重扫） */
  getCacheKey?: (w: number, h: number) => string;
  /**
   * 逻辑高度上限（px）。
   * 全屏漫游时窗口铺满屏幕，但她的"体型"不该跟着变成整个屏幕那么大，
   * 所以拟合按 min(窗口高, 这个值) 来算。
   */
  maxLogicalHeight?: number;
}

export interface ModelFit {
  /** 重新测量并适配；并发调用只有第一个真正执行 */
  autoFit(waitFrames?: number): Promise<boolean>;
  /** 窗口尺寸变了：按比例重算（瞬时、不闪） */
  rescaleForWindow(): boolean;
  /** 直接应用一份适配结果 */
  applyFit(ref: FitRef): void;
  /** 最近一次成功的适配基准 */
  getRef(): FitRef | null;
  /** 当前矩阵的缩放值（没有模型时 null） */
  getScale(): number | null;
  /** 角色缩放（漫游模式滚轮用），返回新倍率 */
  zoomBy(factor: number): number;
  getZoom(): number;
  setZoom(value: number): number;
  /** 模型矩阵是否已就绪 */
  isReady(): boolean;
  /** 清掉缓存（换模型时用） */
  invalidate(): void;
}

const S0 = 0.2;          // 测量用的基准比例
const SCAN_N = 56;       // 扫描网格（40 太粗会漏掉脚底几像素）
const MAX_ATTEMPTS = 5;

export function createModelFit(deps: ModelFitDeps): ModelFit {
  let fitting = false;
  let zoom = 1;          // 角色缩放倍数（漫游模式里滚轮改的是这个，不是窗口）
  let fitRef: FitRef | null = null;
  const targetRatio = deps.targetHeightRatio ?? 0.82;

  function matrix(): any {
    const m = deps.getModel && deps.getModel();
    return m && m._modelMatrix ? m._modelMatrix : null;
  }

  function canvasSize(): { W: number; H: number } {
    const c = deps.getCanvas();
    const rect = c.getBoundingClientRect();
    return {
      W: Math.max(50, Math.round(rect.width)),
      H: Math.max(50, Math.round(rect.height)),
    };
  }

  /** 拟合用的"逻辑高度"：全屏漫游时封顶，避免她变成整屏那么大 */
  function logicalHeight(realH: number): number {
    const cap = deps.maxLogicalHeight || 0;
    return cap > 0 ? Math.min(realH, cap) : realH;
  }

  function raf(): Promise<void> {
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  }

  /** 网格扫描：返回角色在画布上的包围盒 */
  function scan(W: number, H: number): { minx: number; miny: number; maxx: number; maxy: number } | null {
    let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, n = 0;
    for (let gy = 0; gy < SCAN_N; gy++) {
      for (let gx = 0; gx < SCAN_N; gx++) {
        const x = (W * (gx + 0.5)) / SCAN_N;
        const y = (H * (gy + 0.5)) / SCAN_N;
        if (deps.isOnCharacter(x, y)) {
          n++;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    return n > 0 ? { minx, miny, maxx, maxy } : null;
  }

  async function autoFit(): Promise<boolean> {
    if (fitting) return false;        // 单飞：并发调用会互相打断，越缩越小
    fitting = true;
    try {
      return await autoFitInner();
    } finally {
      fitting = false;
    }
  }

  async function autoFitInner(): Promise<boolean> {
    const arr = matrix();
    if (!arr) return false;
    const { W, H } = canvasSize();

    // 幂等：同一个窗口尺寸下已经有结果，直接复用（连调 5 次不会越缩越小）
    if (fitRef && fitRef.W === W && fitRef.H === logicalHeight(H)) {
      applyFitInner(fitRef);
      return true;
    }

    // 持久化缓存：重启后同一窗口尺寸不再重扫
    // （扫描要 56x56=3136 次逐像素回读，会把渲染线程堵好几秒）
    const cacheKey = deps.getCacheKey ? deps.getCacheKey(W, H) : null;
    if (cacheKey) {
      try {
        const raw = window.localStorage.getItem(cacheKey);
        if (raw) {
          const cached = JSON.parse(raw) as FitRef;
          if (cached && cached.W === W && cached.H === logicalHeight(H) && cached.scale > 0) {
            fitRef = cached;
            applyFitInner(fitRef);
            return true;
          }
        }
      } catch (e) {
        /* 缓存坏了就照常扫 */
      }
    }

    const a = arr.getArray();

    // 1) 用一个小比例测出基准位置
    a[0] = S0; a[5] = S0; a[12] = 0; a[13] = 0;
    await raf();
    const b0 = scan(W, H);
    if (!b0) return false;

    // 2) 测「每 1 个模型单位 = 多少像素」，用来换算平移量
    a[12] = 0.2;
    await raf();
    const bx = scan(W, H);
    a[12] = 0; a[13] = 0.2;
    await raf();
    const by = scan(W, H);
    a[13] = 0;
    if (!bx || !by) return false;
    const pxPerX0 = (bx.minx - b0.minx) / 0.2;
    const pxPerY0 = (by.miny - b0.miny) / 0.2;
    if (!isFinite(pxPerX0) || !isFinite(pxPerY0) || Math.abs(pxPerX0) < 1) return false;

    // 3) 按目标高度定缩放，平移居中；再检查有没有贴边（被裁），被裁就缩一圈重来
    const artH = Math.max(1, b0.maxy - b0.miny);
    let scale = S0 * ((targetRatio * logicalHeight(H)) / artH);
    const margin = Math.max(16, Math.round(H * 0.03));

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      a[0] = scale; a[5] = scale; a[12] = 0; a[13] = 0;
      await raf();
      const b1 = scan(W, H);
      if (!b1) return false;

      const k = scale / S0;
      const pxPerX1 = pxPerX0 * k;
      const pxPerY1 = pxPerY0 * k;
      const c1x = (b1.minx + b1.maxx) / 2;
      const c1y = (b1.miny + b1.maxy) / 2;
      a[12] = (W / 2 - c1x) / pxPerX1;
      a[13] = (H / 2 - c1y) / pxPerY1;
      await raf();

      const b2 = scan(W, H);
      if (!b2) return false;
      const clipped =
        b2.miny <= margin ||
        b2.maxy >= H - margin ||
        b2.minx <= margin ||
        b2.maxx >= W - margin;
      if (!clipped) break;
      scale *= 0.86;
    }

    fitRef = { W, H: logicalHeight(H), scale: a[0], tx: a[12], ty: a[13] };
    if (cacheKey) {
      try {
        window.localStorage.setItem(cacheKey, JSON.stringify(fitRef));
      } catch (e) {}
    }
    return true;
  }

  function applyFitInner(ref: FitRef): void {
    // 每次应用前夹一次：窗口/画布变了，允许的最大倍率也会变
    zoom = Math.min(zoom, maxZoomAllowed());
    const arr = matrix();
    if (!arr) return;
    const a = arr.getArray();
    a[0] = ref.scale * zoom;
    a[5] = ref.scale * zoom;
    a[12] = ref.tx;
    a[13] = ref.ty;
  }

  function applyFit(ref: FitRef): void {
    fitRef = { ...ref };
    applyFitInner(fitRef);
  }

  function rescaleForWindow(): boolean {
    zoom = Math.min(zoom, maxZoomAllowed());
    const arr = matrix();
    if (!arr || !fitRef) return false;
    // 用 window.innerHeight：resize 瞬间 canvas 的 rect 会滞后，导致算错比例
    const realH = Math.max(50, Math.round(window.innerHeight || deps.getCanvas().getBoundingClientRect().height));
    const H = logicalHeight(realH);
    const a = arr.getArray();
    const k = H / fitRef.H;
    // 即使尺寸"变回原值"也要重写矩阵，否则滚轮预览留下的缩放会留在身上（看起来她变小了）
    a[0] = fitRef.scale * k * zoom;
    a[5] = fitRef.scale * k * zoom;
    a[12] = fitRef.tx;
    a[13] = fitRef.ty;
    return true;
  }

  /** 角色缩放：漫游模式下滚轮改的就是这个（窗口保持铺满） */
  /** 当前允许的最大缩放：让她最高长到画布高度的 96%，再大就会被切头 */
  function maxZoomAllowed(): number {
    try {
      const rect = deps.getCanvas().getBoundingClientRect();
      const canvasH = Math.max(80, rect.height);
      const baseH = (fitRef ? fitRef.H : (deps.maxLogicalHeight || canvasH)) * 0.82;
      return Math.max(1, Math.min(3.0, (canvasH * 0.80) / Math.max(1, baseH)));
    } catch (e) {
      return 3.0;
    }
  }

  function zoomBy(factor: number): number {
    const next = Math.max(0.35, Math.min(maxZoomAllowed(), zoom * Number(factor || 1)));
    if (Math.abs(next - zoom) < 0.0001) return zoom;
    zoom = next;
    if (fitRef) applyFitInner(fitRef);
    return zoom;
  }

  function getZoom(): number {
    return zoom;
  }

  function setZoom(value: number): number {
    zoom = Math.max(0.35, Math.min(maxZoomAllowed(), Number(value) || 1));
    if (fitRef) applyFitInner(fitRef);
    return zoom;
  }

  function getScale(): number | null {
    const arr = matrix();
    if (!arr) return null;
    const a = arr.getArray();
    return a && a.length ? a[0] : null;
  }

  /** 模型矩阵是否已就绪 */
  function isReady(): boolean {
    return !!matrix();
  }

  function getRef(): FitRef | null {
    return fitRef ? { ...fitRef } : null;
  }

  function invalidate(): void {
    fitRef = null;
  }

  return { autoFit, rescaleForWindow, applyFit, getRef, getScale, isReady, invalidate, zoomBy, getZoom, setZoom };
}
