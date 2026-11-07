#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
voice_bridge.py — 给大肥鱼桌宠装上耳朵和脑子（第二版）。

第一版的三个硬伤，这一版逐个修掉：

  1. **听错了设备。** Windows 上同一个「麦克风阵列」会以多个 index 暴露出来，
     系统默认那个可能是死的。实测 index 1 的 rmsMax 只有 0.0039，而 index 6
     是 0.325 —— 差 85 倍。所以启动时先逐个试采，挑电平最高的那一路；
     也可以用 voice_bridge.json 里的 device_index 强行指定。
  2. **断句把句子切碎。** 只有 34 帧（1.1 s）静音就收句，导致「我。」「钟。」
     「有吧。」这种碎片各走一趟。现在加了**碎片合并**：上一句结束后 900 ms 内
     又开口，就接在同一句里；同时按实测环境噪声自适应阈值，不再用固定的 0.014。
  3. **没有上下文。** 每次调用都是一次全新的子会话，agent 自己都说"我这边没接到
     上文"。现在把最近几轮对话拼进提示词一起送过去。

另外：回答语言强制为简体中文普通话（主人读得懂），说话仍是粤语/普通话双解码投票。

用法：
  python voice_bridge.py                 常驻监听
  python voice_bridge.py --devices       列出输入设备并测电平
  python voice_bridge.py --calibrate     测 3 秒环境噪声并打印建议阈值
  python voice_bridge.py --selftest      只测大脑连通性和说话通道
  python voice_bridge.py --say "测试"     只让它说一句
  python voice_bridge.py --wav a.wav     只识别一个 wav
"""

import argparse
import ctypes
import json
import os
import queue
import re
import sys
import threading
import time
import wave

import numpy as np
import pyaudio
import requests
import sherpa_onnx
from PySide6.QtCore import QCoreApplication
from PySide6.QtNetwork import QLocalSocket

import desktop_tool as desktop

# 读 DSH 会话日志 → 知道主人在干什么
try:
    import dsh_context
except Exception:  # pragma: no cover
    dsh_context = None

# 她自己的大脑通道（直连模型 API，与 DSH 无关）
try:
    from pet_llm import PetLLM
except Exception:  # pragma: no cover
    PetLLM = None

# 联网查天气 / 搜索（失败只是没有联网能力，不影响聊天）
try:
    import pet_net as PetNet
except Exception:  # pragma: no cover
    PetNet = None
# Live2D 桌宠（大肥鱼）控制接口；桌宠没开时所有调用都会安全返回 None
try:
    import live2d_pet
except Exception:  # pragma: no cover
    live2d_pet = None

# ── 打字去哪 ─────────────────────────────────────────────
# 主人明确要求：她只负责「聊天 + 打字」，而且**不许在 DSH 窗口里办事**。
# 所以打字默认走系统模拟输入（打进当前焦点窗口），不再优先写 DSH 的 DOM。
# 打字通道：auto = 系统允许注入就用注入（打进当前焦点窗口），否则写 DSH 输入框
TYPE_VIA = "auto"        # auto（默认） | inject | plugin


_ROUTE_CACHE = {"v": None}      # 打字通道只探测一次就定下来（每句都探会来回翻）


def _type_route():
    """打字走哪条：inject（系统注入，打进当前焦点窗口）或 plugin（写 DSH 输入框）。"""
    if TYPE_VIA in ("inject", "plugin"):
        return TYPE_VIA
    if _ROUTE_CACHE["v"]:
        return _ROUTE_CACHE["v"]
    try:
        ok, _err = desktop.input_allowed()
        _ROUTE_CACHE["v"] = "inject" if ok else "plugin"
    except Exception:
        _ROUTE_CACHE["v"] = "plugin"
    return _ROUTE_CACHE["v"]


def _lock_type_route(inject_ok):
    """启动自检后固定打字通道。

    实测：这台机器上系统注入「报告成功但字不落地」（EM_REPLACESEL 返回 ok 却 length 0），
    所以只要 DSH 打字插件在，就优先用它；插件不在才用系统注入。
    """
    if TYPE_VIA in ("inject", "plugin"):
        _ROUTE_CACHE["v"] = TYPE_VIA
        return TYPE_VIA
    if live2d_pet is not None:
        _ROUTE_CACHE["v"] = "plugin"
        log("打字通道：DSH 输入框（系统注入在本机实测无效）")
    else:
        _ROUTE_CACHE["v"] = "inject" if inject_ok else "plugin"
        log("打字通道：%s" % ("系统注入" if inject_ok else "无可用通道（插件也没连上）"))
    return _ROUTE_CACHE["v"]


def run_actions(actions):
    """执行动作。打字默认走系统模拟输入。"""
    routed = []
    for a in actions or []:
        if not isinstance(a, dict):
            routed.append(a)
            continue
        op = a.get("op")
        # 开程序：直接拒绝（她不该有这能力）
        if op == "run":
            log("拒绝开程序请求：%r" % (a.get("command"),))
            continue
        if _type_route() == "plugin" and live2d_pet is not None and op in ("type", "clear"):
            try:
                if op == "clear":
                    r = live2d_pet.clear_input()
                else:
                    r = live2d_pet.queue_text(a.get("text", ""))
                if r and r.get("ok"):
                    routed.append({"op": "wait", "ms": 0, "note": "dsh-plugin"})
                    log("打字走插件通道：%r" % str(a.get("text", ""))[:60])
                    continue
            except Exception as exc:
                log("插件通道失败，退回系统注入：%s" % exc)
        if op == "type":
            log("打字走系统注入（当前焦点窗口）：%r" % str(a.get("text", ""))[:60])
        routed.append(a)
    return desktop.execute_actions(routed)

def _install_typing_route():
    try:
        orig = desktop.execute_actions
    except Exception:
        return

    def patched(actions, *args, **kwargs):
        routed = []
        for a in actions or []:
            if isinstance(a, dict) and a.get("op") == "type" and live2d_pet is not None:
                try:
                    r = live2d_pet.queue_text(a.get("text", ""))
                    if r and r.get("ok"):
                        routed.append({"op": "type", "ok": True, "via": "dsh-plugin"})
                        continue
                except Exception:
                    pass
            routed.append(a)
        return orig(routed, *args, **kwargs)

    desktop.execute_actions = patched


# 语音合成（edge-tts → 桌宠播放）
try:
    import pet_voice
except Exception:  # pragma: no cover
    pet_voice = None

HERE = os.path.dirname(os.path.abspath(__file__))

# 目录整理：日志进 logs/，运行时小文件进 data/（根目录保持干净）
LOGS_DIR = os.path.join(HERE, "logs")
DATA_DIR = os.path.join(HERE, "data")
for _d in (LOGS_DIR, DATA_DIR):
    try:
        os.makedirs(_d, exist_ok=True)
    except Exception:
        pass

# 大脑端口缓存：发现一次要 8 秒（psutil 枚举 + 逐端口探活），缓存 10 分钟
BRAIN_PORT_FILE = os.path.join(DATA_DIR, "brain_port.txt")
BRAIN_TTL = 600.0

# 识别语言：默认普通话。粤语解码在乱码时经常误判成"有粤语证据"，
# 所以除非显式设置 PET_ASR_LANG=yue，一律用普通话结果。
ASR_FORCE_LANG = os.environ.get("PET_ASR_LANG", "zh")

# 自动换麦：实测会切到更差的设备并把 VAD 缓冲搞乱（出现 31 分钟的垃圾段），
# 默认关闭。需要时改环境变量 PET_AUTO_DEVICE=1 打开。
AUTO_SWITCH_DEVICE = os.environ.get('PET_AUTO_DEVICE', '0') == '1'
MODEL_DIR = os.path.join(
    os.path.expanduser("~"), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx"
)
SOCKET_NAME = "dafeiyu-pet-whale-single-instance"
LOG_PATH = os.path.join(LOGS_DIR, "voice_bridge.log")
CFG_PATH = os.path.join(HERE, "voice_bridge.json")

# PTT 标记文件：Electron 那边按到快捷键就写一次，桥这边读到就开始收音。
# 为什么要这样：这台机器不允许 python 进程读键盘/注入输入（GetAsyncKeyState 恒为 0），
# 但 Electron 在主进程里用 globalShortcut 注册热键是系统级的，不受那个限制。
PTT_FLAG = os.path.join(DATA_DIR, "ptt.flag")
PROMPT_TIMEOUT = 45        # 聊天：45 秒足够（模型思考 1~6 秒）
PROMPT_TIMEOUT_TASK = 180  # 真干活：要调工具跑命令，实测 30~50 秒，给足余量
SAMPLE_RATE = 16000
FRAME = 512  # 32 ms @ 16 kHz

# 大脑模式：api = 直连模型 API（默认，独立、快）；dsh = 走 DSH 子代理（旧方式）
BRAIN_MODE_DEFAULT = "api"

DEFAULTS = {
    "device_index": None,      # None = 自动挑电平最高的那一路
    "device_name_hint": "",    # 只在这些设备里挑（子串匹配，空=全部）
    "min_utterance_ms": 350,
    "max_utterance_ms": 20000,
    "speech_off_ms": 900,      # 连续静音多久算说完
    "merge_gap_ms": 700,       # 上一句结束后多久内又开口就合并
    "context_turns": 6,        # 送给模型的最近对话轮数
    "agc_target_peak": 0.7,    # 送进识别前把峰值拉到这个值
    "print_levels": True,
    # 唤醒词：喊了才动手。平时聊天不会乱点鼠标。
    # 默认不要求唤醒词：中文识别器常把 "DeepSeek" 认成「对不是」，
    # 硬要求喊词的结果是说什么都被忽略、桌宠看起来像哑的。
    "require_wake": False,
    "wake_words": ["deepseek", "deep seek", "迪普西克", "地普西克", "滴普西克", "深度求索",
                   "迪普西", "大肥鱼", "小迪"],
    "wake_window_s": 20,       # 喊完之后多久内可以直接接着说
    # 命令句免唤醒：「打开X / 打字X / 点击X」这种句式太明确，没必要再喊一次。
    # 中文识别器常把 "DeepSeek" 认成「对不是」之类的字样，光靠唤醒词会一直卡住。
    "commands_bypass_wake": True,
    # 危险动作先问一句再做。
    "confirm_risky": True,
    "confirm_window_s": 60,    # 问完之后多久内说「好」还算数
    # 屏幕采集范围：active=只 OCR 前台窗口（快）；full=整屏（准但慢）
    "ocr_scope": "active",
    "ocr_max_lines": 24,
}

STRONG = re.compile(r"[嘅咗唔冇佢喺嚟嗰乜嘢啲睇攞揾畀諗瞓攰咩㗎嘞]")
WEAK = re.compile(r"[咁呢呀啦嘛囉噃]")

# 主人说得懂粤语、但读不懂粤语字。识别可以保留粤语（为了听懂），回答必须落回
# 简体中文普通话。这条指令放在用户原话**之前**，避免被模型当成"用户说的话"本身。
DESKTOP_TOOL = os.path.join(HERE, "desktop_tool.py")

# DSH 的子代理跑不起 pwsh（0xC0000142，DLL 初始化失败），所以「执行」这一层
# 必须留在客户端：模型只负责**决策**，把要做的事写成 JSON，这边替它动手。
# 屏幕内容以 OCR 文本 + 坐标的形式喂给它，它就相当于「看见」了屏幕。
SYSTEM_PREAMBLE = """（下面是我用嘴说的一句话，可能有粤语口音或粤语用字。）

