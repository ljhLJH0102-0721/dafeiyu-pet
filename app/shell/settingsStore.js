/**
 * settingsStore.js — 桌宠设置的读写。
 *
 * 设计目标：设置必须在**界面上**能改（右键 → 设置），不能让人去手编 JSON。
 * 写盘分两处：
 *   · pet-shell/pet-settings.json  界面/外观/音效/行为
 *   · dafeiyu-pet/voice_bridge.json 大脑（API）与语音相关，语音桥启动时读
 * 两处都保留原有键，只覆盖我们管的字段，避免把用户手写的东西冲掉。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SHELL_DIR = __dirname.replace(/[\\/]shell$/, '');

/**
 * 语音桥目录（Python 那一半）。
 *
 * 开源要点：这里**不能写死某台机器的路径**。解析顺序：
 *   1. 环境变量 PET_PY_DIR
 *   2. 与 pet-shell 同级、或上一层里的 dafeiyu-pet
 *   3. 旧默认位置（本机迁移用，找不到就当空）
 */
function resolvePetDir() {
  const candidates = [];
  if (process.env.PET_PY_DIR) candidates.push(process.env.PET_PY_DIR);
  const shellParent = path.dirname(SHELL_DIR);
  candidates.push(path.join(shellParent, 'dafeiyu-pet'));
  candidates.push(path.join(shellParent, '..', 'dafeiyu-pet'));
  if (process.env.USERPROFILE) {
    candidates.push(path.join(
      process.env.USERPROFILE, 'Documents', 'deepseek-harness',
      'default-workspace', 'dafeiyu-pet'
    ));
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return path.resolve(c);
    } catch (e) {}
  }
  return candidates[0] || shellParent;
}

const PET_DIR = resolvePetDir();

const UI_PATH = path.join(SHELL_DIR, 'pet-settings.json');
const BRIDGE_PATH = path.join(PET_DIR, 'voice_bridge.json');

