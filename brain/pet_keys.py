#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_keys.py —— 全局按键彩蛋（刻意不写进文档）

原则：
  · 不打扰：全局至少隔 3 分钟才会再触发一次，每个彩蛋自己也有冷却
  · 不频繁：只在明确的"暗号"出现时才动，普通打字不会触发
  · 纯本地：只读按键状态（GetAsyncKeyState），不模拟、不注入、不记录内容

触发后她会做一个小动作（晃一下、换表情、冒个气泡），不发声。
"""

import ctypes
import time

u32 = ctypes.windll.user32

# 只需要关心的键（字母 + 数字 + 方向键 + 空格）
_VK = {
    "A": 0x41, "B": 0x42, "C": 0x43, "D": 0x44, "E": 0x45, "F": 0x46,
    "H": 0x48, "I": 0x49, "M": 0x4D, "O": 0x4F, "P": 0x50, "U": 0x55,
    "Y": 0x59,
    "0": 0x30, "2": 0x32, "3": 0x33, "6": 0x36,
    "SPACE": 0x20,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
}

# Konami 暗号
_KONAMI = ["UP", "UP", "DOWN", "DOWN", "LEFT", "RIGHT", "LEFT", "RIGHT", "B", "A"]

# 打字暗号 → 动作
_TEXT_EGGS = {
    "dafeiyu": ("诶…你叫我名字？", "脸红", "shake"),
    "momo": ("嘿嘿…", "爱心眼", "pat"),
    "233": ("哈哈哈", "兔牙", "laugh"),
    "666": ("这么强？", "爱心眼", "wave"),
}


class _KeyWatcher:
    def __init__(self):
        self.down = {k: False for k in _VK}
        self.text = []           # [(char, ts)]，只最近 8 秒
        self.konami = []         # [(name, ts)]
        self.egg_at = {}         # name -> 上次触发时间
        self.last_any = 0.0      # 上一次触发任何彩蛋

    def poll(self):
        """返回这一轮新按下的键名列表。"""
        now = time.time()
        fresh = []
        for name, vk in _VK.items():
            pressed = bool(u32.GetAsyncKeyState(vk) & 0x8000)
            if pressed and not self.down[name]:
                fresh.append(name)
            self.down[name] = pressed
        # 维护文本缓冲（方向键不参与打字暗号）
        for name in fresh:
            if len(name) == 1 and (name.isalpha() or name.isdigit()):
                self.text.append((name.lower(), now))
            if name in ("UP", "DOWN", "LEFT", "RIGHT", "A", "B"):
                self.konami.append((name, now))
        self.text = [(c, t) for c, t in self.text if now - t < 8.0][-40:]
        self.konami = [(n, t) for n, t in self.konami if now - t < 3.0][-16:]
        return fresh

    def match(self):
        """返回 (名字, 气泡台词, 表情, 动作) 或 None。"""
        now = time.time()
        # 全局冷却：3 分钟内只惊喜一次
        if now - self.last_any < 180:
            return None

        # 1) Konami
        seq = [n for n, _ in self.konami]
        if len(seq) >= len(_KONAMI) and seq[-len(_KONAMI):] == _KONAMI:
            return ("konami", "这串指令你都记得…", "爱心眼", "shake")

        # 2) 打字暗号（最近 40 个字符里找）
        s = "".join(c for c, _ in self.text)
        for word, (line, expr, act) in _TEXT_EGGS.items():
            if word in s:
                # 同一个暗号 30 分钟内只触发一次
                if now - self.egg_at.get(word, 0) < 1800:
                    continue
                self.egg_at[word] = now
                return (word, line, expr, act)
        return None

    def mark(self):
        self.last_any = time.time()
        self.text = []
        self.konami = []


def _eval(js):
    try:
        import live2d_pet
        return live2d_pet._req("/eval", {"js": js})
    except Exception:
        return None


def _play(pet, line, expr, act, log):
    """做一个小动作：气泡 + 表情 + 身体反应。不发声。"""
    try:
        if pet is not None:
            try:
                pet.bubble(line, 3.5)
            except Exception:
                pass
            try:
                pet.expression(expr, 2600)
            except Exception:
                pass
        if act == "shake":
            _eval("window.__react && window.__react('surprise')")
            _eval("window.__twist && window.__twist()")
        elif act == "pat":
            _eval("window.__react && window.__react('nod')")
        elif act == "laugh":
            _eval("window.__react && window.__react('happy')")
            _eval("window.__twist && window.__twist()")
        elif act == "wave":
            _eval("window.__react && window.__react('shake')")
            _eval("window.__twist && window.__twist()")
        log("彩蛋「%s」触发" % line[:20])
    except Exception as exc:
        log("彩蛋播放失败：%s" % exc)


def keys_loop(stop_event, pet, log):
    """每 60ms 读一次键盘状态；命中暗号就做个小动作。"""
    w = _KeyWatcher()
    while not stop_event.is_set():
        try:
            w.poll()
            hit = w.match()
            if hit:
                name, line, expr, act = hit
                w.mark()
                _play(pet, line, expr, act, log)
        except Exception as exc:
            try:
                log("按键彩蛋出错：%s" % exc)
            except Exception:
                pass
        stop_event.wait(0.06)
