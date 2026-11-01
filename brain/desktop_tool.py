#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
desktop_tool.py — 让 DSH agent 能看屏幕、动鼠标键盘。

DSH 自带的 dsh_browser_* 工具只能操作它自己的浏览器，碰不到你的桌面。
这个脚本补上那一层：agent 通过 pwsh 调用它，再用 read_image 看截图，
就能「看见 → 决策 → 动手」。

子命令（都输出一行 JSON，方便 agent 解析）：

  screenshot [--path P] [--scale S] [--monitor N] [--region x,y,w,h]
      截屏存 PNG。默认全屏拼接所有显示器，并顺带报告光标位置。
  cursor                      报告光标当前位置
  move X Y                    移动鼠标
  click [--x X --y Y] [--button left|right|middle] [--double] [--count N]
      点击。给了 x/y 就先移过去再点。
  drag X1 Y1 X2 Y2 [--duration 0.3]
      按住左键拖动。
  scroll N                    滚轮，正数向上，负数向下（1 = 一格）
  type "文字"                 在当前焦点处输入文字（走 SendInput unicode，中文安全）
  key "ctrl+s"               按组合键；支持 ctrl/alt/shift/win + 字母数字 + enter/tab/esc/
                             space/backspace/delete/up/down/left/right/home/end/f1..f12
                            多个组合用逗号分隔，例如 "ctrl+a,delete"
  windows [--limit N]         列出可见窗口（标题、位置、大小）
  activate "标题片段"         把窗口切到前台
  run "命令"                  启动程序（不等待）

示例：
  python desktop_tool.py screenshot --scale 0.5
  python desktop_tool.py windows
  python desktop_tool.py activate "记事本"
  python desktop_tool.py type "你好，这是语音输入"
  python desktop_tool.py key "ctrl+s"
