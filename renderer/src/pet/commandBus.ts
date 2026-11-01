/**
 * commandBus.ts — 页面与外壳之间唯一的命令入口。
 *
 * 背景：以前外壳用 `executeJavaScript('window.__xxx(...)')` 手拼 JS 字符串，
 * 光是这个项目就被坑过三次：
 *   · PowerShell here-string 把 `${JSON.stringify(kind)}` 当变量展开成空
 *   · `.map()` 忘了展开运算符，模板直接报 Invalid template
 *   · 引号/中文转义写错，页面上静默失败
 *
 * 现在：外壳只调 `command(name, args)`，参数走 JSON.stringify 一次，
 * 页面这边按名字查表执行。新功能只要 `register()` 一行。
 *
 * 挂载点：`window.__pet.command(name, args)` / `window.__pet.commands()`。
 * 旧的 `window.__bubble` 等仍然保留（一版兼容），内部改为转调这里。
 */

export type CommandHandler = (args: any) => any;

const handlers = new Map<string, CommandHandler>();

/** 注册一个命令。重名会覆盖（便于热重载）。 */
export function register(name: string, fn: CommandHandler): void {
  handlers.set(String(name), fn);
}

/** 立即执行一个命令（外壳通过 executeJavaScript 调到这里） */
export function command(name: string, args?: any): any {
  const fn = handlers.get(String(name));
  if (!fn) {
    return { ok: false, error: 'unknown command: ' + name };
  }
  try {
    return fn(args == null ? {} : args);
  } catch (e) {
    return { ok: false, error: String((e as any && (e as any).message) || e) };
  }
}

/** 已注册的命令名（调试用） */
export function commands(): string[] {
  return Array.from(handlers.keys()).sort();
}

/** 把入口挂到 window 上，只挂一次 */
export function install(): void {
  const w = window as any;
  if (w.__pet && w.__pet.command) return;
  w.__pet = w.__pet || {};
  w.__pet.command = command;
  w.__pet.commands = commands;
}
