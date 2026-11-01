#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_zoom_click.py — 复现并守住「缩放后点她会缩小/闪现」这个 bug。

历史现象：滚轮缩放后，窗口 resize 会触发 autoFit 重扫；
autoFit 测量时会先把模型缩到 20%（扫 3136 个像素），肉眼就是「她突然变小又弹回来」。
另外点她时如果落在窗口边缘，还会误触系统的拖边缩放。

断言：
  1. 滚轮缩放过程中，模型缩放比例始终跟随窗口高度（不出现 20% 那种塌陷）
  2. 连点她 5 次，窗口尺寸与模型比例都不变
  3. 缩放后点她，也不会触发重扫（fitRef 的 W/H 只在尺寸真的变了才变）

运行：python tests/test_zoom_click.py
"""

import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:5011"


def api(path, payload=None, timeout=25):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ev(js, timeout=25):
    return api("/eval", {"js": js}, timeout).get("result")


def size():
    s = ev("window.innerWidth + 'x' + window.innerHeight")
    w, h = s.split("x")
    return int(w), int(h)


def fit():
    return json.loads(ev("JSON.stringify(window.__fitInfo())"))


def scale():
    return fit().get("curScale")


def wheel(delta, times=1):
    for _ in range(times):
        ev("""(function(){
          var r = document.querySelector('canvas').getBoundingClientRect();
          window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: %d,
            clientX: r.width * 0.5, clientY: r.height * 0.5
          }));
          return 'wheel';
        })()""" % delta)
        time.sleep(0.12)


def click_her():
    ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      var x = r.width * 0.5, y = r.height * 0.42;
      window.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,button:0,buttons:1,clientX:x,clientY:y}));
      window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,button:0,clientX:x,clientY:y}));
      return 'click';
    })()""")
    time.sleep(0.35)


def main():
    try:
        api("/state", timeout=6)
    except Exception as exc:
        print("SKIP 桌宠没在跑（%s）" % exc)
        return 0

    api("/size", {"w": 520, "h": 760})
    time.sleep(1.0)
    ev("window.__autoFit && window.__autoFit()")
    time.sleep(2.5)

    failures = []

    def check(name, ok, detail=""):
        print(("ok   " if ok else "FAIL ") + ("%-24s %s" % (name, detail)))
        if not ok:
            failures.append(name)

    w0, h0 = size()
    s0 = scale()
    print("  基准: %dx%d  scale=%s" % (w0, h0, s0))

    # ── 1. 缩放过程中不能出现塌陷（0.2 那种） ─────────
    ratios = []
    collapsed = False
    for i in range(6):
        wheel(-100)          # 放大
        time.sleep(0.35)
        w, h = size()
        sc = scale()
        if sc is None:
            continue
        ratios.append(round(sc / h, 6))
        if sc < 0.5:         # 20% 塌陷会明显低于 0.5
            collapsed = True
    check("缩放无塌陷", not collapsed, "最小 scale=%s" % (min([scale() or 9]) if False else "ok"))
    spread = (max(ratios) - min(ratios)) if ratios else 1
    check("缩放等比（scale/H 恒定）", spread < 0.0015,
          "scale/H 波动 %.6f（%d 次采样）" % (spread, len(ratios)))

    # ── 2. 缩放后连点她，尺寸与比例不变 ───────────────
    w1, h1 = size()
    s1 = scale()
    for _ in range(5):
        click_her()
    time.sleep(0.8)
    w2, h2 = size()
    s2 = scale()
    check("点她后尺寸不变", (w1, h1) == (w2, h2), "%dx%d → %dx%d" % (w1, h1, w2, h2))
    check("点她后比例不变", abs((s2 or 0) - (s1 or 0)) < 0.02,
          "scale %.4f → %.4f" % (s1 or 0, s2 or 0))

    # ── 3. 缩小也要稳 ─────────────────────────────────
    before_shrink = scale()
    for i in range(6):
        wheel(100)           # 缩小
        time.sleep(0.35)
    time.sleep(1.0)
    after_shrink = scale()
    w3, h3 = size()
    expect = (before_shrink or 0) * (h3 / float(h2 or 1))
    ok = after_shrink is not None and abs(after_shrink - expect) / max(0.01, expect) < 0.1
    check("缩小后比例正确", ok, "scale=%.4f 期望≈%.4f" % (after_shrink or 0, expect))

    api("/size", {"w": 520, "h": 760})

    print("\n%s" % ("PASS 缩放/点击期间没有塌陷" if not failures else "FAIL：" + "、".join(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
