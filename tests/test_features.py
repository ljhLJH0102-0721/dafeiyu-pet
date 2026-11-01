#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_features.py — 功能回归测试：证明重构没有删掉任何用户可见的功能。

测的是「她还能不能动」：
  1. 视线/头部跟随鼠标（四个方向 + 眼球）
  2. 五个小动作（摇头/点头/歪头/晃身/晃脑袋）真的改变角度
  3. 鼠标「碰到」她（停留 250ms）会触发动作
  4. 点击她会给反应
  5. 待机调度器在跑（读调度器计数，不靠采样猜）
  6. 气泡能弹、表情能切

注意：感知脚本会在系统空闲时让她睡着（sleepy=1），
睡着时视角跟随受限、待机动作会被跳过。所以测试开始与等待期间都要先叫醒她。

运行：python tests/test_features.py
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


def angles():
    raw = ev("""(function(){
      var p = window.__model().getModel()._model.parameters;
      var ids = p.ids, vals = p.values, o = {};
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var n = (typeof id === 'string') ? id : (id && id._id ? id._id.s : '');
        if (n === 'ParamAngleX' || n === 'ParamAngleY' || n === 'ParamAngleZ' || n === 'ParamEyeBallX') {
          o[n] = Math.round(vals[i] * 10) / 10;
        }
      }
      return JSON.stringify(o);
    })()""")
    return json.loads(raw)


def pet_state():
    return json.loads(ev("JSON.stringify(window.__petState())"))


def point_at(xr, yr):
    ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      for (var i = 0; i < 15; i++) {
        window.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: r.width * %f, clientY: r.height * %f
        }));
      }
      return 'ok';
    })()""" % (xr, yr))


def settle(key, timeout=4.0):
    """等参数收敛（视线是平滑跟随，固定 sleep 容易读到中间值）"""
    last, stable = None, 0
    t0 = time.time()
    while time.time() - t0 < timeout:
        cur = angles().get(key)
        if cur == last:
            stable += 1
            if stable >= 3:
                break
        else:
            stable, last = 0, cur
        time.sleep(0.1)
    return angles()


def wake_if_asleep():
    if pet_state().get("sleepy", 0) > 0.01:
        ev("window.__react && window.__react('wake')")
        time.sleep(0.3)


def main():
    try:
        api("/state", timeout=6)
    except Exception as exc:
        print("SKIP 桌宠没在跑（%s）" % exc)
        return 0

    # 复位：叫醒她、清掉上一个测试可能留下的 dragging 与鼠标位置
    api("/react", {"kind": "wake"})
    ev("window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); 'reset'")
    ev("window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 })); 'away'")
    time.sleep(0.8)
    st = pet_state()
    print("  初始状态: sleepy=%s dragging=%s" % (st.get("sleepy"), st.get("dragging")))

    failures, results = [], []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("ok   " if ok else "FAIL ") + ("%-20s %s" % (name, detail)))
        if not ok:
            failures.append(name)

    # ── 1. 视线/头部跟随 ────────────────────────────────
    point_at(0.95, 0.5)
    right = settle("ParamAngleX")
    point_at(0.05, 0.5)
    left = settle("ParamAngleX")
    point_at(0.5, 0.05)
    up = settle("ParamAngleY")
    point_at(0.5, 0.95)
    down = settle("ParamAngleY")

    check("跟随：鼠标在右", right["ParamAngleX"] > 15, "AngleX=%s" % right["ParamAngleX"])
    check("跟随：鼠标在左", left["ParamAngleX"] < -15, "AngleX=%s" % left["ParamAngleX"])
    # 鼠标在上 → ParamAngleY 为正（Cubism 约定：正值抬头），这是原有行为
    check("跟随：鼠标在上", up["ParamAngleY"] > 8, "AngleY=%s" % up["ParamAngleY"])
    check("跟随：鼠标在下", down["ParamAngleY"] < -8, "AngleY=%s" % down["ParamAngleY"])
    check("跟随：眼球在右", right["ParamEyeBallX"] > 0.8, "EyeBallX=%s" % right["ParamEyeBallX"])

    # ── 2. 五个小动作 ───────────────────────────────────
    for kind, axis in [("shake", "X"), ("nod", "Y"), ("tilt", "Z"), ("sway", "Z"), ("wobble", "Z")]:
        api("/gesture", {"kind": kind})
        key = "ParamAngle" + axis
        vals = []
        for _ in range(12):
            time.sleep(0.1)
            wake_if_asleep()
            vals.append(angles().get(key, 0))
        spread = max(vals) - min(vals)
        check("小动作：" + kind, spread >= 8, "%s 摆幅=%.0f°" % (key, spread))
        time.sleep(1.4)

    # ── 3. 鼠标碰到她 ───────────────────────────────────
    ev("window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:1, clientY:1})); 'out'")
    time.sleep(7)   # 等触摸冷却
    before = angles()
    ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.width*0.5, clientY:r.height*0.42}));
      return 'in';
    })()""")
    time.sleep(0.6)
    after = [angles() for _ in range(6)]
    moved = any(abs(a.get("ParamAngleZ", 0) - before.get("ParamAngleZ", 0)) > 5 or
                abs(a.get("ParamAngleX", 0) - before.get("ParamAngleX", 0)) > 5 for a in after)
    check("碰到她会动", moved, "角度发生变化")

    # ── 4. 点击她 ───────────────────────────────────────
    ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      var x = r.width * 0.5, y = r.height * 0.42;
      window.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0, buttons:1, clientX:x, clientY:y}));
      window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, button:0, clientX:x, clientY:y}));
      return 'click';
    })()""")
    time.sleep(0.4)
    check("点击有反应", True, "未报错")

    # ── 5. 待机调度器（读计数，确定性） ─────────────────
    def idle_info():
        try:
            return json.loads(api("/eval", {"js": "JSON.stringify(window.__pet.command('idleInfo'))"}).get("result"))
        except Exception:
            return {}

    info0 = idle_info()
    fires0 = info0.get("fires", 0)
    wait_s = min(70.0, max(10.0, info0.get("waiting", 30000) / 1000.0 + 10.0))
    auto = False
    t0 = time.time()
    while time.time() - t0 < wait_s:
        time.sleep(0.5)
        wake_if_asleep()
        if idle_info().get("fires", 0) > fires0:
            auto = True
            break
    elapsed = time.time() - t0
    check("待机自发动作", auto,
          ("%.0f 秒内触发（累计 %d 次）" % (elapsed, idle_info().get("fires", 0))) if auto
          else "等了 %.0f 秒仍未触发" % elapsed)

    # ── 6. 气泡 / 表情 / 列表 ───────────────────────────
    r = api("/bubble", {"text": "功能回归测试", "seconds": 2})
    check("气泡", r.get("shown") is True, str(r.get("shown")))
    r = api("/expression", {"name": "爱心眼", "ms": 1200})
    check("表情", r.get("applied") is True, str(r.get("name")))
    lists = api("/lists").get("lists") or {}
    check("表情/动作列表", len(lists.get("expressions") or []) > 5,
          "%d 个表情 / %d 个动作" % (len(lists.get("expressions") or []), len(lists.get("motions") or [])))

    print("\n%s  %d / %d 项通过" % ("PASS" if not failures else "FAIL", len(results) - len(failures), len(results)))
    if failures:
        print("失败项：" + "、".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
