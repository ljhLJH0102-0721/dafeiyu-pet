# 模型放这里

本仓库**不带模型文件**（版权原因）。目录结构约定：

```
renderer/public/Resources/
  └─ 大肥鱼/                 ← 你的模型目录（名字随意，启动时用 --model 指定）
       ├─ 大肥鱼.model3.json
       ├─ 大肥鱼.moc3
       ├─ 大肥鱼.physics3.json
       ├─ 大肥鱼.cdi3.json
       ├─ *.2048/texture_00.png ...
       └─ *.exp3.json / *.motion3.json（可选）
```

## 默认模型

- 名称：**大肥鱼**
- 作者：**神宫凉子**（B 站）
- 版权归作者所有，请到作者处获取；本仓库不分发。

## 换成别的模型

1. 把模型目录放进 `renderer/public/Resources/`
2. 启动时加 `--model <目录名>`，或在 `app/pet-settings.json` 里改 `model`
3. 想改显示的名字/大小，见 `README.md` 的「换模型」一节

> 官方示例模型（Haru / Hiyori / Mao…）同样没有放进来，授权见仓库根目录 `THIRD-PARTY.md`。