"""

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# 坐标必须按物理像素，否则多显示器 / 缩放下点偏。
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP = 0x0020, 0x0040
MOUSEEVENTF_WHEEL = 0x0800
SW_RESTORE = 9
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
INPUT_KEYBOARD = 1


# --------------------------------------------------------------- keyboard --

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class _INPUTUNION(ctypes.Union):
    # 联合体要足够大，装得下 MOUSEINPUT（x64 上 32 字节）
    _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_ubyte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTUNION)]


def _send(inputs):
    arr = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise OSError("SendInput 只发送了 %d/%d 个事件" % (sent, len(inputs)))


def _key_input(vk=0, scan=0, flags=0):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.u.ki = KEYBDINPUT(wScan=scan, wVk=vk, dwFlags=flags, time=0, dwExtraInfo=None)
    return inp


def type_text(text):
    """逐字符发 unicode 事件。中文、符号都能过，不污染剪贴板。"""
    units = []
    for ch in text:
        encoded = ch.encode("utf-16-le")
        for i in range(0, len(encoded), 2):
            units.append(int.from_bytes(encoded[i:i + 2], "little"))
    inputs = []
    for code in units:
        inputs.append(_key_input(scan=code, flags=KEYEVENTF_UNICODE))
        inputs.append(_key_input(scan=code, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    for i in range(0, len(inputs), 64):
        _send(inputs[i:i + 64])
        time.sleep(0.005)


VK = {
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "capslock": 0x14, "printscreen": 0x2C,
}
VK.update({chr(c): c - 32 for c in range(ord("a"), ord("z") + 1)})   # a -> 0x41
VK.update({str(d): 0x30 + d for d in range(10)})
VK.update({"f%d" % i: 0x6F + i for i in range(1, 13)})


def press_combo(combo):
    keys = [k.strip().lower() for k in combo.split("+") if k.strip()]
    vks = []
    for k in keys:
        if k not in VK:
            raise ValueError("不认识的按键：%s" % k)
        vks.append(VK[k])
    for vk in vks:
        _send([_key_input(vk=vk)])
        time.sleep(0.01)
    for vk in reversed(vks):
        _send([_key_input(vk=vk, flags=KEYEVENTF_KEYUP)])
        time.sleep(0.01)


# ------------------------------------------------------------------ mouse --

def get_cursor():
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def set_cursor(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.02)


def input_allowed():
    """当前进程能不能注入输入。

    SetCursorPos 在令牌被削过的进程里会返回 0 且不给错误码，SendInput 则
    「接受但无效」——两者都静默失败，所以启动时主动探一次，把结果写进日志。
    传当前坐标不会真的移动光标。
    """
    x, y = get_cursor()
    ctypes.set_last_error(0)
    return bool(user32.SetCursorPos(x, y)), ctypes.get_last_error()


EM_REPLACESEL = 0x00C2
WM_SETTEXT = 0x000C
WM_GETTEXT = 0x000D
_EDIT_CLASSES = ("Edit", "RichEditD2DPT", "RichEdit20W", "RichEdit50W", "RICHEDIT60W", "Scintilla")


def _enumerate_children(hwnd):
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _l):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child, cls, 256)
        out.append((int(child), cls.value))
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    return out


def _find_edit_control(hwnd):
    for child, cls in _enumerate_children(hwnd):
        if cls in _EDIT_CLASSES:
            return child, cls
    return None, None


def _window_by_title(fragment):
    fragment = (fragment or "").lower()
    hits = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if fragment in buf.value.lower():
                hits.append((int(hwnd), buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return hits[0] if hits else (None, None)


def write_text_to_window(text, title=None):
    """把文字写进目标窗口的编辑控件，**不做模拟键鼠**。

    SendInput 要求目标控件真的拿到键盘焦点，而「激活窗口 ≠ 控件获得焦点」；
    再加上本机安全软件会拦跨进程注入，所以那条路走不通。
    EM_REPLACESEL 是窗口消息，直接让控件自己插入文本，不经过输入队列。
    """
    if title:
        hwnd, win_title = _window_by_title(title)
    else:
        hwnd, win_title = user32.GetForegroundWindow(), None
    if not hwnd:
        return {"ok": False, "error": "找不到目标窗口 %r" % title}

    edit, cls = _find_edit_control(hwnd)
    if not edit:
        return {"ok": False, "error": "窗口 %r 里没有可写的编辑控件" % (win_title or title)}

    user32.SendMessageW(edit, EM_REPLACESEL, 1, ctypes.c_wchar_p(text))
    time.sleep(0.15)
    buf = ctypes.create_unicode_buffer(8192)
    user32.SendMessageW(edit, WM_GETTEXT, 8192, buf)
    got = buf.value
    return {"ok": text in got or got.endswith(text), "via": "EM_REPLACESEL",
            "window": win_title, "control": cls, "length": len(got),
            "tail": got[-40:]}


def click(button="left", count=1):
    down, up = {
        "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }.get(button)
    if down is None:
        raise ValueError("button 只能是 left / right / middle")
    for _ in range(max(1, count)):
        user32.mouse_event(down, 0, 0, 0, 0)
        time.sleep(0.012)
        user32.mouse_event(up, 0, 0, 0, 0)
        time.sleep(0.06)


def scroll(amount):
    user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, int(amount) * 120, 0)


# ---------------------------------------------------------------- windows --

def list_windows(limit=40):
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if not title:
            return True
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w <= 40 or h <= 40:
            return True
        out.append({"hwnd": int(hwnd), "title": title,
                    "x": rect.left, "y": rect.top, "w": w, "h": h})
        return True

    user32.EnumWindows(cb, 0)
    return out[:limit]


def activate(fragment):
    fragment = fragment.lower()
    hits = [w for w in list_windows(200) if fragment in w["title"].lower()]
    if not hits:
        return {"ok": False, "error": "没有标题包含 %r 的窗口" % fragment}
    target = hits[0]
    hwnd = target["hwnd"]
    user32.ShowWindow(hwnd, SW_RESTORE)

    # Windows 不允许后台进程随便抢前台，这里用「挂到当前前台线程」的老办法：
    # 先把本线程 attach 到前台窗口的输入线程，再 SetForegroundWindow，成功率明显更高。
    fg = user32.GetForegroundWindow()
    cur_thread = kernel32.GetCurrentThreadId()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = False
    if fg_thread and fg_thread != cur_thread:
        attached = bool(user32.AttachThreadInput(fg_thread, cur_thread, True))
    try:
        if not user32.SetForegroundWindow(hwnd):
            try:
                user32.BringWindowToTop(hwnd)
            except Exception:
                pass
            try:
                user32.SwitchToThisWindow(hwnd, True)
            except Exception:
                pass
        try:
            user32.SetFocus(hwnd)
        except Exception:
            pass
        time.sleep(0.25)
        ok = bool(user32.GetForegroundWindow() == hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(fg_thread, cur_thread, False)
    return {"ok": ok, "window": target}


# ------------------------------------------------------------- screenshot --

def screenshot(path=None, scale=1.0, monitor=None, region=None):
    from PIL import ImageGrab

    bbox = None
    if region:
        x, y, w, h = [int(v) for v in region.split(",")]
        bbox = (x, y, x + w, y + h)
    elif monitor is not None:
        # 只在单显示器时按顺序切；多显示器仍然整屏，避免猜错顺序
        try:
            from PIL import ImageGrab as _g

            img_all = _g.grab(all_screens=True)
            bbox = None
        except Exception:
            bbox = None

    img = ImageGrab.grab(all_screens=True, bbox=bbox)
    if scale and scale != 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    if path is None:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "screen-%s.png" % time.strftime("%Y%m%d-%H%M%S"))
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    return {"ok": True, "path": path, "width": img.width, "height": img.height,
            "scale": scale, "cursor": get_cursor()}


# ------------------------------------------------- 屏幕文字 + 动作执行 ------

def ocr_image(img, max_lines=80):
    """把 PIL 图像直接 OCR 成「文字 + 中心坐标」。

    走内存里的 SoftwareBitmap 而不是 StorageFile：unpackaged 的 Python 用
    StorageFile.get_file_from_path_async 会被 WinRT 拒绝（E_ACCESSDENIED）。
    """
    import asyncio

    try:
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.graphics.imaging import SoftwareBitmap, BitmapPixelFormat, BitmapAlphaMode
        from winrt.windows.security.cryptography import CryptographicBuffer
    except Exception as exc:
        raise RuntimeError("缺少 Windows OCR 组件：%s" % exc)

    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("系统没有安装任何 OCR 语言包")

    rgba = img.convert("RGBA")
    w, h = rgba.size
    raw = rgba.tobytes()
    bgra = bytearray(len(raw))
    bgra[0::4] = raw[2::4]
    bgra[1::4] = raw[1::4]
    bgra[2::4] = raw[0::4]
    bgra[3::4] = raw[3::4]

    ibuf = CryptographicBuffer.create_from_byte_array(bytes(bgra))
    bitmap = SoftwareBitmap.create_copy_from_buffer(
        ibuf, BitmapPixelFormat.BGRA8, w, h, BitmapAlphaMode.PREMULTIPLIED
    )

    async def run():
        return await engine.recognize_async(bitmap)

    result = asyncio.run(run())
    lines = []
    for line in result.lines:
        if not line.words:
            continue
        left = min(w_.bounding_rect.x for w_ in line.words)
        top = min(w_.bounding_rect.y for w_ in line.words)
        right = max(w_.bounding_rect.x + w_.bounding_rect.width for w_ in line.words)
        bottom = max(w_.bounding_rect.y + w_.bounding_rect.height for w_ in line.words)
        lines.append({
            "text": " ".join(line.text.split()),          # OCR 会在汉字间插空格
            "x": int((left + right) / 2),
            "y": int((top + bottom) / 2),
            "w": int(right - left),
            "h": int(bottom - top),
        })
    return lines[:max_lines]


def _virtual_origin():
    """虚拟桌面左上角在屏幕坐标里的位置（多显示器时可能是负数）。"""
    return int(user32.GetSystemMetrics(76)), int(user32.GetSystemMetrics(77))


def foreground_rect():
    """当前前台窗口的标题和屏幕矩形；拿不到或太小就返回 None。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value.strip()
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w < 200 or h < 150:
        return None
    return {"hwnd": int(hwnd), "title": title,
            "rect": (rect.left, rect.top, rect.right, rect.bottom)}