const UI_DEFAULTS = {
  // 交互
  touchSound: true,          // 摸她/点她时的音效
  soundVolume: 0.5,
  // 外观
  alwaysOnTop: true,
  // 行为
  roamMode: false,           // 全屏漫游（她可以在整个屏幕活动，不再是那个小框）
  // 对话方式：auto = 一直听；ptt = 按住按键才听
  voiceMode: 'auto',
  pttKey: 'Backquote',       // KeyboardEvent.code；Esc 不允许
  // 插件（创意工坊）：id → 是否启用
  plugins: {},
  // 时事新闻推送
  newsEnabled: false,
  newsIntervalMin: 30,
  newsTopics: ['AI', '游戏'],
  // 大脑
  llm: {
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-4-flash',
    api_key: '',
    api_key_env: 'ZAI_CODING_CN_API_KEY',
  },
  voice: {
    enabled: true,
    voiceName: 'zh-CN-XiaoyiNeural',
  },
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/** 合并默认值（只补缺失的键，不动用户已有值） */
function withDefaults(obj, defs) {
  const out = { ...defs };
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]) && defs[k] && typeof defs[k] === 'object') {
      out[k] = withDefaults(obj[k], defs[k]);
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

function getSettings() {
  const ui = withDefaults(readJson(UI_PATH), UI_DEFAULTS);
  const bridge = readJson(BRIDGE_PATH) || {};
  // 大脑配置以 voice_bridge.json 为准（语音桥真正读它）
  const llm = bridge.llm || {};
  ui.llm = {
    base_url: llm.base_url || ui.llm.base_url,
    model: llm.model || ui.llm.model,
    api_key: llm.api_key || '',
    api_key_env: llm.api_key_env || ui.llm.api_key_env,
  };
  const voice = bridge.voice || {};
  ui.voice = {
    enabled: bridge.voice_enabled !== false,
    voiceName: voice.name || ui.voice.voiceName,
  };
  ui.brainMode = bridge.brain_mode || 'api';
  // 对话方式以语音桥配置为准（它才是真正执行的）
  if (bridge.voice_mode === 'ptt' || bridge.voice_mode === 'auto') ui.voiceMode = bridge.voice_mode;
  if (bridge.ptt_key) ui.pttKey = String(bridge.ptt_key);
  // 插件启用状态存在 shell 自己的设置里
  if (ui.plugins && typeof ui.plugins === 'object') { /* 已是对象 */ }
  // 新闻
  if (bridge.news_enabled != null) ui.newsEnabled = !!bridge.news_enabled;
  if (bridge.news_interval_min) ui.newsIntervalMin = Number(bridge.news_interval_min) || 30;
  if (Array.isArray(bridge.news_topics)) ui.newsTopics = bridge.news_topics.map(String);
  return ui;
}

function setSettings(patch) {
  const cur = getSettings();

  // 1) 界面侧
  const nextUI = {
    touchSound: patch.touchSound != null ? !!patch.touchSound : cur.touchSound,
    soundVolume: patch.soundVolume != null ? Number(patch.soundVolume) : cur.soundVolume,
    alwaysOnTop: patch.alwaysOnTop != null ? !!patch.alwaysOnTop : cur.alwaysOnTop,
    roamMode: patch.roamMode != null ? !!patch.roamMode : cur.roamMode,
    voiceMode: patch.voiceMode === 'ptt' || patch.voiceMode === 'auto' ? patch.voiceMode : cur.voiceMode,
    // Esc 是保留键（用来关窗口/取消），不允许绑定
    pttKey: patch.pttKey && patch.pttKey !== 'Escape' ? String(patch.pttKey) : cur.pttKey,
    plugins: (patch.plugins && typeof patch.plugins === 'object')
      ? Object.assign({}, cur.plugins, patch.plugins)
      : cur.plugins,
    newsEnabled: patch.newsEnabled != null ? !!patch.newsEnabled : cur.newsEnabled,
    newsIntervalMin: patch.newsIntervalMin != null ? Math.max(5, Number(patch.newsIntervalMin) || 30) : cur.newsIntervalMin,
    newsTopics: Array.isArray(patch.newsTopics) ? patch.newsTopics.map(String) : cur.newsTopics,
  };
  writeJson(UI_PATH, nextUI);

  // 2) 语音桥侧（只覆盖我们管的键）
  const bridge = readJson(BRIDGE_PATH) || {};
  bridge.brain_mode = 'api';
  bridge.llm = {
    ...(bridge.llm || {}),
    base_url: (patch.llm && patch.llm.base_url) || cur.llm.base_url,
    model: (patch.llm && patch.llm.model) || cur.llm.model,
    api_key_env: (patch.llm && patch.llm.api_key_env) || cur.llm.api_key_env,
  };
  if (patch.llm && patch.llm.api_key !== undefined) {
    const k = String(patch.llm.api_key || '').trim();
    // 空字符串 = 回到「从环境变量/凭证文件读」
    if (k) bridge.llm.api_key = k;
    else delete bridge.llm.api_key;
  }
  if (patch.voice && patch.voice.voiceName) {
    bridge.voice = { ...(bridge.voice || {}), name: patch.voice.voiceName };
  }
  // 对话方式（语音桥读这两个键）
  if (nextUI.voiceMode) bridge.voice_mode = nextUI.voiceMode;
  if (nextUI.pttKey) bridge.ptt_key = nextUI.pttKey;
  // 新闻推送
  bridge.news_enabled = !!nextUI.newsEnabled;
  bridge.news_interval_min = nextUI.newsIntervalMin;
  bridge.news_topics = nextUI.newsTopics || [];
  writeJson(BRIDGE_PATH, bridge);

  return getSettings();
}

module.exports = {
  getSettings,
  setSettings,
  UI_PATH,
  BRIDGE_PATH,
  PET_DIR,
  UI_DEFAULTS,
};
