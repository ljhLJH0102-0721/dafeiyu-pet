# 第三方组件与资源

本仓库的 **MIT 许可只覆盖我们自己写的代码**。下面这些内容**不在仓库里**，
或者以各自的方式使用，请在使用 / 分发前确认你遵守了对应协议。

---

## 1. Live2D Cubism SDK for Web / Cubism Core

* **用途**：渲染 Live2D 模型的运行时（`live2dcubismcore.js` 与 `Framework/`）
* **归属**：Live2D Inc.
* **许可**：Live2D Proprietary Software License / Cubism SDK Release License
* **是否随本仓库分发**：**否**
* **你需要做什么**：
  1. 到 <https://www.live2d.com/sdk/cubism/sdk-download/> 下载 Cubism SDK for Web
  2. 把其中的 `Core/live2dcubismcore.js` 放到 `renderer/public/Core/`
  3. 把 `Framework/src/` 放到仓库同级的 `Framework/src/`（`renderer/vite.config.mts` 里的 `@framework` 别名指向它）
  4. 遵守 Live2D 的授权条款（含收入门槛等条件，以官网为准）

> 仓库里的 `renderer/src/lapp*.ts` 是**基于官方 Sample 修改**的代码
> （保留原版权头）。按官方许可，修改与再分发需保留版权声明。

---

## 2. Live2D 模型文件

* **用途**：`.model3.json` / `.moc3` / 贴图 / 动作
* **是否随本仓库分发**：**否**
* 如果你使用官方示例模型（Haru / Hiyori / Mao / Natori / Rice / Wanko / Mark），
  它们属于 Live2D 的示例资源，分发条件以官方说明为准。
* 如果你使用自制或购买的模型，请遵守该模型自己的使用条款
  （很多模型禁止商用、禁止二次分发）。

---

## 3. 语音模型

| 组件 | 用途 | 许可 |
|---|---|---|
| **Silero VAD**（`silero_vad.onnx`） | 语音活动检测 | MIT |
| **SenseVoice**（`model.int8.onnx` / `tokens.txt`） | 语音识别 | 见模型仓库说明（FunAudioLLM/SenseVoice） |
| **sherpa-onnx**（Python 包） | 推理框架 | Apache-2.0 |

本仓库**不包含**这些模型文件，需要自行下载到：

```
%USERPROFILE%\.dsh\speech-to-text\sensevoice\models\
    ├─ silero\silero_vad.onnx
    └─ sensevoice-onnx\model.int8.onnx  （以及 tokens.txt）
```

模型下载：<https://github.com/k2-fsa/sherpa-onnx/releases>

---

## 4. Python 依赖

见 `brain/requirements.txt`。主要包括：

| 包 | 许可 |
|---|---|
| `numpy` | BSD-3-Clause |
| `pyaudio` | MIT |
| `requests` | Apache-2.0 |
| `sherpa-onnx` | Apache-2.0 |
| `zstandard` | BSD-3-Clause |
| `psutil` | BSD-3-Clause |
| `edge-tts` | GPL-3.0（注意：如果你的分发方式与 GPL 不兼容，请替换 TTS 实现） |
| `PySide6` | LGPL-3.0 |

---

## 5. 前端依赖

见 `renderer/package.json`：`vite`、`typescript`、`eslint`、`@mediapipe/tasks-vision` 等，
各自遵守其开源许可。

---

## 6. 字体与音效

* 触摸音效由 **WebAudio 实时合成**，不含任何音频文件，无版权问题。
* 界面字体使用系统字体（Microsoft YaHei UI / Segoe UI），不内嵌字体文件。

---

如果你认为本仓库中有内容侵犯了你的权利，请开 issue，我会立刻处理。
