/**
 * timers.ts — 统一管理定时器与 rAF。
 *
 * 以前定时器散在交互代码里（气泡、表情回流、触摸、滚轮、待机、拖动帧），
 * 各自 clearTimeout，卸载或热重载时容易漏清理，导致「同一个动作被触发两次」
 * 这类难查的问题。这里给一个很小的注册表，提供统一的清理入口。
 */

export interface TimerBag {
  /** 延时执行（返回 id，可用于取消） */
  setTimeout(fn: () => void, ms: number): number;
  /** 取消某个延时 */
  clearTimeout(id: number): void;
  /** 每帧执行（等价 requestAnimationFrame），返回 id */
  raf(fn: (t: number) => void): number;
  /** 取消某个 rAF */
  cancelRaf(id: number): void;
  /** 清掉本 bag 里所有还活着的定时器/帧 */
  clearAll(): void;
  /** 当前存活的定时器数量（调试/测试用） */
  size(): number;
}

export function createTimerBag(): TimerBag {
  const timeouts = new Set<number>();
  const rafs = new Set<number>();

  return {
    setTimeout(fn: () => void, ms: number): number {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        try {
          fn();
        } catch (e) {
          // 定时器里的异常不能拖垮主循环
          console.error('[timers] timeout 回调抛错', e);
        }
      }, ms);
      timeouts.add(id);
      return id;
    },

    clearTimeout(id: number): void {
      if (!id) return;
      timeouts.delete(id);
      window.clearTimeout(id);
    },

    raf(fn: (t: number) => void): number {
      const id = window.requestAnimationFrame((ts) => {
        rafs.delete(id);
        try {
          fn(ts);
        } catch (e) {
          console.error('[timers] rAF 回调抛错', e);
        }
      });
      rafs.add(id);
      return id;
    },

    cancelRaf(id: number): void {
      if (!id) return;
      rafs.delete(id);
      window.cancelAnimationFrame(id);
    },

    clearAll(): void {
      for (const id of timeouts) window.clearTimeout(id);
      for (const id of rafs) window.cancelAnimationFrame(id);
      timeouts.clear();
      rafs.clear();
    },

    size(): number {
      return timeouts.size + rafs.size;
    },
  };
}
