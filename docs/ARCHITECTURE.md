# 大肥鱼桌宠 · 架构与不变式

> 这份文档存在的目的只有一个：**让已经修过的 bug 不能再回来**。
> 每个「不变式」都有对应的自动化检查（`scripts/check-rules.mjs`）或测试（`tests/`）。

---

## 1. 运行结构

```
┌─────────────────────────────── Electron 外壳（app/） ───────────────────────────────┐
│  main.js            启动装配（静态服务 / API / 托盘 / 右键菜单 / 全局热键）              │
│  shell/windowState  窗口几何的唯一真相                                                     │
│  shell/pageCommand  唯一允许构造 JS 字符串的地方                                           │
│  shell/（规划中）    hitTest / apiServer / tray / menu 拆出                                │
│                                                                                            │
│        HTTP :5010 静态资源（renderer/dist）      HTTP :5011 控制 API（24 个端点）              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │ executeJavaScript（仅 pageCommand）
                                              ▼
┌──────────────────────────── Demo 页面（renderer/src/） ───────────────────────────────────────┐
│  main.ts            浏览器入口，初始化 Live2D + 交互                                       │
│  pet/pose.ts        姿态唯一写者（纯函数，可单测）                                         │
│  pet/modelFit.ts    模型矩阵唯一写者（单飞 + 幂等 + 持久化缓存）                           │
│  pet/timers.ts      定时器统一注册/清理                                                    │
│  pet/commandBus.ts  页面命令注册表（window.__pet.command）                                 │
│  interact.ts        事件与装配（鼠标/拖动/缩放/气泡/表情/手势）                            │
│  lappmodel.ts 等    官方 Sample，不改内部（只在注入块加约束）                              │
└────────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────── 语音与大脑（brain/，Python） ─────────────────────────────────┐
│  voice_bridge.py   麦克风 → Silero 切段 → SenseVoice ASR → DSH 大脑 → edge-tts → 播放     │
│  dsh_context.py    读 ~/.dsh/sessions 的 zstd 会话日志 → 知道主人正在做什么                │
│  pet_voice.py      TTS 合成 + 交给页面播放 + 气泡                                         │
│  desktop_tool.py   键鼠模拟 / OCR / 窗口操作                                              │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据流

### 交互链路（每帧）

```
鼠标事件 ─→ interact（意图：拖动 / 点击 / 悬停 / 滚轮）
              │
              ├─ gaze 偏移（视线 -1~1）
              ├─ gesture 偏移（摇头/点头/歪头/晃身/晃脑袋）
              └─ 弹簧摆动（被拖动时）
                     ↓
              pet/pose.computePose()  ← 唯一合成点（待机 + 视线 + 小动作 + 困倦 + 惊讶）
                     ↓
              写入参数（每帧一次，interact 里的提交循环）
                     ↓
              lappmodel.applyHold() → 渲染
```

### 尺寸链路

```
/size 或滚轮或托盘
      ↓
shell/windowState.setSize()  → 夹取 + 锁宽高比 + 对齐设备像素 + setBounds
      ↓
页面收到 resize → pet/modelFit.rescaleForWindow()（按比例换算，不重扫）
      ↓
OS 触发的 resize 事件 → windowState.reconcile()（拖动中忽略、≤2px 抖动忽略）
                       + 1.5s 看门狗做自愈对账
```

### 语音链路

```
麦克风 → Silero VAD 切段 →（可选二次过滤）→ SenseVoice ASR（默认普通话）
      → dsh_context 注入「主人在做什么」→ DSH 子会话（pet-brain-<uuid>）
      → 回复 → edge-tts 合成 mp3 → 页面 __playAudio + 气泡 → 口型
