# 插件目录

一个文件夹一个插件，右键菜单 → 🧩 创意工坊 里可以开关它们。

## 最小例子

```
clock/
├─ plugin.json
└─ index.js
```

`plugin.json`

```json
{
  "id": "clock",
  "name": "现在几点了",
  "menu": [{ "id": "time", "label": "现在几点了", "icon": "🕒" }],
  "entry": "index.js"
}
```

`index.js`

```js
window.petPlugins.register('clock', {
  action(actionId) {
    if (actionId === 'time') {
      window.petPlugins.bubble('现在 ' + new Date().toLocaleTimeString() + ' 啦~', 4);
      return true;
    }
    return false;
  },
});
```

## 完整文档

见 `docs/PLUGIN.md`（仓库里），或者直接看工坊窗口右边的说明。