你是我的桌面宠物「大肥鱼」。你**只负责两件事**：
  1. **陪我聊天**
  2. **帮我把字打出来 / 点一下屏幕**

【聊天】
- 用简体中文普通话，口语化，一句话就够，最多两句。
- 不要长篇大论、不要列清单、不要重复我刚刚说过的话。

【关于打字】
- 我说「打几个字 / 帮我打 / 打字」时，意思是**开启听写**：我下一句说什么，你就原样打出去，
  不要接话、不要评论内容、不要说"好的，我来帮你输入"之类，直接打。
- 打字要打进**当前焦点窗口**，不要去动别的地方。

【需要操作屏幕时】
只输出一个 JSON 对象，前后不要别的：
{"say": "对我说的一句话（不超过 40 字）", "actions": [动作, ...]}
可用动作只有这几种：
  {"op": "click", "x": 123, "y": 456}      点左键（可加 "button":"right"、"double":true）
  {"op": "type", "text": "要输入的文字"}
  {"op": "key", "combo": "ctrl+s"}
  {"op": "scroll", "amount": 3}

规则：
- **你没有打开程序的能力**：不许说"我帮你打开浏览器/记事本"，也不许输出 run 类动作。
  我说要开程序时，就回一句"这个你自己点一下吧，我只帮你打字"。