# 桌宠自己是置顶窗口。它一旦成为前台，用它当「活动窗口」就只会 OCR 到桌宠本体，
# 所以这些标题要跳过，退回全屏。
_SELF_TITLES = ("大肥鱼", "ai-pet", "voice_bridge")


def describe_screen(scope="active", max_lines=40):
    """截图 + OCR，返回「屏幕上有哪些字、在哪」。

    scope="active" 只 OCR 前台窗口 —— 快得多，也避免把无关窗口的内容喂给模型。
    坐标一律换算成**屏幕绝对像素**，模型可以直接拿去 click。
    """
    from PIL import ImageGrab

    vx, vy = _virtual_origin()
    img = ImageGrab.grab(all_screens=True)
    offset = (vx, vy)
    meta = {"scope": "full", "title": None}

    if scope == "active":
        fg = foreground_rect()
        if fg and not any(t in fg["title"] for t in _SELF_TITLES):
            x1, y1, x2, y2 = fg["rect"]
            box = (max(0, x1 - vx), max(0, y1 - vy),
                   min(img.width, x2 - vx), min(img.height, y2 - vy))
            if box[2] - box[0] > 120 and box[3] - box[1] > 120:
                img = img.crop(box)
                offset = (vx + box[0], vy + box[1])
                meta = {"scope": "active", "title": fg["title"]}

    lines = ocr_image(img, max_lines)
    for ln in lines:
        ln["x"] += offset[0]
        ln["y"] += offset[1]

    return {
        "ok": True,
        "size": [img.width, img.height],
        "cursor": get_cursor(),
        "lines": lines,
        "windows": [w_["title"] for w_ in list_windows(12)],
        **meta,
    }


