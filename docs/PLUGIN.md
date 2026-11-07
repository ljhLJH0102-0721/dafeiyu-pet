# 插件开发指南（创意工坊）

这个桌宠支持**插件**：不用改主体代码，就能给她加新的右键菜单项、新的反应、新的能力。

右键菜单 → **🧩 创意工坊** 可以看已装的插件、开关它们、一键生成模板。

---

## 1. 放在哪

```
pet-shell/plugins/
└─ <插件id>/
   ├─ plugin.json     ← 必须有：描述这个插件
   └─ index.js        ← 可选：页面里执行的代码（manifest 里 entry 指它）
```

一个文件夹就是一个插件。加完点工坊里的「重新扫描」（或者重启桌宠）即可生效。

---

## 2. plugin.json

```json
{
  "id": "clock",
  "name": "现在几点了",
  "version": "0.1.0",
  "author": "你的名字",
  "description": "点一下，她用气泡报时间",
  "menu": [
    { "id": "time", "label": "现在几点了", "icon": "🕒" }
  ],
  "entry": "index.js"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 建议 | 唯一标识；不写就用文件夹名 |
| `name` | 建议 | 工坊里显示的名字 |
| `version` | 否 | 版本号 |
| `author` | 否 | 作者 |
| `description` | 否 | 一句话说明（工坊里显示） |
| `menu` | 否 | 要加到右键菜单的项；`id` 是动作名，`label` 是显示文字 |
| `entry` | 否 | 入口 JS 文件名（相对插件目录） |

没有 `menu` 的插件不会出现在右键菜单里，但入口 JS 依然会在页面加载时执行（适合做后台小功能）。

---

## 3. index.js：页面里怎么接

外壳在页面加载后会把启用插件的 `entry` 注入页面执行，你用 `window.petPlugins.register` 注册：

```js
window.petPlugins.register('clock', {
  action(actionId) {
    if (actionId === 'time') {
      const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      window.petPlugins.bubble('现在 ' + t + ' 啦~', 4);
      return true;          // true = 已处理
    }
    return false;
  },
});
```

用户点右键菜单里那一项时，外壳会调用 `action('<menu里的id>')`。

---

## 4. 能用的工具（`window.petPlugins`）

| 方法 | 作用 |
|---|---|
| `bubble(text, seconds)` | 让她头顶冒一句话（纯气泡，不出声、不花 token） |
| `expression(name)` | 切表情。name 见右键菜单「表情」里那些（脸红 / 爱心眼 / ＞＜ / 兔牙 …） |
| `motion(group, no)` | 播动作组。group 见右键「动作」（举手 / 放手 / 竖手指开 …） |
| `gesture(kind)` | 触发一次情绪反应，`'happy'` 之类 |
| `register(id, handlers)` / `unregister(id)` / `list()` | 注册 / 注销 / 列出 |

还有这些底层能力（不稳定，尽量用上面的封装）：

- `window.__bubble(text, sec)`、`window.__expression(name)`、`window.__motion(group, no)`
- `window.__twist()` 扭一下腰、`window.__react(kind)`

---

## 5. 想让她"说话"（出声）

页面里发不出声音（语音在 Python 那半边）。需要她念出来的话，写一个文件：

```js
// 兼容写法：没有桥也能跑，只是不出声
```

真正出声的办法是往 `dafeiyu-pet/command.txt` 写一行：

```
SAY:主人好呀～
```

语音桥会读到并直接用她的声音念出来（不经过模型、不花 token）。
这一步需要 Python 侧支持，普通网页插件做不到，属于「进阶改造点」。

---

## 6. 调试

- 打开 `pet-shell/pet-shell.log`，插件注入、菜单点击、错误都会记：
  - `[plugins] 已注入 N 个插件`
  - `[plugin] 未处理: clock time` ← 说明 `action()` 返回了 false
- 工坊里插件显示「有错误」时，把鼠标放上去看原因（JSON 写错 / entry 文件不存在）。

---

## 7. 更多改造点（想深入可以动的地方）

| 想改什么 | 去哪 |
|---|---|
| 右键菜单里加东西 | 插件 `plugin.json` 的 `menu`（推荐）；或 `pet-shell/main.js` 的 `buildMenuData()` |
| 加新的表情/动作入口 | `main.js` 里的 `EXPRESSIONS` / `MOTIONS` 常量 |
| 改她的姿势/摆动/呼吸 | `Demo/src/pet/pose.ts`（`computePose`） |
| 改视线跟随、拖动、点击判定 | `Demo/src/interact.ts` |
| 加新的"语音技能"（听懂某句话就做事） | `dafeiyu-pet/voice_bridge.py` 的 `local_plan()` |
| 加联网数据源 | `dafeiyu-pet/pet_net.py`（`search()` / `weather()` / `_hot_news()`） |
| 改语音（音色/语速/音调） | 设置页「语音对话」，或 `dafeiyu-pet/data/pet_voice.json` |
| 改设置页 | `pet-shell/settings.html` |

> 插件只覆盖「页面能做的事」。想做语音、系统操作这类，需要改 Python 半边，属于上表里的进阶改造点。

---

## 8. 最小可跑清单

1. 复制 `plugins/clock/` 改名
2. 改 `plugin.json` 里的 `id` / `label`
3. 改 `index.js` 里的注册 id 和气泡文案
4. 工坊 → 重新扫描 → 右键点新的一项
