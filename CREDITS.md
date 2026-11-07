# 致谢与版权

## 模型

**Live2D 模型「大肥鱼」**

- **作者：神宫凉子**（B 站）
- 本仓库**不包含**模型文件（`.moc3` / 贴图 / 表情 / 动作），
  版权归作者所有，请到作者处获取授权与文件。
- 拿到模型后放到 `renderer/public/Resources/大肥鱼/` 即可直接使用
  （目录里需要 `大肥鱼.model3.json`、`大肥鱼.moc3`、`*.2048/texture_*.png` 等）。

如果作者允许你分发，把文件放回去再提交即可 —— 请遵守作者的使用条款。

## 软件与素材

| 项目 | 用途 | 授权 |
|---|---|---|
| [Live2D Cubism SDK for Web](https://www.live2d.com/sdk/cubism/) | 渲染 | Live2D 专有许可（见 `THIRD-PARTY.md`） |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 语音识别 / VAD | Apache-2.0 |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 模型 | 中文语音识别 | 见上游许可 |
| [Silero VAD](https://github.com/snakers4/silero-vad) | 语音端点检测 | MIT |
| [edge-tts](https://github.com/rany2/edge-tts) | 语音合成 | GPL-3.0（仅调用其服务） |
| [Electron](https://www.electronjs.org/) | 桌面外壳 | MIT |
| [DeepSeek](https://www.deepseek.com/) | 对话大脑（可换任意 OpenAI 兼容接口） | 服务条款 |

## 说明

- 本项目的桌宠外壳、语音桥、动作/表情驱动逻辑由本项目作者编写，采用 `LICENSE` 中的许可。
- 模型的表现（长相、贴图、表情、动作资源）属于**模型作者**，与本项目许可无关。
- 模型名称、角色形象归原作者所有，本项目仅做技术演示。
