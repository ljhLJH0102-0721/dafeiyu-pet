#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_awareness.py — 桌宠感知（轻量版）

设计原则：**只看她该关心的事，不做全窗口轮询**。

以前的做法是每 3 秒枚举前台窗口 + 分类七大八小的进程，
既费 CPU 又会被系统杂窗口（no-errors / Cortana / 桌面壁纸）骗。

现在只做三件事：
  1. 前台是不是 DeepSeek HARNESS 的窗口？   —— 你在跟我说话
  2. 键盘鼠标多久没动了？                   —— 你有没有在
  3. 状态**变化**的时候才反应一次            —— 省钱省力

轮询间隔也放宽到 5 秒（原来 3 秒）。
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time
import urllib.request

API = "http://127.0.0.1:5011"
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pet_awareness.log")

# 你主要用的窗口（进程名里包含任意一个即可）
FOCUS_PROCS = ("deepseek harness", "deepseek-harness")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.GetForegroundWindow.restype = wt.HWND
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


def foreground_info():
    """返回 (进程名小写, 窗口标题)。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return "", ""
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    title = buf.value.strip()

    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    name = ""
    try:
        handle = kernel32.OpenProcess(0x1000, False, pid.value)
        if handle:
            try:
                size = wt.DWORD(1024)
                path = ctypes.create_unicode_buffer(1024)
                if kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                    name = os.path.basename(path.value).lower()
            finally:
                kernel32.CloseHandle(handle)
    except Exception:
        pass
    return name, title


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


def idle_seconds():
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    millis = kernel32.GetTickCount() - info.dwTime
    return max(0.0, millis / 1000.0)


def call(path, payload=None, timeout=2.0):
    try:
        if payload is None:
            req = urllib.request.Request(API + path, method="GET")
        else:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                API + path, data=data, method="POST",
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def react(kind):
    return call("/react", {"kind": kind})


def main():
    once = "--once" in sys.argv
    sleep_after = 300.0     # 5 分钟没动 → 犯困
    poll = 5.0              # 5 秒看一次（原来 3 秒）

    if once:
        proc, title = foreground_info()
        in_focus = any(k in proc for k in FOCUS_PROCS)
        log("前台: %s | %s" % (proc or "?", title[:60]))
        log("在 DeepSeek HARNESS 里: %s，空闲 %.1f 秒" % (in_focus, idle_seconds()))
        log("桌宠: %s" % json.dumps(call("/state"), ensure_ascii=False))
        return

    log("桌宠感知启动（轻量版）：每 %.0f 秒看一次，只关心是否在 DeepSeek HARNESS 里 + 空闲时间" % poll)

    last_state = None      # (in_focus, sleepy)
    sleepy = False

    while True:
        try:
            proc, title = foreground_info()
            in_focus = any(k in proc for k in FOCUS_PROCS)
            idle = idle_seconds()

            if idle >= sleep_after:
                if not sleepy:
                    sleepy = True
                    react("sleep")
                    log("你已经 %.0f 秒没动了，我眯一会儿…" % idle)
            elif sleepy and idle < 3.0:
                sleepy = False
                react("wake")
                log("你回来了，我醒了")

            state = (in_focus, sleepy)
            if state != last_state:
                if last_state is not None and not sleepy:
                    if in_focus:
                        # 回到 DeepSeek HARNESS 跟我说话 → 开心一下
                        react("happy")
                        log("你回到 DeepSeek HARNESS 了（%s）" % title[:40])
                    else:
                        log("你去看别的窗口了（%s）" % (proc or "?"))
                last_state = state

            time.sleep(poll)
        except KeyboardInterrupt:
            log("退出")
            return
        except Exception as exc:
            log("出错: %s" % exc)
            time.sleep(10)


if __name__ == "__main__":
    main()
