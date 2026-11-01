#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
live2d_pet.py — 桌宠（大肥鱼 Live2D）的本地控制客户端。

桌宠主程序在 127.0.0.1:5011 上开了控制接口：
  GET  /state          状态
  POST /set            {"params": {"ParamName": 数值}}   按住这些参数
  POST /mouth|/say     {"open": 0~1}                     口型
  POST /clear          清空所有按住参数
  POST /reload         重新加载页面

语音桥只要 import 这个模块，就能让她动嘴、换表情。
"""

import json
import urllib.request

BASE = "http://127.0.0.1:5011"


def _req(path, payload=None, timeout=3.0):
    url = BASE + path
    try:
        if payload is None:
            req = urllib.request.Request(url, method="GET")
        else:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                url, data=data, method="POST",
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def alive():
    """桌宠是否在运行。"""
    return (_req("/state") or {}).get("ok") is True


def state():
    return _req("/state")


def set_params(**kwargs):
    """按住一组参数，例如 set_params(ParamEyeLOpen=1.0)。"""
    params = {k: float(v) for k, v in kwargs.items()}
    return _req("/set", {"params": params})


def mouth(level):
    """口型开合 0~1。"""
    try:
        level = max(0.0, min(1.0, float(level)))
    except (TypeError, ValueError):
        return None
    return _req("/mouth", {"open": level})


def clear():
    """清空所有按住参数（回到模型默认）。"""
    return _req("/clear", {})


def reload_page():
    return _req("/reload", {})


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print(json.dumps(state(), ensure_ascii=False, indent=1))
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == "state":
        print(json.dumps(state(), ensure_ascii=False, indent=1))
    elif cmd == "mouth":
        print(mouth(float(sys.argv[2]) if len(sys.argv) > 2 else 0.8))
    elif cmd == "clear":
        print(clear())
    elif cmd == "set":
        pairs = dict(a.split("=") for a in sys.argv[2:])
        print(set_params(**{k: float(v) for k, v in pairs.items()}))
    else:
        print("用法: python live2d_pet.py [state|mouth <0~1>|clear|set Param=Value ...]")


def bubble(text, seconds=0):
    """在桌宠头顶显示一个气泡（不发声）。"""
    return _req("/bubble", {"text": str(text or ""), "seconds": float(seconds)})

# ------------------------------------------------------------ 表情 / 动作 --
def expression(name, ms=0):
    """切换表情；ms>0 表示过一会儿自动收回。"""
    if ms and ms > 0:
        return _req("/expression", {"name": str(name), "ms": float(ms)})
    return _req("/expression", {"name": str(name)})


def clear_expression():
    return _req("/eval", {"js": "window.__clearExpression && window.__clearExpression()"})


def motion(group, no=0):
    """播放模型自带动作：举手 / 放手 / 竖手指开 / 竖手指关 / 狗尾草开 / 狗尾草关"""
    return _req("/motion", {"group": str(group), "no": int(no)})


def lists():
    """当前可用的表情和动作名字。"""
    return _req("/lists")

def queue_text(text):
    """把要打的字放进桌宠的文本队列，DSH 的打字插件会取走并写进输入框。"""
    return _req("/queue", {"text": str(text or "")})


def clear_input():
    # 清空输入框（交给 DSH 打字插件执行）
    return _req('/queue', {'clear': True})


def take_pending():
    return _req("/pending")
# ---------------------------------------------------------------- 说话动画 --
import random
import threading
import time as _time

_talk_lock = threading.Lock()
_talking = threading.Event()


def talk(text="", seconds=None):
    """让她"说话"：按文字长度估一个时长，嘴巴随机开合；结束自动闭合。

    没有 TTS 音频时用这个做伪口型；以后接了真语音，改成按音量包络调用 mouth() 即可。
    """
    if seconds is None:
        seconds = min(12.0, max(1.2, len(text or "") / 6.5))

    def _run():
        try:
            _talking.set()
            end = _time.time() + seconds
            while _time.time() < end:
                # 语速感：开合幅度随机、偶尔合嘴
                level = random.uniform(0.25, 0.85) if random.random() > 0.18 else 0.02
                mouth(level)
                _time.sleep(random.uniform(0.055, 0.13))
            mouth(0.0)
        finally:
            _talking.clear()

    with _talk_lock:
        if _talking.is_set():
            # 已经在说，处理新句子时再加一点时长即可（简单处理：忽略）
            return False
        threading.Thread(target=_run, daemon=True).start()
        return True


def is_talking():
    return _talking.is_set()