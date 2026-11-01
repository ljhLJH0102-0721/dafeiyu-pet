#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh_context.py — 让桌宠"知道你在干什么"。

DSH 会把每个会话的事件以 **zstd 多帧追加** 的方式写到：
    ~/.dsh/sessions/<工作区哈希>/<会话id>/session.v4.jsonl.zstd

这里只做一件事：找到**最近在动、又不是她自己的**那个会话，
从尾部读出最近的事件，拼成一句人话：

    主人现在在做：<工作区>；最近用 pwsh / edit；刚说"……"

给桌宠当上下文，她就能接上你在忙的事，而不是自己臆想。
"""

import json
import os
import time

try:
    import zstandard as zstd
except Exception:  # pragma: no cover
    try:
        from compression import zstd as zstd  # Python 3.14+
    except Exception:
        zstd = None

SESSIONS_DIR = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")
FILE_NAME = "session.v4.jsonl.zstd"


def _iter_frames_text(data):
    """把「多帧追加」的 zstd 数据逐帧解开，返回拼好的文本。

    性能：用帧头魔数切分，每帧单独解压。
    不要用 decompressobj().unused_data 迭代——每次都要复制剩余缓冲区，
    512KB 就要 1.5 秒、6MB 要 13 秒（O(n²)，踩过）。
    """
    if zstd is None or not data:
        return ""

    magic = b"\x28\xb5\x2f\xfd"
    cuts = []
    i = data.find(magic)
    while i >= 0:
        cuts.append(i)
        i = data.find(magic, i + 4)
    if not cuts:
        return ""
    cuts.append(len(data))

    parts = []
    parts = []
    try:
        dec = zstd.ZstdDecompressor()      # zstandard 包
    except Exception:
        dec = None
    for k in range(len(cuts) - 1):
        chunk = data[cuts[k]:cuts[k + 1]]
        if len(chunk) < 8:
            continue
        out = None
        if dec is not None:
            try:
                # zstandard 的 decompress 在帧头没记录内容大小时必须给上限
                out = dec.decompress(chunk, max_output_size=32 * 1024 * 1024)
            except Exception:
                out = None
        if out is None:
            try:
                out = zstd.decompress(chunk)   # 3.14 内置 compression.zstd
            except Exception:
                continue                   # 假帧头或半截帧
        parts.append(out.decode("utf-8", "replace"))
    return "".join(parts)



_CACHE = {"path": None, "at": 0.0}
def find_live_session(exclude_pet=True, ttl=8.0):
    """带缓存：8 秒内不重复遍历（会话目录有几千个）。"""
    now = time.time()
    if _CACHE["path"] and now - _CACHE["at"] < ttl and os.path.exists(_CACHE["path"]):
        return _CACHE["path"]
    p = _scan_live_session(exclude_pet)
    _CACHE["path"] = p
    _CACHE["at"] = now
    return p


def _scan_live_session(exclude_pet=True):
    """找最近被写入的会话文件，返回路径（跳过她的 pet-brain 会话）。"""
    best, best_t = None, 0.0
    try:
        for root, _dirs, files in os.walk(SESSIONS_DIR):
            if FILE_NAME not in files:
                continue
            if exclude_pet and "pet-brain" in root:
                continue
            p = os.path.join(root, FILE_NAME)
            try:
                t = os.path.getmtime(p)
            except OSError:
                continue
            if t > best_t:
                best_t, best = t, p
    except Exception:
        return None
    return best


def _tail_text(path, max_bytes=512 * 1024):
    """读会话日志（只读尾部）。

    性能教训：DSH 会话日志会长到几十 MB、上万帧。**整个文件解压一次要几十秒**，
    而这段代码原来在每次对话的关键路径上——实测让一句话多等了 57 秒
    （模型本身只用了 2.6 秒）。

    现在：文件超过 max_bytes 就只读最后几 MB，并从帧头开始逐帧解；
    解不出内容才退回整份读。
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return ""

    data = b""
    try:
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            data = f.read()
    except Exception:
        return ""

    if size <= max_bytes:
        return _iter_frames_text(data)

    # 大文件：找出所有帧头，从最靠前的、能解出内容的那个帧开始
    magic = b"\x28\xb5\x2f\xfd"
    starts = []
    i = data.find(magic)
    # 只试前几个帧头：第一个通常就是真正的帧边界。
    # 试太多会变成「对每个候选都解压 6MB」，反而慢几十倍（踩过一次）。
    while i >= 0 and len(starts) < 3:
        starts.append(i)
        i = data.find(magic, i + 4)
    for s in starts:
        txt = _iter_frames_text(data[s:])
        if txt and len(txt) > 200:
            return txt
    return _iter_frames_text(data)


