/**
 * settingsApply.js — 把设置真正应用到运行中的程序。
 *
 * 分开成模块的原因：main.js 已经很长，而且设置里要处理「重启语音桥」这种
 * 带引号的 PowerShell 调用，塞进字符串拼接里太容易写坏。
 */

'use strict';

const { execFile } = require('child_process');

/** 把设置推给桌宠窗口（音效、置顶等） */
function apply(win, settings, log, hooks) {
  if (!settings) return;
  try {
    // 全屏漫游：交给 windowState 统一处理（它会记住原尺寸以便恢复）
    if (hooks && typeof hooks.setRoam === 'function') {
      hooks.setRoam(!!settings.roamMode);
    }
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(!!settings.alwaysOnTop, 'screen-saver');
      win.webContents.send('pet:options', {
        touchSound: !!settings.touchSound,
        soundVolume: Number(settings.soundVolume || 0.5),
        roamMode: !!settings.roamMode,
      });
    }
  } catch (e) {
    if (log) log('[settings] 应用失败', String(e));
  }
}

/**
 * 重启语音桥。
 *
 * 用 schtasks 而不是 PowerShell：之前拼 `Get-CimInstance | Where-Object | ForEach-Object`
 * 那条命令时，引号在 execFile 里被拆坏，日志里报 ForEach-Object 参数错误。
 * 系统自带的任务调度器没有引号问题。
 *
 * 注意：LLM（大脑）配置已经支持热重载，改 API 不需要重启；
 * 这里主要给"音色"这类启动时读取的配置兜底。
 */
function restartBridge(log, delayMs = 600) {
  const run = (args) =>
    new Promise((resolve) => {
      execFile('schtasks.exe', args, { windowsHide: true }, (err) => resolve(err));
    });

  setTimeout(async () => {
    const e1 = await run(['/End', '/TN', 'DSH-AI-Voice']);
    await new Promise((r) => setTimeout(r, 1200));
    const e2 = await run(['/Run', '/TN', 'DSH-AI-Voice']);
    if (log) {
      log('[settings] 语音桥重启' + (e1 || e2 ? '有告警（任务可能没在跑）' : '已触发'));
    }
  }, delayMs);
}

module.exports = { apply, restartBridge };