#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_voice.py — 让桌宠说话。

链路：
  文本 --edge-tts--> audio/speak_<时间戳>.mp3 --桌宠外壳的静态服务--> 页面 <audio> 播放
  播放期间页面里的嘴巴跟着开合（interact.ts 的 __playAudio）

为什么用 edge-tts：
  · 微软的神经语音，中文自然度远好于系统 SAPI（Xiaoxiao/Yunxi 等 8 个中文音色）
  · 只要联网，不依赖本机 SAPI（本机 SAPI 在子进程里拿不到语音授权）
  · 离线时自动退回 Windows SAPI / 纯口型

对外：
  speak(text)  合成 + 播放（异步）
  stop()       停止播放
  voices()     列出可用中文语音
"""

import asyncio
import hashlib
import json
import os
import threading
import time
import urllib.request

AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")
HERE = os.path.dirname(os.path.abspath(__file__))
LOGS_DIR = os.path.join(HERE, "logs")
DATA_DIR = os.path.join(HERE, "data")
for _d in (LOGS_DIR, DATA_DIR):
    try:
        os.makedirs(_d, exist_ok=True)
    except Exception:
        pass
CONF_PATH = os.path.join(DATA_DIR, "pet_voice.json")
API = "http://127.0.0.1:5011"

# 默认用「小艺」：8 个中文音色里唯一标 Cartoon 的少女音。
# 音调稍微提高（+25Hz）、语速稍快（+8%）更像动漫少女。
_DEFAULTS = {
    "voice": "zh-CN-XiaoyiNeural",
    "pitch": "+25Hz",
    "rate": "+8%",
    "volume": "+0%",
}


def _load_conf():
    """读取 pet_voice.json（不存在就用默认值并写一份出来，方便手动改）。"""
    conf = dict(_DEFAULTS)
    try:
        if os.path.exists(CONF_PATH):
            with open(CONF_PATH, encoding="utf-8") as f:
                conf.update({k: v for k, v in json.load(f).items() if isinstance(v, str)})
        else:
            with open(CONF_PATH, "w", encoding="utf-8") as f:
                json.dump(conf, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    # 环境变量优先级最高（方便临时试音）
    for key, env in (("voice", "PET_TTS_VOICE"), ("pitch", "PET_TTS_PITCH"),
                     ("rate", "PET_TTS_RATE"), ("volume", "PET_TTS_VOLUME")):
        if os.environ.get(env):
            conf[key] = os.environ[env]
    return conf


_CONF = _load_conf()
DEFAULT_VOICE = _CONF["voice"]
DEFAULT_PITCH = _CONF["pitch"]
DEFAULT_RATE = _CONF["rate"]
DEFAULT_VOLUME = _CONF["volume"]

# 生成的文件名带时间戳，避免浏览器缓存旧音频
_counter = 0
_lock = threading.Lock()


def _log_err(msg):
    """把失败原因写文件——桥是隐藏窗口跑的，看不到 stdout。"""
    try:
        with open(os.path.join(LOGS_DIR, "pet_voice.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    except Exception:
        pass


def _api(path, payload=None, timeout=6.0):
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            API + path, data=data,
            method="POST" if data is not None else "GET",
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def _next_name():
    global _counter
    with _lock:
        _counter += 1
        return "speak_%d_%d.mp3" % (int(time.time() * 1000), _counter)


async def _synth_edge(text, out_path, voice, rate, pitch, volume):
    import edge_tts
    tts = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    await tts.save(out_path)


def _cleanup_old(keep=12, max_age=1800):
    """清掉旧的合成音频，避免 audio 目录无限变大（每句话都会生成一个 mp3）。"""
    try:
        files = [os.path.join(AUDIO_DIR, f) for f in os.listdir(AUDIO_DIR) if f.startswith("speak_") and "_c" not in f]
        files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        now = time.time()
        for i, p in enumerate(files):
            if i >= keep and (now - os.path.getmtime(p)) > max_age:
                os.remove(p)
    except Exception:
        pass



# 说话时按内容挑一个表情，让她有情绪
MOOD_RULES = [
    (("哈哈", "嘿嘿", "开心", "高兴", "太好了", "棒"), "爱心眼"),
    (("对不起", "抱歉", "不好意思", "哎呀", "糟糕"), "＞＜"),
    (("喜欢", "想你", "亲亲", "抱抱"), "爱心眼"),
    (("哼", "才不", "讨厌"), "＞＜"),
    (("哇", "真的吗", "居然"), "兔牙"),
]


def _pick_expression(text):
    """按话里的关键词挑表情；没有命中就三成概率脸红一下。"""
    import random
    for keys, name in MOOD_RULES:
        for k in keys:
            if k in text:
                return name
    if random.random() < 0.3:
        return "脸红"
    return ""

def synth(text, voice=None, rate=None, pitch=None, volume=None):
    """用 edge-tts 合成到 mp3，返回 (文件名, 预估时长秒)。失败返回 (None, 0)。

    加了缓存：同一句话（同音色/语速/音调）第二次直接复用，省掉 1~2 秒的联网合成。
    固定台词（打招呼、听写提示等）会预热，所以听到几乎是即时。
    """
    text = (text or "").strip()
    if not text:
        return None, 0.0
    os.makedirs(AUDIO_DIR, exist_ok=True)
    _cleanup_old()

    v = voice or DEFAULT_VOICE
    r = rate or DEFAULT_RATE
    p = pitch or DEFAULT_PITCH
    vol = volume or DEFAULT_VOLUME

    key = "\x1f".join([text, v, r, p, vol])
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()[:16]
    cached = os.path.join(AUDIO_DIR, "speak_c%s.mp3" % digest)
    if os.path.exists(cached) and os.path.getsize(cached) > 500:
        return os.path.basename(cached), os.path.getsize(cached) / 6000.0

    out = cached + ".part"
    try:
        asyncio.run(_synth_edge(text, out, v, r, p, vol))
    except Exception as exc:
        _log_err("合成失败: %s" % exc)
        try:
            os.remove(out)
        except Exception:
            pass
        return None, 0.0
    if not os.path.exists(out) or os.path.getsize(out) < 500:
        _log_err("合成产物异常: %s" % out)
        return None, 0.0
    try:
        os.replace(out, cached)
    except Exception:
        pass
    # edge-tts 默认输出 24kHz 48kbps 单声道 ≈ 6000 字节/秒
    duration = os.path.getsize(cached) / 6000.0
    return os.path.basename(cached), duration


# 常用台词：启动时后台预热，之后说这句就是即时（本地读缓存）
PREWARM_LINES = (
    "主人好呀～想让我做点什么？",
    "嘿嘿，摸摸头好舒服～",
    "我在呢，要做什么直接说。",
    "好，打好了。",
    "打什么？说一下内容。",
)


def prewarm_async():
    """后台预热常用台词（不阻塞启动）。"""
    def run():
        for line in PREWARM_LINES:
            try:
                synth(line)
            except Exception:
                pass
            time.sleep(0.2)
    threading.Thread(target=run, daemon=True).start()


def speak(text, voice=None, wait=False):
    """合成并让桌宠播放。返回 True 表示已经在说。"""
    text = (text or "").strip()
    if not text:
        return False

    state = _api("/state")
    alive = bool(state and state.get("ok"))
    _log_err("speak start: text=%r state_ok=%s" % (text[:30], alive))

    name, duration = synth(text, voice)
    _log_err("speak synth: name=%r dur=%.2f" % (name, duration))
    _log_err("speak goto play: name=%s alive=%s" % (bool(name), alive))
    if name and alive:
        r = _api("/play", {"file": name, "duration": duration, "text": text})
        _log_err("speak play result: %r" % (r,))
        if not (r and r.get("ok")):
            _log_err("播放失败: %r（桌宠接口可能没开）" % (r,))
        if r and r.get("ok"):
            # 说话期间顺带做个表情
            try:
                expr = _pick_expression(text)
                if expr and live2d_pet is not None:
                    live2d_pet.expression(expr, ms=int(duration * 1000) + 800)
            except Exception:
                pass
        if r and r.get("ok"):
            if wait:
                time.sleep(min(60.0, duration + 0.6))
            return True

    # 兜底：只动嘴
    try:
        import live2d_pet
        live2d_pet.talk(text)
        if wait:
            time.sleep(min(20.0, max(1.2, len(text) / 6.5)))
    except Exception:
        pass
    return False


def stop():
    _api("/clear", {})


def voices():
    try:
        import edge_tts
        async def _list():
            vs = await edge_tts.list_voices()
            return [v["ShortName"] for v in vs if v["Locale"].startswith("zh-")]
        return asyncio.run(_list())
    except Exception:
        return []


if __name__ == "__main__":
    import sys

    args = [a for a in sys.argv[1:]]

    if args and args[0] == "voices":
        for v in voices():
            print(" ", v)
        sys.exit(0)

    if args and args[0] == "show":
        print(json.dumps(_CONF, ensure_ascii=False, indent=2))
        sys.exit(0)

    # 改音色：python pet_voice.py set <voice> [pitch] [rate]
    if args and args[0] == "set":
        conf = dict(_CONF)
        if len(args) >= 2:
            conf["voice"] = args[1]
        if len(args) >= 3:
            conf["pitch"] = args[2]
        if len(args) >= 4:
            conf["rate"] = args[3]
        with open(CONF_PATH, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)
        print("已保存:", json.dumps(conf, ensure_ascii=False))
        sys.exit(0)

    msg = " ".join(args) or "你好呀，我是大肥鱼，今天也要元气满满哦。"
    print("语音:", DEFAULT_VOICE, DEFAULT_PITCH, DEFAULT_RATE)
    ok = speak(msg, wait=True)
    print("播放" if ok else "合成失败（已用口型兜底）")