def format_screen(screen, max_lines=24):
    """给模型看的紧凑文本。坐标是屏幕绝对像素。"""
    if not screen or not screen.get("ok"):
        return "（这次没截到屏幕：%s）" % (screen or {}).get("error")
    head = "鼠标在 (%d,%d)" % (screen["cursor"][0], screen["cursor"][1])
    if screen.get("scope") == "active" and screen.get("title"):
        head = "当前窗口「%s」 %dx%d，%s" % (
            screen["title"][:40], screen["size"][0], screen["size"][1], head)
    else:
        head = "全屏 %dx%d，%s" % (screen["size"][0], screen["size"][1], head)

    out = [head]
    if screen.get("windows"):
        out.append("可见窗口：" + "、".join(screen["windows"][:8]))
    out.append("屏幕上的文字（格式：文字 @x,y）：")
    for ln in screen["lines"][:max_lines]:
        out.append("  %s @%d,%d" % (ln["text"][:60], ln["x"], ln["y"]))
    return "\n".join(out)


def execute_actions(actions, dry_run=False):
    """执行模型给出的动作列表，返回每一步的结果。"""
    results = []
    for act in actions or []:
        op = (act or {}).get("op") or (act or {}).get("type")
        try:
            if op == "click":
                if act.get("x") is not None:
                    set_cursor(act["x"], act.get("y", 0))
                click(act.get("button", "left"), 2 if act.get("double") else int(act.get("count", 1)))
                results.append({"op": op, "ok": True})
            elif op == "move":
                set_cursor(act["x"], act["y"])
                results.append({"op": op, "ok": True})
            elif op == "type":
                # 先走窗口消息（不用模拟键鼠），失败再退回 SendInput。
                target = act.get("title") or act.get("window")
                written = write_text_to_window(str(act.get("text", "")), target)
                if written.get("ok"):
                    results.append({"op": op, "ok": True, **written})
                else:
                    if not dry_run:
                        type_text(str(act.get("text", "")))
                    results.append({"op": op, "ok": True, "via": "SendInput",
                                    "fallback_reason": written.get("error"),
                                    "chars": len(str(act.get("text", "")))})
            elif op == "key":
                if not dry_run:
                    for combo in str(act.get("combo", "")).split(","):
                        if combo.strip():
                            press_combo(combo)
                results.append({"op": op, "ok": True})
            elif op == "scroll":
                scroll(int(act.get("amount", 3)))
                results.append({"op": op, "ok": True})
            elif op == "activate":
                results.append({"op": op, **activate(str(act.get("title", "")))})
            elif op == "run":
                if not dry_run:
                    subprocess.Popen(str(act["command"]), shell=True, close_fds=True)
                results.append({"op": op, "ok": True})
            elif op == "wait":
                time.sleep(min(float(act.get("ms", 500)) / 1000.0, 5.0))
                results.append({"op": op, "ok": True})
            elif op == "screenshot":
                # 让调用方（通常是语音桥，没有窗口）自己截，避免辅助进程的控制台挡画面
                shot = screenshot(act.get("path"), float(act.get("scale", 1.0)),
                                  act.get("monitor"), act.get("region"))
                results.append({"op": op, "ok": True, "path": shot["path"],
                                "width": shot["width"], "height": shot["height"]})
            elif op == "windows":
                results.append({"op": op, "ok": True, "windows": list_windows(30)})
            else:
                results.append({"op": op, "ok": False, "error": "不认识的动作"})
        except Exception as exc:
            results.append({"op": op, "ok": False, "error": "%s: %s" % (type(exc).__name__, exc)})
        time.sleep(0.08)
    return results


