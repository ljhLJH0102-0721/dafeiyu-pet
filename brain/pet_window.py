# -*- coding: utf-8 -*-
"""
pet_window.py —— 「她在看你用的是什么软件」

能力边界（实测过）：
  · 读前台窗口标题 / 进程名：**可以**（GetForegroundWindow 这类查询不受限）
  · 模拟鼠标键盘：**被系统拒绝**（所以这里只读不操作）

用途：
  · 主人切到某个软件时，她说一句相关的话（本地台词，0 token）
  · 把「当前在用什么」塞进大脑提示词，聊天时能接上下文

对外：
    foreground()          -> {hwnd, title, exe, pid}
    react_to(exe, title)  -> (台词, 冷却键) 或 None
    describe(exe, title)  -> 一句话描述（给提示词用）
"""

import ctypes
import ctypes.wintypes as wt
import os
import time

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# exe → (称呼, 台词候选)。台词随机挑一句。
APPS = {
    "steam.exe": ("Steam", [
        "又开 Steam 啦，今天想玩点什么呀？",
        "Steam 打开了，是不是要开黑？",
    ]),
    "steamwebhelper.exe": ("Steam", [
        "又开 Steam 啦，今天想玩点什么呀？",
    ]),
    "yuanshen.exe": ("原神", ["要打原神吗？我在这儿陪你～"]),
    "genshinimpact.exe": ("原神", ["要打原神吗？我在这儿陪你～"]),
    "starrail.exe": ("星穹铁道", ["去星穹铁道呀，抽卡记得先洗手～"]),
    "bh3.exe": ("崩坏三", ["崩坏三！今天的体力清了吗？"]),
    "code.exe": ("VS Code", [
        "又在写代码呀，加油～",
        "写累了过来摸一下头也行。",
    ]),
    "cursor.exe": ("Cursor", ["又在写代码呀，加油～"]),
    "devenv.exe": ("Visual Studio", ["在写 C# 呀，编译别又报一堆红字。"]),
    "photoshop.exe": ("Photoshop", ["在画图呀？画好了让我看看。"]),
    "clipstudio.exe": ("Clip Studio", ["在画画呀，今天画什么？"]),
    "chrome.exe": ("Chrome", ["在查什么呀？", "浏览器打开啦，要我帮你查点什么吗？"]),
    "msedge.exe": ("Edge", ["在查什么呀？", "浏览器打开啦，要我帮你查点什么吗？"]),
    "firefox.exe": ("Firefox", ["在查什么呀？"]),
    "wechat.exe": ("微信", ["有人找你聊天吗？"]),
    "weixin.exe": ("微信", ["有人找你聊天吗？"]),
    "qq.exe": ("QQ", ["QQ 打开啦，是不是有人找你？"]),
    "tim.exe": ("TIM", ["在工作呀？"]),
    "cloudmusic.exe": ("网易云音乐", ["听歌呀？放点我喜欢的也行。"]),
    "qqmusic.exe": ("QQ音乐", ["听歌呀？"]),
    "bilibili.exe": ("B站", ["看视频啦？记得别看太久。"]),
    "potplayermini64.exe": ("PotPlayer", ["看电影呀？"]),
    "vlc.exe": ("VLC", ["看电影呀？"]),
    "excel.exe": ("Excel", ["做表格呀，数字别算错了。"]),
    "winword.exe": ("Word", ["写文档呀，慢慢来。"]),
    "powerpnt.exe": ("PowerPoint", ["做 PPT 呀，要帮忙想标题吗？"]),
    "obs64.exe": ("OBS", ["要直播吗？我上镜会紧张的。"]),
    "discord.exe": ("Discord", ["在语音里呀？"]),
    "telegram.exe": ("Telegram", ["在聊天呀？"]),
    "mstsc.exe": ("远程桌面", ["连远程呢。"]),
    "qemu-system-x86_64.exe": ("虚拟机", ["开虚拟机呀。"]),
    "memu.exe": ("模拟器", ["开模拟器啦？"]),
    "explorer.exe": ("文件管理器", None),   # 不给台词，太常见
}

# 只在这些进程名里"说话"（避免每切一个窗口就开口）
_SKIP_ALWAYS = {"explorer.exe", "taskmgr.exe", "searchhost.exe", "shellexperiencehost.exe"}


def _exe_of(pid):
    try:
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return ""
        try:
            size = wt.DWORD(1024)
            buf = ctypes.create_unicode_buffer(1024)
            ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
            if not ok:
                return ""
            return os.path.basename(buf.value)
        finally:
            k32.CloseHandle(h)
    except Exception:
        return ""


def foreground():
    """当前前台窗口。返回 dict；读不到时 hwnd=0。"""
    try:
        hwnd = u32.GetForegroundWindow()
        if not hwnd:
            return {"hwnd": 0, "title": "", "exe": "", "pid": 0}
        n = u32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        u32.GetWindowTextW(hwnd, buf, n + 2)
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return {
            "hwnd": int(hwnd),
            "title": buf.value,
            "exe": _exe_of(pid.value).lower(),
            "pid": int(pid.value),
        }
    except Exception:
        return {"hwnd": 0, "title": "", "exe": "", "pid": 0}


def _pick(exe, title):
    import random
    info = APPS.get(exe)
    if info and info[1]:
        return random.choice(info[1]), info[0]
    # 标题里带关键词也算（有些游戏进程名很怪）
    t = (title or "").lower()
    for key, (label, lines) in APPS.items():
        if not lines:
            continue
        stem = key.split(".")[0]
        if len(stem) > 3 and stem in t:
            return random.choice(lines), label
    return None, None


def react_to(exe, title):
    """要不要为这个窗口说句话。返回 (台词, 称呼) 或 (None, None)。"""
    if not exe or exe in _SKIP_ALWAYS:
        return None, None
    return _pick(exe, title)


def describe(exe, title):
    """给大脑提示词用的一句描述（简短）。"""
    if not exe:
        return ""
    label = (APPS.get(exe) or (None, None))[0]
    if not label:
        label = exe.replace(".exe", "")
    t = (title or "").strip()
    if len(t) > 40:
        t = t[:40] + "…"
    return "%s（窗口标题：%s）" % (label, t) if t else label