def _parts_text(content, prefer=None):
    """从 [{type,text}, ...] 里取文字。prefer='text' 时跳过 reasoning。"""
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    out = []
    for item in content:
        if isinstance(item, str):
            out.append(item)
            continue
        if not isinstance(item, dict):
            continue
        if prefer and item.get("type") and item.get("type") != prefer:
            continue
        t = item.get("text")
        if isinstance(t, str) and t.strip():
            out.append(t.strip())
    return "\n".join(out).strip()


def activity(max_events=600):
    """返回当前活动摘要 dict；取不到就返回 None。

    DSH 的真实事件（v4）：
      session            → cwd
      session/title      → 会话标题
      user/message       → data.content = [{type:'text', text}]
      assistant/message  → data.message.content = [{type:'reasoning'|'text', text}]
      tool/call          → data.name
    """
    path = find_live_session()
    if not path:
        return None
    txt = _tail_text(path)
    if not txt:
        return None

    cwd = ""
    title = ""
    last_user = ""
    last_assistant = ""
    tools = []

    lines = [ln for ln in txt.splitlines() if ln.strip().startswith("{")]

    # 工作区信息在文件**第一行**的 session 事件里，先单独拿一次
    for ln in lines[:5]:
        try:
            ev0 = json.loads(ln)
            if ev0.get("type") == "session":
                cwd = ev0.get("cwd") or cwd
                break
        except Exception:
            continue
    for ln in lines[-max_events:]:
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        t = ev.get("type")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        if t == "session":
            cwd = ev.get("cwd") or cwd
        elif t == "session/title":
            title = d.get("title") or d.get("name") or title
        elif t == "user/message":
            s = _parts_text(d.get("content"))
            # 跳过 DSH 自己注入的时间戳提示
            if s and not s.startswith("Time sampled") and "This is an automatically generated" not in s:
                last_user = s
        elif t == "assistant/message":
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            s = _parts_text(msg.get("content"), prefer="text")
            if s:
                last_assistant = s
        elif t == "tool/call":
            n = d.get("name")
            if isinstance(n, str) and n and n not in tools:
                tools.append(n)

    if not cwd:
        cwd = _cwd_of(path)
    name = os.path.basename(cwd) if cwd else "(未知工作区)"
    return {
        "path": path,
        "cwd": cwd,
        "workspace": name,
        "title": title[:60],
        "last_user": last_user.replace("\n", " ")[:120],
        "last_assistant": last_assistant.replace("\n", " ")[:200],
        "tools": tools[-6:],
        "mtime": os.path.getmtime(path),
    }


_CTX_CACHE = {"line": "", "at": 0.0}
_CWD_CACHE = {}


def _cwd_of(path):
    """工作区信息在文件第一行；单独读开头 128KB，不为此解压整份。"""
    if path in _CWD_CACHE:
        return _CWD_CACHE[path]
    cwd = ""
    try:
        with open(path, "rb") as f:
            head = f.read(128 * 1024)
        magic = b"\x28\xb5\x2f\xfd"
        idx = head.find(magic)
        if idx >= 0:
            txt = _iter_frames_text(head[idx:])
            for ln in txt.splitlines()[:3]:
                if not ln.strip().startswith("{"):
                    continue
                try:
                    ev = json.loads(ln)
                except Exception:
                    continue
                if ev.get("type") == "session":
                    cwd = ev.get("cwd") or ""
                    break
    except Exception:
        pass
    _CWD_CACHE[path] = cwd
    return cwd


def context_line(ttl=20.0):
    """给提示词用的一行中文摘要；没有活动返回空串。"""
    _now = time.time()
    if _CTX_CACHE["line"] and _now - _CTX_CACHE["at"] < ttl:
        return _CTX_CACHE["line"]
    a = activity()
    if not a:
        return ""
    bits = ["主人现在在 **%s** 这个工作区里干活" % a["workspace"]]
    if a["tools"]:
        bits.append("最近用了这些工具：%s" % "、".join(a["tools"]))
    if a["last_user"]:
        bits.append('他刚才说的是："%s"' % a["last_user"].replace("\n", " ")[:80])
    ago = max(0, int(time.time() - a["mtime"]))
    bits.append("（%d 秒前还在动）" % ago if ago < 600 else "（已经 %d 分钟没动了）" % (ago // 60))
    line = "；".join(bits)
    _CTX_CACHE["line"] = line
    _CTX_CACHE["at"] = _now
    return line


if __name__ == "__main__":
    a = activity()
    print("会话:", a["path"] if a else "无")
    if a:
        print("工作区:", a["workspace"])
        print("最近工具:", a["tools"])
        print("他刚说:", a["last_user"][:80])
        print("她刚答:", a["last_assistant"][:80])
    print("\n给提示词的一行:")
    print(" ", context_line() or "(取不到)")