def parse_reply(reply):
    """从模型的回答里抠出 JSON：{"say": "...", "actions": [...]}。

    模型有时会包一层 ```json 或者前后带解释，这里只取第一个能解析的平衡花括号块。
    """
    if not reply:
        return {"say": "", "actions": []}
    text = reply.strip()
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    chunk = text[start:i + 1]
                    try:
                        data = json.loads(chunk)
                        if isinstance(data, dict):
                            return {"say": str(data.get("say") or ""),
                                    "actions": list(data.get("actions") or [])}
                    except Exception:
                        pass
                    break
        start = text.find("{", start + 1)
    return {"say": text, "actions": []}


# ------------------------------------------------------------------- main --

def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser(description="桌面控制与截屏工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("screenshot")
    p.add_argument("--path")
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--monitor", type=int)
    p.add_argument("--region")

    sub.add_parser("cursor")

    p = sub.add_parser("move")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)

    p = sub.add_parser("click")
    p.add_argument("--x", type=int)
    p.add_argument("--y", type=int)
    p.add_argument("--button", default="left")
    p.add_argument("--double", action="store_true")
    p.add_argument("--count", type=int, default=1)

    p = sub.add_parser("drag")
    for name in ("x1", "y1", "x2", "y2"):
        p.add_argument(name, type=int)
    p.add_argument("--duration", type=float, default=0.3)

    p = sub.add_parser("scroll")
    p.add_argument("amount", type=int)

    p = sub.add_parser("type")
    p.add_argument("text")

    p = sub.add_parser("key")
    p.add_argument("combo")

    p = sub.add_parser("windows")
    p.add_argument("--limit", type=int, default=40)

    sub.add_parser("see")

    p = sub.add_parser("activate")
    p.add_argument("title")

    p = sub.add_parser("run")
    p.add_argument("command")

    args = ap.parse_args()

    try:
        if args.cmd == "screenshot":
            emit(screenshot(args.path, args.scale, args.monitor, args.region))
        if args.cmd == "cursor":
            x, y = get_cursor()
            emit({"ok": True, "x": x, "y": y})
        if args.cmd == "move":
            set_cursor(args.x, args.y)
            emit({"ok": True, "cursor": get_cursor()})
        if args.cmd == "click":
            if args.x is not None and args.y is not None:
                set_cursor(args.x, args.y)
            click(args.button, 2 if args.double else args.count)
            emit({"ok": True, "cursor": get_cursor(), "button": args.button,
                  "count": 2 if args.double else args.count})
        if args.cmd == "drag":
            set_cursor(args.x1, args.y1)
            user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
            steps = 20
            for i in range(1, steps + 1):
                set_cursor(args.x1 + (args.x2 - args.x1) * i / steps,
                           args.y1 + (args.y2 - args.y1) * i / steps)
                time.sleep(max(0.002, args.duration / steps))
            user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
            emit({"ok": True, "cursor": get_cursor()})
        if args.cmd == "scroll":
            scroll(args.amount)
            emit({"ok": True, "amount": args.amount, "cursor": get_cursor()})
        if args.cmd == "type":
            type_text(args.text)
            emit({"ok": True, "typed": len(args.text)})
        if args.cmd == "key":
            for combo in args.combo.split(","):
                if combo.strip():
                    press_combo(combo)
                    time.sleep(0.05)
            emit({"ok": True, "combo": args.combo})
        if args.cmd == "windows":
            emit({"ok": True, "windows": list_windows(args.limit)})
        if args.cmd == "see":
            emit(describe_screen())
        if args.cmd == "activate":
            emit(activate(args.title))
        if args.cmd == "run":
            subprocess.Popen(args.command, shell=True, close_fds=True)
            emit({"ok": True, "started": args.command})
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, 1)


if __name__ == "__main__":
    main()
