#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_api_contract.py — 外壳 HTTP API 的契约测试。

为什么需要：这些端点被三处依赖——语音桥（pet_voice.py）、打字插件（dsh-pet-typer）、
自动化脚本。任何一次重构把它们改坏，用户看到的是"她又不说话了"，而日志里什么也没有。

这里逐个打一遍，断言状态码和关键字段。
桌宠没在跑就 SKIP（不算失败）。

运行：python tests/test_api_contract.py
"""

import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5011"

# (路径, payload, 期望状态码, 必须存在的字段)
CASES = [
    ("/state", None, 200, ["ok", "model", "size", "windowOpen"]),
    ("/debug", None, 200, ["ok", "pet", "main"]),
    ("/lists", None, 200, ["ok", "lists"]),
    ("/camera", None, 200, ["ok"]),
    ("/pending", None, 200, ["ok", "text", "clear", "left"]),
    ("/gesture", {"kind": "nod"}, 200, ["ok", "kind", "applied"]),
    ("/expression", {"name": "脸红", "ms": 800}, 200, ["ok", "name", "applied"]),
    ("/motion", {"group": "举手", "no": 0}, 200, ["ok", "group", "applied"]),
    ("/bubble", {"text": "契约测试", "seconds": 1}, 200, ["ok", "shown"]),
    ("/react", {"kind": "happy"}, 200, ["ok", "kind", "applied"]),
    ("/set", {"ParamAngleX": 3}, 200, ["ok", "holding"]),
    ("/mouth", {"open": 0.3}, 200, ["ok", "mouth"]),
    ("/camera", {"on": False}, 200, ["ok", "on"]),
    ("/queue", {"text": "contract"}, 200, ["ok", "queued"]),
    ("/size", {"w": 520, "h": 760}, 200, ["ok", "w", "h"]),
    ("/position", {"x": 880, "y": 90}, 200, ["ok", "x", "y"]),
    ("/interactive", {"on": False}, 200, ["ok", "interactive"]),
    ("/clear", {}, 200, ["ok"]),
    ("/eval", {"js": "1+1"}, 200, ["ok", "result"]),
    ("/log", {"msg": "contract"}, 200, ["ok"]),
    ("/no-such-endpoint", None, 404, ["ok", "error"]),
    # 参数校验分支
    ("/size", {"w": 0, "h": 0}, 400, ["ok", "error"]),
    ("/position", {"x": "abc"}, 400, ["ok", "error"]),
    ("/eval", {"js": ""}, 400, ["ok", "error"]),
]


def call(path, payload, timeout=25):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    method = "POST" if data is not None else "GET"
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}
    except Exception as exc:
        return -1, {"error": str(exc)}


def main():
    try:
        call("/state", None, timeout=6)
    except Exception as exc:
        print("SKIP 桌宠没在跑（%s）" % exc)
        return 0

    failures = []
    for path, payload, want_code, want_fields in CASES:
        code, body = call(path, payload)
        problems = []
        if code != want_code:
            problems.append("状态码 %s != %s" % (code, want_code))
        if not isinstance(body, dict):
            problems.append("响应不是 JSON 对象")
        else:
            for f in want_fields:
                if f not in body:
                    problems.append("缺字段 %r" % f)
        if problems:
            failures.append((path, problems, str(body)[:120]))
            print("FAIL %-20s %s" % (path, "; ".join(problems)))
        else:
            print("ok   %-20s %s" % (path, code))

    if failures:
        print("\n%d / %d 个端点不符合契约" % (len(failures), len(CASES)))
        return 1
    print("\nPASS 全部 %d 个端点符合契约" % len(CASES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