```

---

## 3. 不变式（改动前先看这里）

| # | 不变式 | 为什么 | 怎么保证 |
|---|---|---|---|
| 1 | 每帧只有 `pet/pose.ts` 合成参数 | 多处写参数 → 动作打架、卡姿势 | `check-rules.mjs` + `tests/test_pose.test.mjs` |
| 2 | 只有 `pet/modelFit.ts` 改模型矩阵 | 多处改矩阵 → 越缩越小、滚轮回不去 | `check-rules.mjs` |
| 3 | 只有 `shell/windowState.js` 改窗口几何 | 多处写几何 → 越拖越大、缩放漂移 | `check-rules.mjs` + `tests/test_windowState.test.mjs` |
| 4 | 只有 `shell/pageCommand.js` 拼 JS 字符串 | 手拼字符串失败是**静默**的 | `check-rules.mjs` |
| 5 | 拖动期间不采信 `resize`、不做命中检测 | 1px 抖动会被写成新基准（正反馈） | 单测「拖动中不采信 resize」 |
| 6 | 宽高比永远锁当前形状 | 变形没有意义，`/size{600,600}` 会把她拉成方块 | 单测「请求方块尺寸也不改变形状」 |
| 7 | 拟合单飞 + 幂等 + 持久化缓存 | 并发适配越缩越小；重扫 3136 次会卡 5 秒 | 单测 + 集成测试 |
| 8 | 定时器经 `pet/timers.ts` 注册 | 漏清理 → 同一动作被触发两次 | 代码评审 |
| 9 | 公开 API 与 `window.__*` 只增不删 | 语音桥/插件依赖 | `tests/test_api_contract.py` |

---

## 4. 历史 bug 与对应测试

| Bug | 根因 | 现在的护栏 |
|---|---|---|
| 越拖越大 | resize 把 OS 的 1px 抖动写成新基准（正反馈） | `windowState.reconcile` 拖动中忽略 + ≤2px 忽略<br>`test_windowState.test.mjs` / `test_window_stability.py` |
| 越拖越小 / 缩放漂移 | `clampSize` 分支用 `/ar` 而非 `*ar` | 单测「夹取：超过工作区时等比缩小」 |
| 请求方块尺寸就变形 | 未超界时完全不看宽高比 | 单测「请求方块尺寸也不改变形状」 |
| 自动适配越缩越小 | autoFit 并发 | `modelFit.autoFit` 单飞 + 幂等缓存 |
| 鞋子被窗口裁掉 | 适配目标比例与边距 | 扫描网格 56 + 边距 `max(16, 3%H)` |
| 启动卡 5 秒、API 全超时 | autoFit 逐像素回读 3136 次 | 拟合结果持久化到 localStorage |
| 拖动掉帧 | 每个 mousemove 都 setBounds + setSize | 页面每帧只发一次 IPC + 单次 setBounds |
| 拖动状态卡死 → 窗口尺寸脱节 | 丢了 mouseup | 1.5s 看门狗 + `assertConsistent` 自愈 |
| 手拼 JS 三次事故 | `${}` 被 PowerShell 展开、`.map()` 未展开、转义错 | 只允许 `pageCommand` + `check-rules` |
| 语音桥启动即崩 | `vad.front()`（属性当方法）、缺 `threshold` 属性 | `python voice_bridge.py --selfcheck` |
| 粤语误选 | 乱码时粤语评分偏高 | 默认普通话（`PET_ASR_LANG`） |
| 类型检查形同虚设 | `@framework` 别名指向不存在的目录 | tsconfig 修正 + `live2dcubismcore.d.ts` |
| `npm run build` 直接崩 | `copy_resources.js` 路径停留在旧布局 | 改成 `__dirname` 解析 + 源不存在跳过 |

---

## 5. 常用命令

```powershell
# 一键验收（6 项）
pwsh -File scripts\verify.ps1

# 只跑单元测试
tools\node\node.exe --test

# 结构门禁（不变式检查）
tools\node\node.exe scripts\check-rules.mjs

# 集成测试（需要桌宠在跑）
python tests\test_window_stability.py
python tests\test_api_contract.py

# 重新构建页面
cd Demo; node node_modules\vite\bin\vite.js build

# 重启桌宠
Stop-Process -Name electron -Force
Start-ScheduledTask -TaskName 'Dafeiyu-Pet-Live2D'
```

---

## 6. 目录约定

```
ai-pet-live2d/
  renderer/                 Live2D 页面（官方 Sample + 我们的 pet/ 模块）
    src/pet/            ★ 新增模块都放这里，单个文件 < 250 行
    src/interact.ts     事件与装配
  app/            Electron 外壳
    shell/              ★ 按职责拆（geometry / command / api / tray）
    main.js             只做启动装配
  tests/                回归测试（node --test + Python 集成测试）
  scripts/              verify.ps1 / check-rules.mjs
  brain/          语音与大脑（Python，独立 venv）
```

---

## 7. 待办（按优先级）

1. `app/main.js` 的 24 个端点从 if 链改成路由表；托盘/菜单/IPC 拆到 `shell/`
2. `interact.ts` 继续拆：`bubble / expressions / zoom / input` 各自成模块
3. Python 包化：`audio/ dialog/ actions/ tts/`，`voice_bridge.py` 只做装配
4. 口型换成真实音量包络（现在是随机开合）
5. Silero 切段的段长偏长（实测出现过 14 秒），调 `min_silence_duration`
