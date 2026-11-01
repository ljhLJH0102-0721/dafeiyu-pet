/**
 * live2dcubismcore.d.ts — Cubism Core 的环境声明。
 *
 * 为什么需要：`Core/` 里只有官方提供的 live2dcubismcore.js（专有文件，不含类型），
 * 而 Framework 直接使用全局的 `Live2DCubismCore`。原先的工程靠 `Core/*.ts`
 * 提供类型，迁移后这个文件丢了 → `tsc --noEmit` 报 31 个 "Cannot find name/
 * namespace 'Live2DCubismCore'"。
 *
 * 这里只声明 Framework 实际用到的成员，函数签名保持真实，重类型用 any 兜底，
 * 目的是让类型检查能跑起来、能挡住我们自己代码里的错误。
 */

declare namespace Live2DCubismCore {
  /** 日志回调 */
  type csmLogFunction = (message: string) => void;

  /** 原生句柄类型（具体结构由 wasm/js 实现提供） */
  type Moc = any;
  type Model = any;
  type Physics = any;
  type Motion = any;
  type csmParameterType = any;
  type csmVector2 = any;
  type csmVector3 = any;
  type csmVector4 = any;

  const Version: {
    csmGetVersion(): number;
    csmGetLatestMocVersion(): number;
  };

  const Logging: {
    csmSetLogFunction(fn: csmLogFunction | null): void;
    csmGetLogFunction(): csmLogFunction | null;
  };

  const Memory: {
    initializeAmountOfMemory(size: number): void;
  };

  const Utils: any;
  const Moc: any;
  const Model: any;
  const Physics: any;
}
