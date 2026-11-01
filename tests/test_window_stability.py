#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_window_stability.py — 窗口几何的集成回归测试。

针对历史上反复出现的两个 bug：
  1. 「越拖越大」：连续拖动后窗口尺寸单调增长
  2. 「缩放漂移」：反复 /size 后尺寸与目标不符

做法：通过桌宠的 /eval 注入合成鼠标事件（mousedown → mousemove → mouseup），
从页面读取 innerWidth/innerHeight，断言：
  · 20 次拖动后，尺寸与基准的偏差 ≤ 4px
  · 尺寸序列不是单调增长
  · /size 连调 3 次同一目标 → 结果稳定

前置：桌宠在跑（/state 可用）。没在跑就跳过（skipped，不算失败）。

运行：
    python tests/test_window_stability.py
"""

import json
import os
import sys
import time
import urllib.request

API = "http://127.0.0.1:5011"
BASE_W, BASE_H = 520, 760
TOL = 4          # 允许的抖动（px）
DRAGS = 20


def api(path, payload=None, timeout=20):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        API + path, data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ev(js, timeout=20):
    return api("/eval", {"js": js}, timeout).get("result")


def page_size():
    s = ev("window.innerWidth + 'x' + window.innerHeight")
    w, h = s.split("x")
    return int(w), int(h)


def drag_once(dx=40, dy=20):
    """一次完整的合成拖动。"""
    ev("""(function(){
      var b = window.innerWidth, h = window.innerHeight;
      var sx = Math.round(window.screenX + b/2), sy = Math.round(window.screenY + h*0.45);
      window.__t = { sx: sx, sy: sy };
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1,
        screenX: sx, screenY: sy, clientX: b/2, clientY: h*0.45 }));
      return 'down';
    })()""")
    steps = 5
    for i in range(steps):
        k = (i + 1) / steps
        ev("""(function(){
          var t = window.__t;
          window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1,
            screenX: t.sx - %d, screenY: t.sy - %d, clientX: 100, clientY: 100 }));
          return 'move';
        })()""" % (round(dx * k), round(dy * k)))
    time.sleep(0.16)
    ev("window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); 'up'")
    time.sleep(0.2)


def main():
    try:
        api("/state", timeout=6)
    except Exception as exc:
        print("SKIP 桌宠没在跑（%s）" % exc)
        return 0

    failures = []

    # 复位到基准
    api("/size", {"w": BASE_W, "h": BASE_H})
    time.sleep(0.5)
    w0, h0 = page_size()
    print("基准尺寸: %dx%d" % (w0, h0))

    sizes = []
    for i in range(DRAGS):
        drag_once()
        sizes.append(page_size())
    print("拖动 %d 次后的尺寸: %s" % (DRAGS, sizes))

    # 断言 1：不累积
    maxdw = max(abs(s[0] - w0) for s in sizes)
    maxdh = max(abs(s[1] - h0) for s in sizes)
    if maxdw > TOL or maxdh > TOL:
        failures.append("尺寸偏差过大：Δw=%d Δh=%d（容差 %d）" % (maxdw, maxdh, TOL))
    else:
        print("OK 尺寸偏差在容差内：Δw=%d Δh=%d" % (maxdw, maxdh))

    # 断言 2：没有累积增长（老 bug 的特征是每次 +1~2px，20 次能涨 20~40px）
    # 注意：判定看「总增长」而不是「是否单调」——偶发的 ±2px 抖动不算回归。
    ws = [s[0] for s in sizes]
    growth = ws[-1] - ws[0]
    if growth > TOL:
        failures.append("尺寸累积增长 %d → %d（涨了 %dpx，越拖越大的特征）" % (ws[0], ws[-1], growth))
    else:
        print("OK 无累积增长（%d → %d，%+d px）" % (ws[0], ws[-1], growth))

    # 断言 3：/size 幂等
    for _ in range(3):
        api("/size", {"w": 600, "h": 877})
        time.sleep(0.3)
    wf, hf = page_size()
    api("/size", {"w": 600, "h": 877})
    time.sleep(0.3)
    wf2, hf2 = page_size()
    if (wf, hf) != (wf2, hf2):
        failures.append("/size 不幂等：%dx%d → %dx%d" % (wf, hf, wf2, hf2))
    else:
        print("OK /size 幂等：%dx%d" % (wf, hf))

    # 复位
    api("/size", {"w": BASE_W, "h": BASE_H})

    if failures:
        print("\nFAIL")
        for f in failures:
            print("  - " + f)
        return 1
    print("\nPASS 窗口几何稳定")
    return 0


if __name__ == "__main__":
    sys.exit(main())
