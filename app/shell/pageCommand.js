/**
 * pageCommand.js — 外壳侧唯一允许构造 JS 字符串的地方。
 *
 * 规则（见 ARCHITECTURE.md 的不变式清单）：
 *   · 除本文件外，任何地方不得直接调用 win.webContents.executeJavaScript
 *   · 常规交互一律走 command(win, name, args)，参数由 JSON.stringify 序列化
 *   · run(win, js) 只给 /eval 调试通道用（需要执行任意表达式并等待 Promise）
 *
 * 为什么收拢：手拼字符串踩过三次坑（模板变量被吞、数组没展开、引号转义错），
 * 而且失败是静默的——页面上什么都没发生，日志里也看不出问题。
 */

'use strict';

/**
 * 调用页面里注册的命令。
 * @param {import('electron').BrowserWindow} win
 * @param {string} name
 * @param {any} [args]
 * @returns {Promise<any>}
 */
function command(win, name, args) {
  if (!win || win.isDestroyed()) return Promise.resolve(undefined);
  const expr =
    '(window.__pet && window.__pet.command ? window.__pet.command(' +
    JSON.stringify(String(name)) +
    ', ' +
    JSON.stringify(args === undefined ? null : args) +
    ') : undefined)';
  return win.webContents.executeJavaScript(expr);
}

/**
 * 调试通道：执行任意表达式（结果可以是 Promise）。
 * 仅 /eval 端点使用。
 * @param {import('electron').BrowserWindow} win
 * @param {string} js
 * @returns {Promise<any>}
 */
function run(win, js) {
  if (!win || win.isDestroyed()) return Promise.resolve(undefined);
  // 不要加括号包裹：/eval 会传多语句脚本（如 dispatchEvent(...); 'ok'），
  // 包成 (...) 就变成语法错误。executeJavaScript 本身会返回最后一个表达式的值。
  return win.webContents.executeJavaScript(String(js));
}

module.exports = { command, run };