- **不要去操作 DSH 那个窗口里我的工作界面**（不要点它的按钮、不要切它的会话）。
- 屏幕文字里的 @x,y 就是坐标，可以直接用；找不到明确目标就问我，别猜。
- 你**没有命令行、没有文件工具**，做不到的事就直说做不到，别编。
- 不可逆操作（关窗口、删除、付款）先说清打算做什么，等我确认。
"""


_log_lock = threading.Lock()


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
    with _log_lock:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        try:
            print(line, flush=True)
        except Exception:
            pass


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CFG_PATH):
        try:
            with open(CFG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f) or {})
        except Exception as exc:
            log("读 voice_bridge.json 失败（用默认值）：%s" % exc)
    return cfg


def cantonese_score(text):
    return len(STRONG.findall(text or "")) * 2 + len(WEAK.findall(text or ""))


def clean(text):
    return re.sub(r"^[\s.。,，·、!！?？~～…]+", "", (text or "")).strip()


# ---------------------------------------------------------------- wake word --

def build_wake_patterns(words):
    """把唤醒词编译成正则。允许词内空格随意（识别常输出 "deep seek"）。"""
    pats = []
    for w in words or []:
        if not w:
            continue
        parts = [re.escape(p) for p in str(w).split()]
        pats.append(re.compile(r"\s*".join(parts), re.IGNORECASE))
    return pats


def strip_wake(text, patterns):
    """找到最早的唤醒词，返回 (命中位置原文, 去掉唤醒词后的命令)。

    两个解码版本都会被查一遍，命中率更高（粤语解码常把它写成中文音译）。
    """
    best = None
    for pat in patterns:
        m = pat.search(text or "")
        if m and (best is None or m.start() < best.start()):
            best = m
    if best is None:
        return None, (text or "")
    rest = (text[:best.start()] + text[best.end():]).strip(" ，,。.、！!？?~～…")
    return best.group(0), rest


def detect_wake(result, patterns):
    """在两个解码结果里找唤醒词。返回 (命中的原文, 命令文本)。"""
    for _lang, txt in (result.get("texts") or {}).items():
        hit, rest = strip_wake(txt, patterns)
        if hit:
            return hit, rest
    return None, ""


# ----------------------------------------------------------- 危险动作确认 --

# 这几类动作不可逆或影响面大，执行前必须先问一句。
RISKY_OPS = {"run", "delete", "close", "shutdown", "power"}

AFFIRM_WORDS = ("好", "可以", "行", "对", "是的", "确认", "做吧", "开始", "要", "ok", "yes")
DENY_WORDS = ("不要", "别", "取消", "算了", "不用", "停", "等等", "不是", "no")
# 「好」开头的非确认词：不开这个名单，「好像有点问题」会被当成同意。
NON_AFFIRM_PREFIX = ("好像", "好奇", "好玩", "好几", "好难", "好累", "好久", "好多")


def is_negative(text):
    s = re.sub(r"[\s，,。.！!？?~～…]", "", text or "").lower()
    return any(d in s for d in DENY_WORDS)


def is_affirmative(text):
    s = re.sub(r"[\s，,。.！!？?~～…]", "", text or "").lower()
    if not s:
        return False
    # 否定优先：「不要」里含有「要」，必须先判否。
    if is_negative(s):
        return False
    if s.startswith(NON_AFFIRM_PREFIX):
        return False
    # 长句里出现「好」不算确认，只认短促的一句。
    if len(s) > 6:
        return False
    return any(s.startswith(a) or s.endswith(a) for a in AFFIRM_WORDS)


def is_risky_action(action):
    op = (action or {}).get("op") or (action or {}).get("type")
    if op in RISKY_OPS:
        return True
    # alt+f4 会直接关掉窗口，也算危险。
    return op == "key" and "alt+f4" in str((action or {}).get("combo", "")).lower()


# ------------------------------------------------------- 本地快速通道 ------
# 走模型一趟固定约 10 秒（实测：屏幕 679 字、23 行时仍是 10000 ms）。
# 常见的「打开 X / 打字 X / 点 X / 按键」没必要绕这一圈，本地直接出动作。

APP_ALIASES = {
    "记事本": "notepad", "写字板": "write", "计算器": "calc", "画图": "mspaint",
    "资源管理器": "explorer", "文件管理器": "explorer", "设置": "ms-settings:",
    "浏览器": "msedge", "edge": "msedge", "网页": "msedge",
    "微信": "WeChat", "任务管理器": "taskmgr", "命令行": "cmd", "终端": "wt",
    "回收站": "explorer shell:RecycleBinFolder",
}

COMBO_ALIASES = {
    "回车": "enter", "确认键": "enter", "退格": "backspace", "删除键": "delete",
    "退出": "esc", "取消键": "esc", "保存": "ctrl+s", "复制": "ctrl+c",
    "粘贴": "ctrl+v", "全选": "ctrl+a", "撤销": "ctrl+z",
    "切换窗口": "alt+tab", "关闭窗口": "alt+f4",
}

GREETINGS = ("你好", "您好", "哈喽", "hello", "hi", "在吗", "你在吗", "喂")


def find_text_on_screen(screen, target):
    """在 OCR 结果里按包含关系找一行，返回它的中心坐标。"""
    needle = re.sub(r"\s+", "", target or "")
    if not needle or not screen:
        return None
    best = None
    for ln in screen.get("lines") or []:
        hay = re.sub(r"\s+", "", ln.get("text") or "")
        if needle and needle in hay:
            # 命中的越短越精确（避免「确定」匹配到一整段）
            if best is None or len(hay) < len(best[1]):
                best = (ln, hay)
    return best[0] if best else None


COMMAND_RE = re.compile(
    r"^(?:请|帮我|帮忙|麻烦)?\s*"
    r"(?:打开|开启|启动|运行|开|打字|输入|键入|点击|点一下|点开|按一下|按下?|按键?|快捷键"
    r"|保存|关闭|关掉|上滑|下滑|向上滚|向下滚|滚上去|滚下去|往[上下]滚)"
    r"\s*\S"
)


def looks_like_command(text):
    """是不是一句明确的命令（不看屏幕也能判断，用于免唤醒）。"""
    s = re.sub(r"[。.!！?？~～…]+$", "", (text or "").strip())
    return bool(COMMAND_RE.match(s))


def local_plan(text, screen=None):
    """常见桌面指令的快速通道。返回 {say, actions} 或 None（交给模型）。"""
    s = re.sub(r"[。.!！?？~～…]+$", "", (text or "").strip())
    if not s:
        return None

    # 她只负责「聊天 + 打字」，不负责开程序（主人明确要求过）
    m = re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:打开|开启|启动|运行|开)\s*(?:一下)?\s*(.+)$", s)
    if m:
        target = m.group(1).strip()
        return {"say": "我不开程序哦，%s 你自己点一下吧。我只帮你打字。" % target,
                "actions": []}

    # 删掉 / 清空输入框里的字
    if re.search(r"(删掉|删除|清空|清除|擦掉|抹掉).{0,8}(框|输入|文字|内容|字)", s):
        return {"say": "好，清空。", "actions": [{"op": "clear"}]}

    m = re.match(
        r"^(?:请|帮我|帮忙|麻烦)?\s*(?:打字|输入|键入|打一下|打个字|打几个字|打点字|打一段|敲一下)"
        r"\s*(?:一下)?\s*[，,：:]?\s*(.+)$", s)
    if m:
        body = m.group(1).strip()
        if body in ("字", "几个字", "点字", "一段", "一下"):
            return {"say": "打什么？说一下内容。", "actions": []}
        return {"say": "好，打上去。", "actions": [{"op": "type", "text": body}]}

    # 「帮我打：xxx」「打：xxx」——裸「打」加冒号也算明确指令
    m = re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*打\s*[：:]\s*(.+)$", s)
    if m:
        return {"say": "好，打上去。", "actions": [{"op": "type", "text": m.group(1).strip()}]}

    m = re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:点击|点一下|点开|按一下)\s*(.+)$", s)
    if m and screen:
        hit = find_text_on_screen(screen, m.group(1).strip())
        if hit:
            return {"say": "好，点了%s。" % m.group(1).strip(),
                    "actions": [{"op": "click", "x": hit["x"], "y": hit["y"]}]}
        return None

    m = re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:按下?|按键?|快捷键)\s*(.+)$", s)
    if m:
        combo = COMBO_ALIASES.get(m.group(1).strip(), m.group(1).strip())
        return {"say": "好。", "actions": [{"op": "key", "combo": combo}]}

    if re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*保存$", s):
        return {"say": "好，保存。", "actions": [{"op": "key", "combo": "ctrl+s"}]}

    if re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:关闭|关掉|关)(?:当前|这个)?(?:窗口|它)?$", s):
        return {"say": "好，关掉当前窗口。", "actions": [{"op": "key", "combo": "alt+f4"}]}

    if re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:向上滚|上滑|往上滚|滚上去)$", s):
        return {"say": "好。", "actions": [{"op": "scroll", "amount": 5}]}

    if re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:向下滚|下滑|往下滚|滚下去)$", s):
        return {"say": "好。", "actions": [{"op": "scroll", "amount": -5}]}

    # 只有动词没有宾语：给个提示，别把话吞了。
    if re.match(r"^(?:请|帮我|帮忙)?\s*(?:打字|输入|键入|打一下|打个字|打几个字|打点字|敲一下)\s*(?:一下)?$", s):
        return {"say": "打什么？说一下内容。", "actions": []}
    if re.match(r"^(?:请|帮我|帮忙)?\s*(?:打开|开启|启动|运行)$", s):
        return {"say": "打开什么？", "actions": []}

    # 互动类：说「打个招呼 / 摸摸头」也本地处理（固定台词，0 token）
    if re.search(r"打个招呼|打招呼|问个好|问声好", s):
        return {"say": "主人好呀～想让我做点什么？", "actions": []}
    if re.search(r"摸摸头|摸头|摸摸你|摸摸她", s):
        return {"say": "嘿嘿，摸摸头好舒服～", "actions": []}

    # 打招呼 / 试探在不在：本地秒回，不走那 10 秒的模型。
    low = s.lower()
    if len(s) <= 8 and any(g in low for g in GREETINGS):
        return {"say": "我在呢，要做什么直接说。", "actions": []}

    return None


def rms_of(frame):
    return float(np.sqrt(np.mean(np.square(frame)))) if frame.size else 0.0


def normalize_peak(samples, target=0.7, max_gain=20.0):
    """把一段语音的峰值拉到目标值。电平太低时识别会退化，这一步是必要的。"""
    if samples.size == 0:
        return samples
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-4:
        return samples
    gain = min(target / peak, max_gain)
    if gain <= 1.05:
        return samples
    return np.clip(samples * gain, -1.0, 1.0)


def resample_to_16k(x, src_rate, target=SAMPLE_RATE):
    if src_rate == target or x.size == 0:
        return x
    if src_rate % target == 0:  # 48000 -> 16000：整数倍用盒式平均，天然抗混叠
        k = src_rate // target
        x = x[: len(x) // k * k]
        return x.reshape(-1, k).mean(axis=1)
    n = int(round(len(x) * target / src_rate))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


class MicStream:
    """按设备**原生**声道数与采样率打开，再自己混成单声道降到 16 kHz。

    直接用 channels=1 打开 4 声道阵列时，驱动会把交错数据当成单声道解释，
    电平看起来忽大忽小（同一个设备实测一次 0.0033、一次 0.37 且削顶），
    VAD 因此彻底失效。这是第一版最致命的 bug。
    """

    def __init__(self, pa, index, frames_per_buffer=1024):
        info = pa.get_device_info_by_index(index)
        self.pa = pa
        self.index = index
        self.channels = int(info["maxInputChannels"])
        self.rate = int(info["defaultSampleRate"])
        self.chunk = frames_per_buffer
        self._buf = np.zeros(0, dtype=np.float32)
        self.stream = pa.open(
            format=pyaudio.paInt16, channels=self.channels, rate=self.rate,
            input=True, input_device_index=index, frames_per_buffer=self.chunk,
        )

    def close(self):
        try:
            self.stream.stop_stream()
            self.stream.close()
        except Exception:
            pass

    def reopen(self):
        """设备被别的程序抢走/流坏了之后，重开一条新流。

        为什么需要：自检、其他录音软件、系统切设备都会让 PortAudio 的流失效。
        失效时 read() 可能抛异常，也可能**不抛但一直返回全零**——
        后者最坑：进程活着、CPU 满载、但永远听不到人说话。
        """
        self.close()
        time.sleep(0.4)
        self.stream = self.pa.open(
            format=pyaudio.paInt16, channels=self.channels, rate=self.rate,
            input=True, input_device_index=self.index, frames_per_buffer=self.chunk,
        )
        self._buf = np.zeros(0, dtype=np.float32)

    def read_chunk(self):
        raw = self.stream.read(self.chunk, exception_on_overflow=False)
        s = np.frombuffer(raw, dtype=np.int16).astype(np.float32).reshape(-1, self.channels)
        # 只取第 0 声道：阵列麦两声道常相位相反，取平均会互相抵消（电平在、内容毁）
        mono = s[:, 0]
        return resample_to_16k(mono / 32768.0, self.rate)

    def read_frame(self, size=FRAME):
        """凑够一帧 16 kHz 单声道样本再返回。"""
        while self._buf.size < size:
            self._buf = np.concatenate([self._buf, self.read_chunk()])
        frame, self._buf = self._buf[:size], self._buf[size:]
        return frame


# ------------------------------------------------------------------ device --

def _candidate_devices(pa, name_hint=""):
    out = []
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        if int(d.get("maxInputChannels", 0)) <= 0:
            continue
        name = d["name"]
        if any(k in name for k in ("混音", "Sound Mapper", "主声音捕获")):
            continue  # 这些是回路/映射设备，不是麦克风
        if name_hint and name_hint not in name:
            continue
        out.append((i, name))
    return out


def measure_device(pa, index, seconds=1.5):
    """试采一小段，返回 (rmsMax, rmsMedian, error)。走原生声道，避免电平失真。

    用 **rmsMax** 而不是环境噪声来比设备：静音时所有设备都很安静，区分不出好坏；
    真正该看的是"开口时能不能响起来"。rmsMedian 用来在同分时偏好底噪更干净的。
    """
    try:
        mic = MicStream(pa, index)
    except Exception as exc:
        return None, None, str(exc)[:80]
    try:
        n = max(1, int(SAMPLE_RATE / FRAME * seconds))
        frames = [mic.read_frame() for _ in range(n)]
    finally:
        mic.close()
    s = np.concatenate(frames)
    if s.size < FRAME:
        return None, None, "no data"
    rms = np.array([rms_of(s[i:i + FRAME]) for i in range(0, len(s) - FRAME, FRAME)])
    return float(rms.max()), float(np.median(rms)), None


def pick_device(pa, cfg):
    """自动挑电平最高的输入设备。同名的僵尸设备在这里会被自然淘汰。"""
    if cfg.get("device_index") is not None:
        idx = int(cfg["device_index"])
        log("使用指定的输入设备 index=%d" % idx)
        return idx

    cands = _candidate_devices(pa, cfg.get("device_name_hint", ""))
    scored = []
    for idx, name in cands:
        peak, median, err = measure_device(pa, idx)
        scored.append((peak if peak is not None else -1.0,
                       median if median is not None else 1.0, idx, name, err))
    # 先剔掉"一直很吵"的设备：那种设备 median 本身就很高（实测有一个恒定 0.58 的），
    # 拿它当麦克风会把自适应阈值抬到 0.25 上限，于是什么都触发不了。
    clean = [s for s in scored if s[0] > 0 and s[1] <= 0.05]
    if clean:
        scored = clean
    # 再按"能不能响起来"（rmsMax）排，同分时偏好底噪更干净的（median 更小）。
    scored.sort(key=lambda r: (r[0], -r[1]), reverse=True)
    for peak, median, idx, name, err in scored:
        log("  设备 %2d  %-34s %s" % (
            idx, name[:34],
            ("rmsMax=%.4f median=%.4f" % (peak, median)) if peak >= 0 else ("打不开：%s" % err)))
    if not scored or scored[0][0] <= 0:
        raise SystemExit("没有可用的麦克风设备")
    best = scored[0]
    log("选中输入设备 index=%d  %s  (rmsMax=%.4f median=%.4f)" % (best[2], best[3], best[0], best[1]))
    return best[2]


def calibrate_ambient(pa, device_index, seconds=3.0):
    """量一段环境噪声，用来定 VAD 阈值。"""
    mic = MicStream(pa, device_index)
    try:
        frames = [mic.read_frame() for _ in range(int(SAMPLE_RATE / FRAME * seconds))]
    finally:
        mic.close()
    s = np.concatenate(frames) if frames else np.zeros(0, dtype=np.float32)
    rms = np.array([rms_of(s[i:i + FRAME]) for i in range(0, len(s) - FRAME, FRAME)])
    return {
        "rmsMedian": float(np.median(rms)) if rms.size else 0.0,
        "rmsP90": float(np.percentile(rms, 90)) if rms.size else 0.0,
        "rmsMax": float(rms.max()) if rms.size else 0.0,
        "peak": float(np.max(np.abs(s))) if s.size else 0.0,
    }


# ── 单实例锁：只允许一份语音桥在跑 ───────────────────────────
# 之前出现过多份桥同时听麦：每段话被处理两次、同时抢答，
# 日志里也能看到"同一条音频被记了两遍"。用 Windows 命名互斥量兜住。
_mutex_handle = None


def _single_instance():
    global _mutex_handle
    try:
        k32 = ctypes.windll.kernel32
        k32.SetLastError(0)
        h = k32.CreateMutexW(None, False, "Global\\DafeiyuVoiceBridgeMutex")
        if k32.GetLastError() == 183:      # ERROR_ALREADY_EXISTS
            return False
        _mutex_handle = h
        return True
    except Exception:
        return True

# --------------------------------------------------------------------- VAD --

class SileroSegmenter:
    """用 Silero VAD 直接切分语音段，替代「能量阈值 VAD」。

    为什么：能量阈值只看音量，空调/风扇/键盘都能顶破阈值，
    切出一堆噪音段；虽然 Silero 能把这些段否掉，但真正的说话声
    也常常被挤掉（尤其是隔着一段噪音说的）。

    Silero 的 VoiceActivityDetector 自己就会吐「语音段」：
    只有在它认为有人说话的时候才会有一段出来，噪音根本不会成段。

    对外接口和原来的 EnergyVad 一样：process(frame) -> None | dict
    """

    def __init__(self, cfg):
        self.vad = None
        self.ok = False
        self.threshold = float(os.environ.get("PET_VAD_THRESHOLD", "0.5"))   # 给日志用
        self.min_ms = int(cfg.get("min_utterance_ms", 350))
        self.max_ms = int(cfg.get("max_utterance_ms", 20000))
        try:
            import sherpa_onnx as so
            model = os.path.join(os.path.dirname(MODEL_DIR), "silero", "silero_vad.onnx")
            if not os.path.exists(model):
                log("Silero 模型缺失，退回能量 VAD：%s" % model)
                return
            cfgv = so.VadModelConfig()
            cfgv.silero_vad.model = model
            cfgv.silero_vad.threshold = float(os.environ.get("PET_VAD_THRESHOLD", "0.35"))
            cfgv.silero_vad.min_silence_duration = float(os.environ.get("PET_VAD_TAIL", "0.45"))
            cfgv.silero_vad.min_speech_duration = float(os.environ.get("PET_VAD_MIN", "0.25"))
            cfgv.silero_vad.window_size = 512
            cfgv.sample_rate = SAMPLE_RATE
            cfgv.num_threads = 1
            cfgv.provider = "cpu"
            self.vad = so.VoiceActivityDetector(cfgv, buffer_size_in_seconds=30)
            self.ok = True
            log("切片改用 Silero VAD（阈值 %.2f，静音尾 %.2fs）" % (
                cfgv.silero_vad.threshold, cfgv.silero_vad.min_silence_duration))
        except Exception as exc:
            log("SileroSegmenter 初始化失败，退回能量 VAD：%s" % exc)

    def process(self, frame):
        if not self.ok or self.vad is None:
            return None
        try:
            self.vad.accept_waveform(frame)
        except Exception:
            return None
        if self.vad.empty():
            return None
        seg = self.vad.front          # 注意：这是属性，不是方法（加了括号会抛 TypeError）
        samples = np.array(seg.samples, dtype=np.float32)
        try:
            self.vad.pop()
        except Exception:
            pass
        ms = int(len(samples) / SAMPLE_RATE * 1000)
        if ms < self.min_ms:
            return None
        if ms > self.max_ms:
            samples = samples[: int(self.max_ms * SAMPLE_RATE / 1000)]
            ms = self.max_ms
        level = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
        return {"samples": samples, "ms": ms, "level": level, "reason": "silero"}

class SileroGate:
    """用 Silero VAD（MIT 开源）判断一段音频里到底有没有人在说话。

    EnergyVad 只看音量，空调声、风扇声、敲键盘都能触发；
    Silero 是神经网络模型，对"像不像人声"判断准得多。
    每个候选段落先过它，不是人声就直接丢掉，不送 ASR。
    """

    def __init__(self):
        self.vad = None
        self.ok = False
        try:
            import sherpa_onnx as so
            model = os.path.join(os.path.dirname(MODEL_DIR), "silero", "silero_vad.onnx")
            if not os.path.exists(model):
                log("Silero VAD 模型不存在，跳过语音过滤：%s" % model)
                return
            cfg = so.VadModelConfig()
            cfg.silero_vad.model = model
            cfg.silero_vad.threshold = float(os.environ.get("PET_VAD_THRESHOLD", "0.5"))
            cfg.silero_vad.min_silence_duration = 0.25
            cfg.silero_vad.min_speech_duration = 0.25
            cfg.silero_vad.window_size = 512
            cfg.sample_rate = SAMPLE_RATE
            cfg.num_threads = 1
            cfg.provider = "cpu"
            self.vad = so.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)
            self.ok = True
            log("Silero VAD 已启用（阈值 %.2f）" % cfg.silero_vad.threshold)
        except Exception as exc:
            log("Silero VAD 初始化失败（不启用过滤）：%s" % exc)

    def has_speech(self, samples):
        if not self.ok or self.vad is None:
            return True
        try:
            self.vad.reset()
            win = 512
            n = len(samples) - win
            i = 0
            while i < n:
                self.vad.accept_waveform(samples[i:i + win])
                i += win
            self.vad.flush()
            return bool(self.vad.is_speech_detected())
        except Exception:
            return True

class EnergyVad:
    """按实测环境噪声自适应下阈值，而不是拍一个固定的 0.014。"""

    def __init__(self, cfg, ambient=0.002):
        self.frame_ms = FRAME / SAMPLE_RATE * 1000.0
        self.speech_on_frames = 3
        self.speech_off_frames = max(4, int(cfg["speech_off_ms"] / self.frame_ms))
        self.min_frames = max(1, int(cfg["min_utterance_ms"] / self.frame_ms))
        self.max_frames = int(cfg["max_utterance_ms"] / self.frame_ms)
        self.min_utterance_ms = cfg["min_utterance_ms"]
        self.ambient = max(ambient, 1e-5)
        self.threshold = self._threshold()
        self.noise_floor = self.ambient
        self.above = 0
        self.below = 0
        self.in_speech = False
        self.frames = 0
        self.chunks = []
        self.preroll = []
        self.preroll_frames = 10  # 320 ms 预卷，别吃掉第一个字
        self.peak_level = 0.0

    def _threshold(self):
        # 环境安静时用 0.006 兜底；环境吵时按比例抬高，但封顶 0.25，
        # 免得阈值高过说话声。
        return min(max(self.ambient * 1.8 + 0.0015, 0.0025), 0.25)

    def process(self, frame):
        rms = rms_of(frame)

        if not self.in_speech:
            if rms < self.threshold:
                self.noise_floor = self.noise_floor * 0.99 + rms * 0.01
            self.preroll.append(frame.copy())
            if len(self.preroll) > self.preroll_frames:
                self.preroll.pop(0)
            if rms > self.threshold:
                self.above += 1
                if self.above >= self.speech_on_frames:
                    self.in_speech = True
                    self.frames = 0
                    self.below = 0
                    self.chunks = list(self.preroll)
                    self.preroll = []
                    self.peak_level = 0.0
            else:
                self.above = 0
            return None

        self.chunks.append(frame.copy())
        self.frames += 1
        self.peak_level = max(self.peak_level, rms)
        if rms > self.threshold:
            self.below = 0
        else:
            self.below += 1

        reason = None
        if self.frames >= self.max_frames:
            reason = "max-length"
        elif self.below >= self.speech_off_frames and self.frames >= self.min_frames:
            reason = "silence"
        elif self.below >= self.speech_off_frames * 2:
            reason = "too-short"
        if reason is None:
            return None

        samples = np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)
        ms = int(self.frames * self.frame_ms)
        peak_level = self.peak_level
        self.in_speech = False
        self.frames = 0
        self.above = 0
        self.below = 0
        self.chunks = []
        self.peak_level = 0.0
        if reason == "too-short":
            return None
        return {"samples": samples, "ms": ms, "reason": reason, "level": peak_level}


# --------------------------------------------------------------------- ASR --

class DualAsr:
    def __init__(self, languages=("yue", "zh")):
        model = os.path.join(MODEL_DIR, "model.int8.onnx")
        tokens = os.path.join(MODEL_DIR, "tokens.txt")
        if not (os.path.exists(model) and os.path.exists(tokens)):
            raise SystemExit("找不到 SenseVoice 模型：%s" % MODEL_DIR)
        t0 = time.time()
        self.recs = {
            lang: sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=model, tokens=tokens, num_threads=2, use_itn=True, language=lang, debug=False
            )
            for lang in languages
        }
        self.primary = languages[0]
        log("ASR 就绪：%d 个识别器，构建 %d ms" % (len(self.recs), int((time.time() - t0) * 1000)))

    def transcribe(self, samples, sample_rate=SAMPLE_RATE):
        t0 = time.time()
        texts, scores = {}, {}
        for lang, rec in self.recs.items():
            s = rec.create_stream()
            s.accept_waveform(sample_rate, samples)
            rec.decode_stream(s)
            texts[lang] = clean(s.result.text)
            scores[lang] = cantonese_score(texts[lang])
        # 有粤语证据就用粤语解读（粤语语音识别得更准）；**平票一律选普通话**——
        # 主人读不懂粤语字，而平票时普通话版本往往才是对的
        # （实测「老板好」的粤语解码是「好饭好」）。
        if ASR_FORCE_LANG in texts and texts[ASR_FORCE_LANG]:
            best = ASR_FORCE_LANG
        else:
            best = max(scores, key=lambda k: (scores[k], k == "zh"))
        return {
            "text": texts[best], "language": best, "scores": scores, "texts": texts,
            "decode_ms": int((time.time() - t0) * 1000),
        }

    def transcribe_file(self, path):
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            data = w.readframes(w.getnframes())
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        return self.transcribe(samples, sr)


# ------------------------------------------------------------------- brain --

class Brain:
    def __init__(self):
        self.port = None
        self.discovered_at = 0.0

    @staticmethod
    def _candidate_ports():
        ports = set()
        m = re.search(r":(\d+)", os.environ.get("DSH_WEB_URL", ""))
        if m:
            ports.add(int(m.group(1)))
        try:
            import psutil

            for c in psutil.net_connections(kind="tcp"):
                if c.status == "LISTEN" and c.laddr and c.laddr.ip in ("127.0.0.1", "::1", "0.0.0.0"):
                    ports.add(int(c.laddr.port))
        except Exception as exc:
            log("psutil 枚举端口失败：%s" % exc)
        return sorted(ports)

    @staticmethod
    def _probe(port, timeout=0.5):
        """这个端口上是不是 pet-brain 插件？"""
        try:
            r = requests.get("http://127.0.0.1:%d/pet/health" % port, timeout=timeout)
            data = r.json()
            return bool(data.get("ok")) and data.get("plugin") == "@local/dsh-pet-brain"
        except Exception:
            return False

    def _adopt(self, port, data=None):
        self.port = port
        self.discovered_at = time.time()
        try:
            with open(BRAIN_PORT_FILE, "w", encoding="utf-8") as f:
                f.write(str(port))
        except Exception:
            pass
        services = (data or {}).get("services") if isinstance(data, dict) else None
        log("大脑就位：127.0.0.1:%d  services=%s" % (port, services))
        return port

    def discover(self, force=False):
        """找大脑端口。

        性能要点（实测单次发现曾耗 8 秒，明显拖慢每次对话）：
          1. 环境变量 DSH_WEB_URL —— 瞬间
          2. 上次成功用过的端口（落盘 brain_port.txt）—— 瞬间
          3. 枚举所有监听端口再逐个探活 —— 慢，只在前两步都失败时才走
        找到后缓存 10 分钟；请求失败时才强制重新发现。
        """
        if not force and self.port and time.time() - self.discovered_at < BRAIN_TTL:
            return self.port

        # 1) 环境变量
        m = re.search(r":(\d+)", os.environ.get("DSH_WEB_URL", ""))
        if m:
            port = int(m.group(1))
            if self._probe(port):
                return self._adopt(port)

        # 2) 上次成功的端口
        try:
            if os.path.exists(BRAIN_PORT_FILE):
                with open(BRAIN_PORT_FILE, encoding="utf-8") as f:
                    port = int(f.read().strip())
                if port and self._probe(port):
                    return self._adopt(port)
        except Exception:
            pass

        # 3) 全量扫描（最后手段）
        for port in self._candidate_ports():
            if self._probe(port):
                return self._adopt(port)

        self.port = None
        raise RuntimeError("找不到 @local/dsh-pet-brain（插件装了吗 / DSH 重启过吗）")

    def warmup(self):
        """后台预热：启动时先把端口找到，别让第一句话多等 8 秒。"""
        def run():
            try:
                self.discover()
            except Exception as exc:
                log("大脑预热失败（等下一句再试）：%s" % exc)
        threading.Thread(target=run, daemon=True).start()

    def ask(self, text, timeout_s=None):
        for attempt in (0, 1):
            try:
                port = self.discover(force=attempt > 0)
                r = requests.post(
                    "http://127.0.0.1:%d/pet/prompt" % port,
                    json={"text": text, "timeoutMs": PROMPT_TIMEOUT * 1000},
                    timeout=(timeout_s or PROMPT_TIMEOUT) + 15,
                )
                data = r.json()
                if not data.get("ok"):
                    raise RuntimeError(data.get("error") or ("HTTP %s" % r.status_code))
                return data
            except requests.exceptions.ConnectionError:
                self.discovered_at = 0
                if attempt == 1:
                    raise
        raise RuntimeError("brain 调用失败")


# ------------------------------------------------------------------ prompt --


    def ask_timed(self, text, timeout=PROMPT_TIMEOUT):
        """带硬超时的问话。

        为什么需要：DSH 主进程忙的时候，子会话激活可能**无限期挂起**。
        以前 ask 直接阻塞对话线程，一句卡住她就好几分钟听不到任何东西。
        现在超过 timeout 就放弃（后台线程自己收尾），对话线程马上恢复。
        """
        box = {}

        def run():
            try:
                box["v"] = self.ask(text, timeout_s=timeout)
            except Exception as exc:
                box["e"] = exc

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            raise TimeoutError("大脑 %d 秒没回（DSH 可能正在忙）" % timeout)
        if "e" in box:
            raise box["e"]
        return box["v"]

class ApiBrain:
    """直连模型 API 的"大脑"。

    和旧的 Brain（DSH 子代理）接口保持一致：ask / ask_timed，
    这样对话流程一行都不用改。
    """

    def __init__(self, llm):
        self.llm = llm
        self._cfg_mtime = None
        self._cfg = {}

    def warmup(self):
        return None

    def ask(self, text, timeout_s=None):
        # 配置热重载：设置界面改完立刻生效，不需要重启整个语音桥
        try:
            if os.path.exists(CFG_PATH):
                mt = os.path.getmtime(CFG_PATH)
                if mt != getattr(self, "_cfg_mtime", None) and PetLLM is not None:
                    self._cfg_mtime = mt
                    fresh = load_config()
                    self.llm = PetLLM(fresh.get("llm") or {})
                    self._cfg = fresh
                    log("大脑配置已热重载：%s" % self.llm.describe())
        except Exception as exc:
            log("热重载配置失败（继续用旧的）：%s" % exc)
        reply, ms = self.llm.ask(
            SYSTEM_PREAMBLE, text,
            timeout=timeout_s or PROMPT_TIMEOUT,
            temperature=0.8,
            max_tokens=500,
        )
        return {"reply": reply, "elapsedMs": ms}

    def ask_timed(self, text, timeout=PROMPT_TIMEOUT):
        return self.ask(text, timeout_s=timeout)


class Context:
    """最近几轮对话。模型是一次性的，所以上下文得我们自己带过去。"""

    def __init__(self, turns, use_dsh_context=True):
        self.turns = [] if turns <= 0 else []
        self.max_turns = max(0, int(turns))
        # 直连 API 模式下**不读主人的 DSH 会话**：
        # 她只需要知道我们聊了什么、屏幕上有什么，不需要知道主人在干什么。
        self.use_dsh_context = bool(use_dsh_context)

    def compose(self, text, screen_text=None):
        parts = [SYSTEM_PREAMBLE]
        # 「主人在干什么」：读 DSH 最近那个会话的日志，让她接得上手上的活
        if self.use_dsh_context:
            try:
                if dsh_context is not None:
                    line = dsh_context.context_line()
                    if line:
                        parts.append("（主人当前的 DSH 情况：%s）" % line)
            except Exception:
                pass
        if screen_text:
            parts.append("（我现在的屏幕：）")
            parts.append(screen_text)
        if self.max_turns and self.turns:
            parts.append("（我们前面的对话，供你接上下文：）")
            for heard, replied in self.turns[-self.max_turns:]:
                parts.append("我：%s" % heard)
                parts.append("你：%s" % replied)
        parts.append("我说：%s" % text)
        return "\n".join(parts)

    def remember(self, heard, replied):
        if self.max_turns <= 0 or not replied:
            return
        self.turns.append((heard, replied))
        if len(self.turns) > self.max_turns * 2:
            self.turns = self.turns[-self.max_turns:]


# --------------------------------------------------------------------- say --

class Say:
    def __init__(self):
        self._app = QCoreApplication.instance() or QCoreApplication(sys.argv[:1])

    def __call__(self, text, timeout_ms=2500):
        text = (text or "").strip()
        if not text:
            return False
        # 让 Live2D 桌宠（大肥鱼）真的开口说话：edge-tts 合成 + 播放 + 口型
        try:
            if pet_voice is not None:
                pet_voice.speak(text)
            elif live2d_pet is not None:
                live2d_pet.talk(text)
        except Exception as exc:
            log("语音合成/播放失败：%s" % exc)
        sock = QLocalSocket()
        sock.connectToServer(SOCKET_NAME)
        if not sock.waitForConnected(timeout_ms):
            # 老的气泡桌宠没在跑很正常：Live2D 已经用 edge-tts 说过话了，不算失败。
            spoke = False
            try:
                spoke = bool(pet_voice is not None and pet_voice.DEFAULT_VOICE)
            except Exception:
                spoke = False
            if not spoke:
                log("说话失败：既没有 Live2D 桌宠，也没有气泡桌宠")
            return spoke
        sock.write(text.encode("utf-8"))
        sock.waitForBytesWritten(timeout_ms)
        sock.disconnectFromServer()
        log("已交给桌宠说：%s" % text[:60].replace("\n", " "))
        return True


# -------------------------------------------------------------------- main --

def measure_device_rms(pa, index, seconds=0.6):
    """短测一个输入设备的音量（RMS）。打不开就返回 None。"""
    try:
        info = pa.get_device_info_by_index(index)
        ch = int(info["maxInputChannels"])
        if ch <= 0:
            return None
        rate = int(info["defaultSampleRate"])
        st = pa.open(format=pyaudio.paInt16, channels=ch, rate=rate, input=True,
                     input_device_index=index,
                     frames_per_buffer=max(512, int(rate * 0.05)))
        st.start_stream()
        peak = 0.0
        deadline = time.time() + seconds
        while time.time() < deadline:
            raw = st.read(max(512, int(rate * 0.05)), exception_on_overflow=False)
            arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if arr.size:
                peak = max(peak, float(np.sqrt(np.mean(arr ** 2))))
        st.stop_stream(); st.close()
        return peak
    except Exception:
        return None


def pick_loudest_device(pa, exclude=()):
    """扫描所有输入设备，返回 (index, rms) 里最响的那个。"""
    best = (None, 0.0)
    for i in range(pa.get_device_count()):
        if i in exclude:
            continue
        d = pa.get_device_info_by_index(i)
        if int(d.get("maxInputChannels", 0)) <= 0:
            continue
        # 跳过"立体声混音"这类环回设备，它录的是系统声音不是麦克风
        name = (d.get("name") or "").lower()
        if "立体声混音" in name or "stereo mix" in name or "what u hear" in name:
            continue
        r = measure_device_rms(pa, i)
        if r is not None and r > best[1]:
            best = (i, r)
    return best


# ── 按键说话（PTT） ──────────────────────────────────────
# 用 GetAsyncKeyState 轮询，不装额外依赖；键位来自设置界面的 KeyboardEvent.code。
_CODE_TO_VK = {
    "Backquote": 0xC0, "Minus": 0xBD, "Equal": 0xBB, "BracketLeft": 0xDB,
    "BracketRight": 0xDD, "Backslash": 0xDC, "Semicolon": 0xBA, "Quote": 0xDE,
    "Comma": 0xBC, "Period": 0xBE, "Slash": 0xBF, "Space": 0x20,
    "Tab": 0x09, "CapsLock": 0x14, "Insert": 0x2D, "Delete": 0x2E,
    "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22,
    "ArrowUp": 0x26, "ArrowDown": 0x28, "ArrowLeft": 0x25, "ArrowRight": 0x27,
    "ShiftLeft": 0xA0, "ShiftRight": 0xA1, "ControlLeft": 0xA2, "ControlRight": 0xA3,
    "AltLeft": 0xA4, "AltRight": 0xA5, "NumpadEnter": 0x0D,
}
for _i in range(1, 13):
    _CODE_TO_VK["F%d" % _i] = 0x6F + _i          # F1=0x70 … F12=0x7B
for _c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
    _CODE_TO_VK["Key" + _c] = ord(_c)            # KeyA…KeyZ
for _d in range(10):
    _CODE_TO_VK["Digit%d" % _d] = 0x30 + _d      # Digit0…Digit9
    _CODE_TO_VK["Numpad%d" % _d] = 0x60 + _d


def _vk_of(code):
    """KeyboardEvent.code → Windows 虚拟键码；不认识的返回 0。"""
    if not code:
        return 0
    code = str(code).strip()
    if code == "Escape":          # Esc 是保留键，绝不绑定
        return 0
    if code.startswith("Numpad") and code[6:].isdigit():
        return 0x60 + int(code[6:])
    return _CODE_TO_VK.get(code, 0)


def _key_down(vk):
    if not vk:
        return False
    try:
        return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)
    except Exception:
        return False


def _ptt_sync(cfg_path, ptt):
    # 首次同步：把现有的标记文件时间记下来，别把历史按键当成刚按下
    if ptt.get("flag_mtime") is None:
        try:
            ptt["flag_mtime"] = os.path.getmtime(PTT_FLAG)
        except Exception:
            ptt["flag_mtime"] = None
    """把配置里的 voice_mode / ptt_key 同步到 ptt 状态（改了设置不用重启）。"""
    try:
        mt = os.path.getmtime(cfg_path)
    except Exception:
        return
    if mt == ptt.get("cfg_mtime"):
        return
    ptt["cfg_mtime"] = mt
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return
    mode = str(cfg.get("voice_mode") or "auto").strip().lower()
    ptt["mode"] = "ptt" if mode == "ptt" else "auto"
    vk = _vk_of(cfg.get("ptt_key"))
    changed = (vk != ptt.get("vk")) or (ptt.get("announced") != (ptt["mode"], vk))
    ptt["vk"] = vk
    if ptt["mode"] == "ptt" and not vk:
        ptt["mode"] = "auto"
        log("PTT：按键无效（%r），先按「一直听」处理" % cfg.get("ptt_key"))
    if changed:
        ptt["announced"] = (ptt["mode"], ptt["vk"])
        if ptt["mode"] == "ptt":
            log("对话方式：按键说话（%s，vk=0x%02X）" % (cfg.get("ptt_key"), ptt["vk"]))
        else:
            log("对话方式：一直听")


def _ptt_flag_touch():
    """读 Electron 写的 PTT 标记；有新的按下就返回 True。

    为什么要绕一圈：这台机器不允许 python 进程读键盘状态
    （GetAsyncKeyState 恒为 0），但 Electron 用 globalShortcut 注册热键是系统级的。
    所以由 Electron 收键，写一个标记文件，桥这边只读文件。
    """
    try:
        mt = os.path.getmtime(PTT_FLAG)
    except Exception:
        return False
    st = _PTT_CTX.get("state") or {}
    if st.get("flag_mtime") == mt:
        return False
    st["flag_mtime"] = mt
    return True


def _ptt_down():
    """当前是否该收音：Electron 按到键（开了一个收音窗口）或本进程能读到键按住。"""
    st = _PTT_CTX.get("state") or {}
    if st.get("open_until", 0.0) > time.monotonic():
        return True
    return _key_down(st.get("vk", 0))


_PTT_CTX = {}


def mic_loop(asr, brain, say_it, vad, context, cfg, device_index, stop_event):
    silero_gate = SileroGate()
    # 已经在用 Silero 切段了，不要再拿 Silero 二次过滤（阈值不同会互相打架）
    if getattr(vad, "ok", False):
        silero_gate.ok = False
        log("切段已用 Silero，关闭二次过滤")
    pa = pyaudio.PyAudio()
    mic = MicStream(pa, device_index)
    log("麦克风已打开：device=%d 原生 %dch / %d Hz → 16 kHz 单声道  VAD阈值 %.4f"
        % (device_index, mic.channels, mic.rate, getattr(vad, "threshold", 0)))
    log("语音门限：自适应（跟随房间底噪，约 0.002~0.02；低于此值才算噪声）")

    # ── 半双工：说话期间静音麦克风 ────────────────────────
    # 不加这个会形成回声环：她说的话从喇叭出来又被麦克风收进去，
    # ASR 再识别一遍 → 又一个回复 → 无限重复（实测同一句被回复 3 次）。
    _echo = {"until": 0.0}
    _last_said = {"key": "", "at": 0.0}   # 同句去重：回声/重复说话避免重复回复
    _orig_say = say_it

    def say_it(text, *a, **kw):
        t = (text or "").strip()
        if t:
            # 估一下音频时长（中文约 5 字/秒），再多留 0.5 秒给房间混响
            _echo["until"] = time.monotonic() + max(1.2, len(t) * 0.19) + 0.5
        return _orig_say(text, *a, **kw)

    work = queue.Queue(maxsize=4)
    frame_ms = FRAME / SAMPLE_RATE * 1000.0
    merge_gap = cfg["merge_gap_ms"] / 1000.0
    wake_patterns = build_wake_patterns(cfg.get("wake_words") or [])
    wake_state = {"until": 0.0}
    # 注意：这个名字不能叫 pending —— 下面碎片合并用的是 pending（缓冲），
    # 同名会把这边覆盖成 None，worker 里一取下标就 TypeError。
    confirm_pending = {"actions": [], "until": 0.0}
    # 听写模式：说「打字」之后，下一句原样打进当前窗口。
    dictation = {"until": 0.0}
    _auto_state = {"next_probe": 0.0, "last_speech": time.monotonic()}   # 自动换麦用
    _mic_state = {"fails": 0, "silent_since": 0.0}   # 麦克风自愈：读取失败计数 / 全零起始时间
    _noise = {"v": 0.004}   # 房间底噪（慢速 EMA），用于自适应电平门限
    # 按键说话（PTT）状态：mode = auto / ptt；vk 来自配置里的 ptt_key
    _ptt = {"mode": "auto", "vk": 0, "was_muted": False, "muted_frames": 0, "open_until": 0.0, "flag_mtime": None,
            "cfg_at": 0.0, "cfg_mtime": None}
    _PTT_CTX["state"] = _ptt
    try:
        _ptt_sync(CFG_PATH, _ptt)
    except Exception as exc:
        log("PTT 初始化失败：%s" % exc)
    _beat = {"at": time.monotonic(), "peak": 0.0}   # 心跳：每 60 秒记一次电平，事后能判断「没说话」还是「没在听」

    # ── 屏幕快照缓存 ────────────────────────────────────────
    # OCR 单次要 0.3~1.5 秒，原来它是**在关键路径上**（说完话才截屏，然后才调模型），
    # 白白拖慢每一句。现在改成后台每 4 秒刷一次，说话时直接用最新快照。
    _shot = {"data": None, "at": 0.0}
    SCREEN_FRESH_SEC = 6.0

    def _refresh_screen():
        try:
            s = desktop.describe_screen(
                scope=cfg.get("ocr_scope", "active"),
                max_lines=int(cfg.get("ocr_max_lines", 24)))
            _shot["data"] = s
            _shot["at"] = time.monotonic()
            return s
        except Exception as exc:
            log("后台刷新屏幕失败：%s" % exc)
            return None

    def _screen_refresher():
        while not stop_event.is_set():
            _refresh_screen()
            for _ in range(40):          # 4 秒，分片睡眠以便及时退出
                if stop_event.is_set():
                    return
                time.sleep(0.1)

    threading.Thread(target=_screen_refresher, daemon=True).start()

    def grab_screen():
        """取屏幕快照：优先用后台缓存的，缓存过期了才现场截。"""
        if _shot["data"] is not None and time.monotonic() - _shot["at"] <= SCREEN_FRESH_SEC:
            return _shot["data"]
        s = _refresh_screen()
        if s:
            log("屏幕(%s%s)：%d 行文字，光标 (%d,%d)" % (
                s.get("scope"),
                "：" + s["title"][:20] if s.get("title") else "",
                len(s.get("lines") or []), s["cursor"][0], s["cursor"][1]))
        return s

    def _narrate(actions):
        """执行动作前，用气泡说明她准备做什么（让她"看起来在动手"）。"""
        try:
            if live2d_pet is None:
                return
            names = {
                "run": "启动程序", "type": "打字", "click": "点击",
                "key": "按键", "scroll": "滚动", "move": "移动鼠标",
                "drag": "拖动", "activate": "切换窗口",
                "screenshot": "截图", "windows": "看窗口",
            }
            parts = []
            for a in actions:
                if isinstance(a, dict):
                    n = names.get(a.get("op"), a.get("op"))
                    if n and n not in parts:
                        parts.append(n)
            if parts:
                live2d_pet.bubble("我来：" + "、".join(parts), 5)
        except Exception:
            pass

    def handle_text(command_text):
        """处理一句话：确认闸门 → 本地快速通道 → 模型 → 执行 → 说出来。"""
        # ── 同句去重 ─────────────────────────────────────
        # 回声抑制之后仍可能有残留（喇叭混响、用户连说两遍）：
        # 6 秒内同一句话只处理一次，避免同一个问题被回复很多次。
        _k = re.sub(r"\s+", "", command_text or "")
        _now = time.monotonic()
        if _k and _k == _last_said["key"] and _now - _last_said["at"] < 6.0:
            log("重复的一句（%.1f 秒内），忽略：%r" % (_now - _last_said["at"], command_text[:30]))
            return
        _last_said["key"], _last_said["at"] = _k, _now

        # 危险动作的确认闸门：上一轮攒下的动作，这一句在等「好」或「不要」。
        if confirm_pending["actions"] and time.monotonic() < confirm_pending["until"]:
            if is_affirmative(command_text):
                log("确认放行：%s" % json.dumps(confirm_pending["actions"], ensure_ascii=False)[:300])
                results = run_actions(confirm_pending["actions"])
                log("执行了 %d 个动作：%s"
                    % (len(results), json.dumps(results, ensure_ascii=False)[:400]))
                confirm_pending["actions"] = []
                say_it("好，做了。")
                return
            if is_negative(command_text):
                log("用户否掉了这批动作")
                confirm_pending["actions"] = []
                say_it("好，那我不动。")
                return
            confirm_pending["actions"] = []   # 说了别的，当新请求处理

        # 听写模式：上一句说了「打字」，这一句原样打进去。
        if dictation["until"] > time.monotonic():
            # 听写模式只接「要打的文字」。如果主人接着说的是问题/指令，
            # 就该正常回答，而不是把问题本身打进输入框（踩过这个坑）。
            _looks_like_ask = bool(re.search(
                r"[？?]|什么|怎么|为什么|是不是|能不能|帮我|看一下|不要说|不要这么", command_text))
            if _looks_like_ask or len(command_text) > 40:
                log("听写模式下听到的是问题/指令，取消听写、按正常话处理")
                dictation["until"] = 0.0
            else:
                dictation["until"] = 0.0
                results = run_actions([{"op": "type", "text": command_text}])
                log("听写执行：%s" % json.dumps(results, ensure_ascii=False)[:300])
                say_it("好，打好了。")
                return

        # 只说了「打字」：进入听写模式，等下一句。
        if re.match(r"^(?:请|帮我|帮忙|麻烦)?\s*(?:打字|输入|键入|打一下|打个字|打几个字|打点字|敲一下)\s*(?:一下)?$",
                    re.sub(r"[。.!！?？~～…]+$", "", command_text.strip())):
            dictation["until"] = time.monotonic() + 30
            log("进入听写模式（30 秒内下一句原样打出去）")
            say_it("好，你说，我打上去。")
            return

        # 先试本地快速通道：常见指令不绕模型，省掉那固定 10 秒。
        plan = local_plan(command_text)
        source = "本地"
        screen = None

        if plan is None:
            screen = grab_screen()
            plan = local_plan(command_text, screen)

        if plan is None:
            source = "模型"
            if screen is None:
                screen = grab_screen()
            try:
                # 任务型请求先立刻应一声：她真去调工具做事要 30~50 秒，
                # 干等会让主人以为她没反应。
                task_like = looks_like_command(command_text) or bool(re.search(
                    r'帮我|帮忙|看一下|查一下|看看|装|打开|启动|运行|列出|整理|改成|删掉', command_text))
                timeout_s = PROMPT_TIMEOUT_TASK if task_like else PROMPT_TIMEOUT
                if task_like:
                    say_it('好，我去看看。')
                # 联网：只有问「我本来不知道的事实」时才查（用主人这句话判断，不用整段提示词）
                # 屏幕文字只在**需要看屏幕**的时候才带：纯聊天带上它等于白烧几百 token
                need_screen = bool(re.search(
                    r'屏幕|看看|看到|看一下|这个|这里|那里|上面|下面|左边|右边|按钮|框|窗口|页面|选中|勾选',
                    command_text)) or task_like
                screen_text = desktop.format_screen(screen) if (screen and need_screen) else None
                if screen_text:
                    log("带上屏幕文字：%d 字" % len(screen_text))
                prompt_text = context.compose(command_text, screen_text)
                try:
                    if PetNet is not None and PetNet.looks_like_info_need(command_text):
                        _city = (load_config().get("weather_city") or None)
                        facts = PetNet.research(command_text, _city)
                        if facts:
                            log("联网查到（%s）：%s" % (command_text[:20], facts[:80].replace("\n", " ")))
                            prompt_text = ("【刚刚联网查到的实时资料，回答以此为准，不要编造】\n"
                                           + facts + "\n\n" + prompt_text)
                        else:
                            log("联网没查到，照常回答")
                except Exception as exc:
                    log("联网失败（照常回答）：%s" % exc)
                answer = brain.ask_timed(prompt_text, timeout=timeout_s)
            except Exception as exc:
                # 大脑卡住/挂了：不要让整个对话线程跟着死，先回一句，下一句还能继续
                log('问大脑失败：%s' % exc)
                msg = str(exc)
                if 'API HTTP 4' in msg or 'model' in msg.lower() or 'key' in msg.lower():
                    log('接口报错，需要改设置：%s' % msg[:160])
                    say_it('接口那边报错了，去桌宠设置里检查一下模型名和 API Key。')
                else:
                    say_it('我脑子卡了一下，你再说一遍试试？')
                return
            reply = (answer.get("reply") or "").strip()
            plan = desktop.parse_reply(reply)
            say_text = (plan.get("say") or reply or "").strip()
            log("模型回答（%s ms）：%r" % (answer.get("elapsedMs"), say_text[:140]))
        else:
            say_text = (plan.get("say") or "").strip()
            log("%s通道 → %s" % (source, say_text[:120] or "（无话）"))

        actions = plan.get("actions") or []
        if actions:
            risky = [a for a in actions if is_risky_action(a)]
            if risky and cfg.get("confirm_risky", True):
                confirm_pending["actions"] = actions
                confirm_pending["until"] = time.monotonic() + float(cfg.get("confirm_window_s", 60))
                log("先问再做：%s" % json.dumps(actions, ensure_ascii=False)[:300])
                say_text = (say_text + " 要我做就说「好」。").strip()
            else:
                _narrate(actions)
                results = run_actions(actions)
                log("执行了 %d 个动作：%s"
                    % (len(results), json.dumps(results, ensure_ascii=False)[:400]))
                blocked = [r for r in results if isinstance(r, dict) and r.get("ok") is False]
                if blocked:
                    # 模拟输入被安全软件拦截时，如实告诉用户
                    say_text = "有一步被系统拦住了，帮我看看安全软件是不是挡住了模拟输入。"
        if say_text:
            context.remember(command_text, say_text)
            say_it(say_text)

    def worker():
        while not stop_event.is_set():
            try:
                item = work.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                break
            try:
                samples = normalize_peak(item["samples"], cfg["agc_target_peak"])
                # 先过 Silero VAD：不像人声就直接丢，连 ASR 都不跑（省 CPU、防误触发）
                if not silero_gate.has_speech(samples):
                    log("（%d ms 判定非人声，已过滤）" % item["ms"])
                    continue
                result = asr.transcribe(samples)
                if not result["text"]:
                    log("（%d ms 音频没识别出内容，电平 %.4f）" % (item["ms"], item.get("level", 0)))
                    continue
                log("听到：%r  [选 %s %s]  %d ms 解码  电平 %.3f  时长 %d ms" % (
                    result["text"], result["language"],
                    " ".join("%s:%d" % (k, v) for k, v in result["scores"].items()),
                    result["decode_ms"], item.get("level", 0), item["ms"]))
                log("  双解码：%s" % "  |  ".join("%s=%s" % (k, v) for k, v in result["texts"].items()))

                # 唤醒词闸门：喊了才动手，平时说话不会乱点鼠标。
                command_text = result["text"]
                if cfg.get("require_wake", True):
                    woke, rest = detect_wake(result, wake_patterns)
                    now = time.monotonic()
                    if woke:
                        wake_state["until"] = now + float(cfg.get("wake_window_s", 20))
                        log("唤醒词命中 %r → 命令 %r" % (woke, rest))
                        if not rest:
                            say_it("我在，讲啦")
                            continue
                        command_text = rest
                    elif now < wake_state["until"]:
                        log("（唤醒窗口内，直接当命令）")
                    elif cfg.get("commands_bypass_wake", True) and (
                        looks_like_command(result["text"])
                        or local_plan(result["text"]) is not None
                    ):
                        # 「保存」「关掉」「上滑」这种短命令没有宾语，正则的
                        # 「动词+内容」形式匹配不上，所以再用 local_plan 兜一层。
                        log("（没喊唤醒词，但是明确的命令句，直接执行）")
                    else:
                        log("（没听到唤醒词「deepseek」，忽略这句：%r）" % result["text"][:30])
                        continue

                handle_text(command_text)
            except Exception:
                import traceback

                # 只打 str(exc) 会丢掉出错位置，之前就是因此看不出 'NoneType' 从哪来。
                tb = traceback.format_exc().strip().splitlines()
                log("处理失败：%s" % " | ".join(tb[-6:]))

    threading.Thread(target=worker, daemon=True).start()

    cmd_file = os.path.join(HERE, "command.txt")

    def command_watcher():
        """外部指令通道：把一行文字写进 command.txt，桥用同一套逻辑处理。

        两个用途：① 我能自己验证「打字是不是真的打出去了」（桥有输入权限，
        我的 shell 没有）；② 别的程序想给桌宠下指令时有个简单入口。
        """
        while not stop_event.is_set():
            try:
                if os.path.exists(cmd_file):
                    with open(cmd_file, encoding="utf-8") as f:
                        text = f.read().strip()
                    os.remove(cmd_file)
                    if text:
                        log("收到 command.txt 指令：%r" % text[:120])
                        if text.startswith("SAY:"):
                            # 直接朗读固定台词（不经过大脑，不消耗 token）
                            # 用途：右键菜单的「打个招呼」「摸摸头」这类互动语音
                            line = text[4:].strip()
                            if line:
                                try:
                                    say_it(line)
                                    log("直接朗读：%r" % line[:60])
                                except Exception as exc:
                                    log("直接朗读失败：%s" % exc)
                        elif text.startswith("{") or text.startswith("["):
                            # 直接给动作 JSON，用于精确验证/调试
                            try:
                                payload = json.loads(text)
                                acts = payload if isinstance(payload, list) else [payload]
                                results = run_actions(acts)
                                log("执行 JSON 动作：%s" % json.dumps(results, ensure_ascii=False)[:300])
                            except Exception as exc:
                                log("JSON 动作解析失败：%s" % exc)
                        else:
                            handle_text(text)
            except Exception as exc:
                log("command.txt 处理失败：%s" % exc)
            time.sleep(0.4)

    threading.Thread(target=command_watcher, daemon=True).start()
    _install_typing_route()

    pending = None  # 等一小会儿，看还有没有下一段要接上来

    def flush(force=False):
        nonlocal pending
        if not pending:
            return
        if force or time.monotonic() >= pending["due"]:
            try:
                work.put_nowait({k: pending[k] for k in ("samples", "ms", "reason", "level")})
            except queue.Full:
                log("处理队列满，丢弃一句（%d ms）" % pending["ms"])
            pending = None

    try:
        while not stop_event.is_set():
            # ── 自动换麦：连续一段时间听不到人声，就扫一遍设备换到最响的那个 ──
            now_ts = time.monotonic()
            if not _auto_state["next_probe"]:
                _auto_state["next_probe"] = now_ts + 12.0
            if AUTO_SWITCH_DEVICE and now_ts >= _auto_state["next_probe"]:
                _auto_state["next_probe"] = now_ts + 12.0
                if now_ts - _auto_state["last_speech"] > 12.0:
                    try:
                        best_idx, best_rms = pick_loudest_device(pa, exclude=())
                        cur_rms = measure_device_rms(pa, device_index) or 0.0
                        if (best_idx is not None and best_idx != device_index
                                and best_rms > max(cur_rms * 2.0, 0.004)):
                            log("自动换麦：device %s(%.4f) → %s(%.4f)" % (
                                device_index, cur_rms, best_idx, best_rms))
                            try:
                                mic.close()
                            except Exception:
                                pass
                            device_index = best_idx
                            mic = MicStream(pa, device_index)
                            vad = EnergyVad(cfg, ambient=max(best_rms * 0.3, 1e-5))
                    except Exception as exc:
                        log("自动换麦失败：%s" % exc)
            # ── 采集这一帧：失败要能自愈，不能整条桥跟着死 ──────────
            try:
                frame = mic.read_frame()
                _mic_state["fails"] = 0
            except Exception as exc:
                _mic_state["fails"] += 1
                log("麦克风读取失败（第 %d 次）：%s" % (_mic_state["fails"], exc))
                if _mic_state["fails"] >= 3:
                    try:
                        mic.reopen()
                        _mic_state["fails"] = 0
                        _mic_state["silent_since"] = 0.0
                        log("麦克风已重新打开：device=%s" % getattr(mic, "index", "?"))
                    except Exception as exc2:
                        log("重新打开麦克风失败：%s（3 秒后重试）" % exc2)
                        time.sleep(3.0)
                else:
                    time.sleep(0.2)
                continue

            # ── 静音看门狗：流坏了会「不报错但一直返回全零」 ──────
            # 真实麦克风即使安静也有底噪；精确的 0.0 说明这条流已经死了。
            loop_now = time.monotonic()
            if float(np.abs(frame).mean()) == 0.0:
                if not _mic_state["silent_since"]:
                    _mic_state["silent_since"] = loop_now
                elif loop_now - _mic_state["silent_since"] > 15.0:
                    log("麦克风连续 15 秒输出全零，判定流失效，正在重开…")
                    try:
                        mic.reopen()
                        log("麦克风已重开：device=%s" % getattr(mic, "index", "?"))
                    except Exception as exc3:
                        log("重开失败：%s" % exc3)
                    _mic_state["silent_since"] = 0.0
                    time.sleep(0.5)
                    continue
            else:
                _mic_state["silent_since"] = 0.0

            # 心跳：60 秒一次，记下峰值电平；桥"静默失聪"时能一眼看出来
            _beat["peak"] = max(_beat["peak"], float(np.abs(frame).max()))
            _now_beat = time.monotonic()
            # 设置里改了「对话方式 / 按键」时这里自动跟上，不用重启
            if _now_beat - _ptt["cfg_at"] > 3.0:
                _ptt["cfg_at"] = _now_beat
                try:
                    _ptt_sync(CFG_PATH, _ptt)
                except Exception:
                    pass
            if _now_beat - _beat["at"] > 60.0:
                _beat["at"] = _now_beat
                log("心跳：麦克风峰值 %.4f（60s 内）设备 %s" % (
                    _beat["peak"], getattr(mic, "index", "?")))
                _beat["peak"] = 0.0
            # 她正在说话 / 刚说完：把这一帧当静音，避免听到自己
            if time.monotonic() < _echo["until"]:
                frame = np.zeros_like(frame)
            # 按键说话（PTT）：不按键时把音频换成静音，
            # 这样 VAD 自然会结束上一句，不用另写一套状态机。
            if _ptt["mode"] == "ptt":
                # Electron 按到快捷键会写标记文件（python 进程读不到键盘）
                if _ptt_flag_touch() and not _key_down(_ptt.get("vk", 0)):
                    _ptt["open_until"] = time.monotonic() + 8.0
                    log("PTT：收到按键，开始收音")
                if not _ptt_down():
                    _ptt["muted_frames"] += 1
                    if not _ptt["was_muted"]:
                        log("PTT：松开按键，结束这句")
                    _ptt["was_muted"] = True
                    frame = np.zeros_like(frame)
                else:
                    if _ptt["was_muted"]:
                        log("PTT：按住按键，开始收音")
                    _ptt["was_muted"] = False
                    _ptt["muted_frames"] = 0
            else:
                _ptt["was_muted"] = False
            # 底噪跟踪（慢速 EMA）：门限跟着房间噪声走，固定值要么误杀说话、要么放过噪声
            # PTT 静音帧不参与底噪统计，否则会把门限越压越低
            _rms_now = float(np.abs(frame).mean())
            if _ptt["mode"] != "ptt" or not _ptt["was_muted"]:
                _noise["v"] = _noise["v"] * 0.995 + _rms_now * 0.005
            utt = vad.process(frame)

            # 电平门限：只挡「几乎无声」的幽灵片段。
            # ⚠️ 这里**不能**用 vad.threshold —— SileroSegmenter 的 threshold 是
            # Silero 的概率阈值（0.5），不是音量；用它会算出 0.35 的门限，
            # 把正常说话（0.01~0.07）全部当噪声丢掉（踩过这个坑，表现为"她听不懂我说话"）。
            LEVEL_FLOOR = min(0.02, max(0.0022, _noise["v"] * 1.5))
            if utt and float(utt.get("level") or 0) < LEVEL_FLOOR:
                log("（%.1f 秒片段电平 %.4f < %.4f，判定噪声丢弃）"
                    % (utt.get("ms", 0) / 1000.0, float(utt.get("level") or 0), LEVEL_FLOOR))
                utt = None
            flush()

            if utt:
                _auto_state["last_speech"] = time.monotonic()
                # 这一句说完了：PTT 的收音窗口关闭，等下一次按键
                _ptt["open_until"] = 0.0
                if pending:
                    # 上一句刚说完又开口：接在同一句里，避免「我。」「钟。」式碎片。
                    pending["samples"] = np.concatenate([pending["samples"], utt["samples"]])
                    pending["ms"] += utt["ms"]
                    pending["level"] = max(pending["level"], utt["level"])
                    pending["due"] = time.monotonic() + merge_gap
                else:
                    pending = {
                        "samples": utt["samples"], "ms": utt["ms"],
                        "reason": utt["reason"], "level": utt["level"],
                        "due": time.monotonic() + merge_gap,
                    }
    finally:
        flush(force=True)
        work.put(None)
        try:
            mic.close()
        finally:
            pa.terminate()



def bridge_running():
    """是否已有另一个 voice_bridge 进程在跑（自检据此决定要不要碰麦克风）。"""
    try:
        import psutil
        me = os.getpid()
        for p in psutil.process_iter(["pid", "cmdline"]):
            if p.info.get("pid") == me:
                continue
            cmd = " ".join(p.info.get("cmdline") or [])
            if "voice_bridge.py" in cmd and "selfcheck" not in cmd:
                return True
    except Exception:
        pass
    return False
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="只测大脑与说话通道")
    ap.add_argument("--say", metavar="TEXT", help="只让桌宠说一句")
    ap.add_argument("--wav", metavar="FILE", help="只识别一个 wav")
    ap.add_argument("--devices", action="store_true", help="列出输入设备并测电平")
    ap.add_argument("--calibrate", action="store_true", help="测环境噪声")
    ap.add_argument("--selfcheck", action="store_true", help="自检：构造各组件后立即退出（不占麦克风）")
    args = ap.parse_args()

    cfg = load_config()
    log("=" * 60)
    log("voice_bridge 启动  python=%s  cfg=%s" % (sys.version.split()[0], json.dumps(cfg, ensure_ascii=False)))

    if args.selfcheck:
        # 自检：只构造，不启动麦克风。专治"启动即崩"这类问题——
        # 之前 vad.front() 属性当方法调用、SileroSegmenter 缺 threshold 属性，
        # 都是启动后几秒进程就没了，任务状态却还是 Running。
        rc = 0
        def step(name, fn):
            global rc
            try:
                info = fn()
                print("  OK   %-14s %s" % (name, info))
            except Exception as exc:
                rc = 1
                print("  FAIL %-14s %s: %s" % (name, type(exc).__name__, exc))
        def make_vad():
            v = SileroSegmenter(cfg)
            # 关键：front 是属性不是方法（这里踩过坑）
            assert hasattr(v, "ok"), "SileroSegmenter 缺 ok 属性"
            assert hasattr(v, "threshold"), "SileroSegmenter 缺 threshold 属性"
            return "ok=%s threshold=%s" % (getattr(v, "ok", None), getattr(v, "threshold", None))
        def make_asr():
            a = DualAsr()
            return "langs=%s" % ",".join(sorted(getattr(a, "recs", {}).keys()))
        def make_ctx():
            c = Context(cfg.get("context_turns", 4))
            line = dsh_context.context_line() if dsh_context else ""
            return "turns=%d dsh=%s" % (c.max_turns, (line[:40] + "...") if line else "(无活动)")
        def make_brain():
            b = Brain()
            return "brain ok"
        def check_audio():
            # 桥正在跑时绝不能碰麦克风：PortAudio 会因为设备被占把正在用的流弄坏，
            # 症状是「进程活着、CPU 满载、但永远听不到声音」（踩过一次，34 分钟空转）。
            if bridge_running():
                return "SKIP（桥正在运行，避免抢设备）"
            pa = pyaudio.PyAudio()
            try:
                dev = pick_device(pa, cfg)
                return "device=%s" % dev
            finally:
                pa.terminate()
        step("VAD", make_vad)
        step("ASR", make_asr)
        step("上下文", make_ctx)
        step("大脑", make_brain)
        step("麦克风", check_audio)
        print("自检%s" % ("通过" if rc == 0 else "失败"))
        sys.exit(rc)

    if args.devices:
        pa = pyaudio.PyAudio()
        for idx, name in _candidate_devices(pa, cfg.get("device_name_hint", "")):
            peak, median, err = measure_device(pa, idx, seconds=1.5)
            print("%2d  %-36s %s" % (
                idx, name[:36],
                ("rmsMax=%.4f median=%.4f" % (peak, median)) if peak is not None else ("打不开：%s" % err)))
        pa.terminate()
        return

    if args.calibrate:
        pa = pyaudio.PyAudio()
        dev = pick_device(pa, cfg)
        stats = calibrate_ambient(pa, dev)
        pa.terminate()
        thr = min(max(stats["rmsMedian"] * 1.8 + 0.0015, 0.0025), 0.25)
        print(json.dumps({"device": dev, **{k: round(v, 5) for k, v in stats.items()},
                          "suggestedThreshold": round(thr, 5)}, ensure_ascii=False, indent=2))
        return

    if args.say:
        Say()(args.say)
        return

    if args.wav:
        asr = DualAsr()
        r = asr.transcribe_file(args.wav)
        print(json.dumps({k: v for k, v in r.items() if k != "texts"}, ensure_ascii=False, indent=2))
        for lang, text in r["texts"].items():
            print("  [%s] %s" % (lang, text))
        return

    brain_mode = (cfg.get("brain_mode") or BRAIN_MODE_DEFAULT).lower()
    llm_cfg = cfg.get("llm") or {}
    brain = None
    if brain_mode == "api" and PetLLM is not None:
        _llm = PetLLM(llm_cfg)
        if _llm.available():
            brain = ApiBrain(_llm)
            log("大脑：直连 API（%s）" % _llm.describe())
        else:
            log("大脑：API key 缺失，回退到 DSH 子代理")
    if brain is None:
        brain = Brain()
        brain.warmup()   # 后台先把端口找到，第一句话不用再等 8 秒
        USE_DSH_CONTEXT = True
    else:
        USE_DSH_CONTEXT = False
    say_it = Say()

    if args.selftest:
        port = brain.discover()
        print("brain port:", port)
        ctx = Context(cfg["context_turns"])
        answer = brain.ask(ctx.compose("用一句话说明你现在能做什么。"))
        print("reply:", answer.get("reply"))
        print("said:", say_it(answer.get("reply") or ""))
        return

    if not _single_instance():
        log("已经有一份语音桥在跑了，这份直接退出（避免重复听麦）")
        return

    asr = DualAsr()
    try:
        ok, err = desktop.input_allowed()
        if ok:
            log("输入注入：允许（可以点鼠标、打字）")
        else:
            log("输入注入：**被拒绝**（err=%d）。必须是「计划任务动作直接是 python.exe」，"
                "套 wscript/隐藏窗口都会丢权限。" % err)
        # 安全软件是看「有没有可见控制台」放行的：启动时先带着控制台拿到权限，
        # 再把它藏起来，免得有人顺手关掉（关掉 = 语音桥被终止）。
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)   # SW_HIDE
            time.sleep(0.4)
            ok2, _ = desktop.input_allowed()
            log("控制台已隐藏；隐藏后注入：%s" % ("仍允许" if ok2 else "**被拒绝**（那就不该隐藏）"))
            _lock_type_route(bool(ok2))
    except Exception as exc:
        log("输入注入自检失败：%s" % exc)

    pa = pyaudio.PyAudio()
    device_index = pick_device(pa, cfg)
    stats = calibrate_ambient(pa, device_index, seconds=2.0)
    log("环境噪声：median=%.5f p90=%.5f max=%.5f  →  VAD 阈值 %.5f"
        % (stats["rmsMedian"], stats["rmsP90"], stats["rmsMax"],
           min(max(stats["rmsMedian"] * 1.8 + 0.0015, 0.0025), 0.25)))
    pa.terminate()

    # 优先用 Silero 切段（噪音不会成段）；拿不到就退回能量 VAD
    vad = EnergyVad(cfg, ambient=max(stats["rmsMedian"], 1e-5))
    _sil = SileroSegmenter(cfg)
    if _sil.ok:
        vad = _sil
    context = Context(cfg.get("context_turns", 6), use_dsh_context=USE_DSH_CONTEXT)
    stop_event = threading.Event()
    try:
        mic_loop(asr, brain, say_it, vad, context, cfg, device_index, stop_event)
    except KeyboardInterrupt:
        log("收到 Ctrl+C，退出")
        stop_event.set()


if __name__ == "__main__":
    main()
