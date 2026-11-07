// shell/plugins.js —— 插件宿主（创意工坊）
//
// 目录约定：
//   <app>/pet-shell/plugins/<插件id>/plugin.json
//   <app>/pet-shell/plugins/<插件id>/index.js      （可选）
//
// plugin.json 示例：
//   {
//     "id": "clock",
//     "name": "现在几点了",
//     "version": "0.1.0",
//     "author": "你的名字",
//     "description": "在右键菜单加一项，点一下她用气泡报时间",
//     "menu": [{ "id": "time", "label": "现在几点了", "icon": "🕒" }],
//     "entry": "index.js"
//   }
//
// 页面侧通过 window.petPlugins.register(id, { action(actionId) { ... } }) 接入，
// 菜单项被点击时外壳会调用 __runPlugin(id, actionId)。

const fs = require('fs');
const path = require('path');

const MANIFEST = 'plugin.json';

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function createPluginHost(options) {
  const opts = options || {};
  const baseDir = opts.dir;
  const log = opts.log || (() => {});
  const getSettings = opts.getSettings || (() => ({}));
  const savePlugins = opts.savePlugins || (() => {});
  let plugins = [];

  /** 插件默认启用；设置里显式写了 false 才关掉 */
  function isEnabled(id) {
    const s = getSettings() || {};
    const map = s.plugins || {};
    return map[id] !== false;
  }

  function setEnabled(id, on) {
    savePlugins(String(id), !!on);
    return isEnabled(id);
  }

  /** 扫描 plugins 目录，返回插件列表（含坏掉的插件，标记 error） */
  function scan() {
    plugins = [];
    try {
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
      const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const ent of entries) {
        const dir = path.join(baseDir, ent.name);
        const manifestPath = path.join(dir, MANIFEST);
        if (!fs.existsSync(manifestPath)) continue;
        const raw = safeReadJson(manifestPath);
        const item = {
          id: ent.name,
          name: ent.name,
          version: '',
          author: '',
          description: '',
          menu: [],
          entry: '',
          dir,
          error: '',
        };
        if (!raw) {
          item.error = 'plugin.json 不是合法 JSON';
        } else {
          item.id = String(raw.id || ent.name);
          item.name = String(raw.name || item.id);
          item.version = String(raw.version || '');
          item.author = String(raw.author || '');
          item.description = String(raw.description || '');
          item.entry = String(raw.entry || '');
          item.menu = Array.isArray(raw.menu)
            ? raw.menu
                .filter((m) => m && m.id && m.label)
                .map((m) => ({ id: String(m.id), label: String(m.label), icon: String(m.icon || '') }))
            : [];
          if (item.entry && !fs.existsSync(path.join(dir, item.entry))) {
            item.error = '入口文件不存在：' + item.entry;
          }
        }
        item.enabled = isEnabled(item.id);
        plugins.push(item);
      }
    } catch (e) {
      log('[plugins] 扫描失败', String(e));
    }
    log('[plugins] 共发现 ' + plugins.length + ' 个，启用 ' + plugins.filter((p) => p.enabled).length + ' 个');
    return plugins;
  }

  function list() {
    return plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      author: p.author,
      description: p.description,
      menuCount: p.menu.length,
      enabled: isEnabled(p.id),
      error: p.error,
    }));
  }

  /** 右键菜单里要显示的插件项 */
  function menuItems() {
    const out = [];
    for (const p of plugins) {
      if (!isEnabled(p.id) || p.error) continue;
      for (const m of p.menu) {
        out.push({
          id: 'plugin:' + p.id + ':' + m.id,
          label: m.label,
          icon: m.icon || '🧩',
        });
      }
    }
    return out;
  }

  /** 读取所有启用插件的入口 JS，供外壳注入页面 */
  function entryScripts() {
    const out = [];
    for (const p of plugins) {
      if (!isEnabled(p.id) || p.error || !p.entry) continue;
      try {
        const code = fs.readFileSync(path.join(p.dir, p.entry), 'utf8');
        if (code && code.trim()) out.push({ id: p.id, name: p.name, code });
      } catch (e) {
        log('[plugins] 读取入口失败 ' + p.id, String(e));
      }
    }
    return out;
  }

  /** 在 plugins 目录里生成一个模板插件，方便后来者照着改 */
  function createTemplate(id) {
    const safe = String(id || '').replace(/[^\w\-]/g, '') || 'my-plugin';
    const dir = path.join(baseDir, safe);
    if (fs.existsSync(dir)) return { ok: false, error: '目录已存在：' + safe };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const manifest = {
        id: safe,
        name: '我的插件',
        version: '0.1.0',
        author: '你的名字',
        description: '在右键菜单里加一项，点一下她用气泡说句话',
        menu: [{ id: 'hello', label: '我的插件：说句话', icon: '🧩' }],
        entry: 'index.js',
      };
      fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
      const js = [
        '// 插件入口：页面里执行的代码',
        '// 可用工具：api.bubble / api.expression / api.motion / api.gesture',
        "window.petPlugins.register('" + safe + "', {",
        '  action(actionId) {',
        "    if (actionId === 'hello') {",
        "      window.petPlugins.bubble('这是我的第一个插件～', 4);",
        '      return true;',
        '    }',
        '    return false;',
        '  },',
        '});',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'index.js'), js, 'utf8');
      scan();
      return { ok: true, id: safe, dir };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    baseDir,
    scan,
    list,
    menuItems,
    entryScripts,
    isEnabled,
    setEnabled,
    createTemplate,
    get: () => plugins,
  };
}

module.exports = { createPluginHost };
