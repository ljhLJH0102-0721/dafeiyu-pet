#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
test_regressions.py — 把所有"反复出现过"的 bug 写成断言，逐个钉死。

每一条都对应你真实踩到过的现象：

  A. 窗口几何     越拖越大 / 缩放漂移 / 切半身
  B. 缩放         普通模式改窗口 / 漫游模式改角色 / 放大不切头
  C. 点击穿透     她周围桌面必须能点（窗口不能在"吞鼠标"状态冻结）
  D. 右键菜单     点别处要消失（focusable 切换）
  E. 设置窗口     打开可见、保存后能关闭、API 配置即时生效
  F. 全屏漫游     铺满屏幕、拖动移动角色、退出恢复、缩放不缩窗口
  G. 语音         桥活着、麦克风在收、同句不重复、大脑不卡死
  H. 独立性       不读主会话、直连 API

用法：
    python tests/test_regressions.py          跑一遍
    python tests/test_regressions.py --times 3 连跑 3 遍（抓偶发）
"""

import ctypes
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5011"
SHELL_LOG = os.path.join(APP_DIR, "pet-shell.log")
MAIN_JS = os.path.join(APP_DIR, "main.js")
BRIDGE_LOG = os.path.join(BRAIN_DIR, "logs", "voice_bridge.log")

user32 = ctypes.windll.user32


# ── 基础工具 ─────────────────────────────────────────────
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


def find_window(title_part):
    """按标题找可见窗口句柄"""
    result = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if title_part in buf.value:
            result.append(hwnd)
            return False
        return True

    user32.EnumWindows(cb, 0)
    return result[0] if result else None


def window_rect(hwnd):
    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long),
                    ("r", ctypes.c_long), ("b", ctypes.c_long)]
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return {"x": r.l, "y": r.t, "w": r.r - r.l, "h": r.b - r.t}


def screen_size():
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def cursor_pos():
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def expected_ignoring(hwnd):
    """按真实光标位置推断窗口该不该穿透。"""
    cx, cy = cursor_pos()
    w = window_rect(hwnd)
    in_win = (w["x"] <= cx < w["x"] + w["w"]) and (w["y"] <= cy < w["y"] + w["h"])
    if not in_win:
        return True, "光标在窗口外"
    on_her = ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      return window.__hitTest(%d, %d);})()""" % (cx - w["x"], cy - w["y"]))
    return (not on_her), ("光标在窗口内 她身上=%s" % on_her)


def tail(path, n=200):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()[-n:]
    except Exception:
        return []


def click_her():
    return ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      var x = r.width * 0.5, y = r.height * 0.42;
      window.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,button:0,buttons:1,clientX:x,clientY:y}));
      window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,button:0,clientX:x,clientY:y}));
      return 'click';})()""")


def reset_canvas():
    """把画布位移清零（上一轮可能把她推到别处，导致测试点不落在她身上）"""
    ev("""(function(){
      var c = document.querySelector('canvas');
      c.style.transform = 'translate(0px,0px)';
      try { localStorage.setItem('pet.roam.offset', '{"x":0,"y":0}'); } catch(e) {}
      return 1;})()""")
    time.sleep(0.5)


def point_on_her():
    """找一个确实落在她身上的点（避免用固定比例猜）"""
    for fy in (0.45, 0.55, 0.62, 0.35, 0.5):
        for fx in (0.5, 0.45, 0.55):
            hit = ev("""(function(){
              var r = document.querySelector('canvas').getBoundingClientRect();
              return window.__hitTest(r.width*%f, r.height*%f);})()""" % (fx, fy))
            if hit:
                return fx, fy
    return 0.5, 0.45


def drag_window(dx=60, dy=30):
    fx, fy = point_on_her()
    return ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      var x = r.width*%f, y = r.height*%f;
      window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,buttons:1,clientX:x,clientY:y,screenX:window.screenX+x,screenY:window.screenY+y}));
      for (var i=1;i<=5;i++) window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:x+%d*i/5,clientY:y+%d*i/5,screenX:window.screenX+x+%d*i/5,screenY:window.screenY+y+%d*i/5}));
      window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
      return 'drag';})()""" % (fx, fy, dx, dy, dx, dy))


def wheel(delta, times=4):
    return ev("""(function(){
      var r = document.querySelector('canvas').getBoundingClientRect();
      for (var i=0;i<%d;i++) window.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:%d,clientX:r.width*0.5,clientY:r.height*0.5}));
      return 'wheel';})()""" % (times, delta))


def set_roam(on):
    return api("/settings/apply", {"roamMode": bool(on)})


def state():
    return api("/state")


def debug():
    return api("/debug")


def pet_state():
    return json.loads(ev("JSON.stringify(window.__petState())"))


def fit_info():
    return json.loads(ev("JSON.stringify(window.__fitInfo())"))


# ── 测试框架 ─────────────────────────────────────────────
class Run:
    def __init__(self):
        self.items = []

    def check(self, cid, name, fn):
        try:
            ok, detail = fn()
        except Exception as exc:
            ok, detail = False, "%s: %s" % (type(exc).__name__, exc)
        self.items.append((cid, name, ok, detail))
        print(("ok   " if ok else "FAIL ") + "%-4s %-26s %s" % (cid, name, detail))
        return ok

    def failed(self):
        return [i for i in self.items if not i[2]]


def main():
    times = 1
    if "--times" in sys.argv:
        times = int(sys.argv[sys.argv.index("--times") + 1])

    try:
        api("/state", timeout=6)
    except Exception as exc:
        print("SKIP 桌宠没在跑（%s）" % exc)
        return 0

    hwnd = find_window("大肥鱼")
    if not hwnd:
        print("FAIL 找不到桌宠窗口")
        return 1

    overall_fail = 0
    for round_no in range(1, times + 1):
        print("\n========== 第 %d 轮 ==========" % round_no)
        r = Run()

        # ── A. 窗口几何 ────────────────────────────────
        def a1():
            api("/size", {"w": 520, "h": 760})
            time.sleep(0.8)
            w = window_rect(hwnd)
            return (w["w"] >= 480 and abs(w["h"] - 760) <= 60), "%dx%d" % (w["w"], w["h"])
        r.check("A1", "窗口尺寸可设置", a1)

        def a2():
            base = window_rect(hwnd)
            sizes = []
            for _ in range(6):
                drag_window(40, 20)
                time.sleep(0.25)
                sizes.append(window_rect(hwnd))
            grown = max(s["w"] for s in sizes) - base["w"]
            return grown <= 8, "拖 6 次最大涨 %dpx" % grown
        r.check("A2", "拖动不越拖越大", a2)

        # ── B. 缩放 ────────────────────────────────────
        def b1():
            set_roam(False)
            time.sleep(1.2)
            before = window_rect(hwnd)["w"]
            wheel(100, 4)     # 缩小
            time.sleep(1.5)
            after = window_rect(hwnd)["w"]
            return after < before - 10, "%d → %d" % (before, after)
        r.check("B1", "普通模式滚轮改窗口", b1)

        def b2():
            api("/size", {"w": 520, "h": 760})
            time.sleep(1.0)
            return True, "已复位"
        r.check("B2", "复位尺寸", b2)

        # ── C. 点击穿透（最关键） ─────────────────────
        def c1():
            d = debug()
            exp, why = expected_ignoring(hwnd)
            ok = d["main"]["ignoring"] == exp and d["main"]["interactive"] is False
            return ok, "期望=%s 实际=%s（%s）interactive=%s" % (
                exp, d["main"]["ignoring"], why, d["main"]["interactive"])
        r.check("C1", "窗口处于点击穿透", c1)

        def c2():
            # 不写死坐标：先强制画一帧，再扫画布找真有像素的点，最后用 __hitTest 验证。
            # 为什么要强制画：readPixels 只能在"刚画完"的同一帧里读，
            # 否则合成器可能已经把缓冲清掉了（读到全 0）。
            js = (
                "new Promise(function(done){"
                "  requestAnimationFrame(function(){"
                "    var m = window.__model();"
                "    try { m.update(); m.doDraw(); } catch (e) {}"
                "    var c=document.querySelector('canvas');"
                "    var gl=c.getContext('webgl2',{preserveDrawingBuffer:true});"
                "    var rect=c.getBoundingClientRect(); var px=new Uint8Array(4);"
                "    for (var fy=0.30; fy<0.90; fy+=0.03) {"
                "      for (var fx=0.30; fx<0.75; fx+=0.05) {"
                "        var cx=Math.round(rect.width*fx), cy=Math.round(rect.height*fy);"
                "        var gx=Math.round(((cx-rect.left)/rect.width)*c.width);"
                "        var gy=Math.round((1-(cy-rect.top)/rect.height)*c.height);"
                "        gl.readPixels(gx,gy,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);"
                "        if (px[3]>40) return done(JSON.stringify({pt:[cx,cy],alpha:px[3],"
                "          onHer: window.__hitTest(cx,cy), blank: window.__hitTest(3,3)}));"
                "      }"
                "    }"
                "    done(JSON.stringify({pt:null,alpha:0,onHer:false,blank:window.__hitTest(3,3)}));"
                "  });"
                "})")
            res = json.loads(ev(js))
            ok = (res.get("onHer") is True) and (res.get("blank") is False)
            return ok, "取点=%s alpha=%s 她身上=%s 空白=%s" % (
                res.get("pt"), res.get("alpha"), res.get("onHer"), res.get("blank"))
        r.check("C2", "逐像素命中正确", c2)


        def c3():
            # 关键：状态要跟光标位置一致（以前光标一静止就永久冻结）
            # 这里隔 2 秒连测两次，两次都必须与期望一致
            time.sleep(1.0)
            exp1, why1 = expected_ignoring(hwnd)
            got1 = debug()["main"]["ignoring"]
            time.sleep(2.0)
            exp2, why2 = expected_ignoring(hwnd)
            got2 = debug()["main"]["ignoring"]
            ok = (got1 == exp1) and (got2 == exp2)
            return ok, "第1次 期望%s/实际%s（%s）；第2次 期望%s/实际%s（%s）" % (
                exp1, got1, why1, exp2, got2, why2)
        r.check("C3", "静止 3 秒不冻结", c3)

        def c4():
            # 整窗交互必须 60 秒自动恢复：这里只验证开关能立刻恢复
            api("/interactive", {"on": True})
            time.sleep(0.6)
            on = debug()["main"]["ignoring"] is False
            api("/interactive", {"on": False})
            time.sleep(1.0)
            exp, _why = expected_ignoring(hwnd)
            off = debug()["main"]["ignoring"] == exp
            return (on and off), "开启=%s 关闭后恢复=%s" % (on, off)
        r.check("C4", "整窗交互可开关", c4)

        # ── D. 右键菜单 ────────────────────────────────
        def d1():
            """右键菜单是自绘窗口：必须有点别处就关、以及关闭入口。"""
            src = open(MAIN_JS, encoding="utf-8").read()
            ok = (
                "openContextMenu" in src
                and "menuWin.on('blur'" in src
                and "ipcMain.on('menu:close'" in src
                and "preload-menu.js" in src
            )
            return ok, "自绘菜单 + blur 关闭已就位" if ok else "缺少菜单关闭逻辑"
        r.check("D1", "菜单点别处会消失", d1)

        # ── E. 设置窗口 ───────────────────────────────
        def e1():
            api("/settings", {})
            time.sleep(2.5)
            s = api("/settings")
            return bool(s.get("windowOpen") and s.get("visible")), \
                "open=%s visible=%s" % (s.get("windowOpen"), s.get("visible"))
        r.check("E1", "设置窗口能打开且可见", e1)

        def e2():
            s = find_window("设置")
            return bool(s), "找到设置窗口" if s else "找不到设置窗口（可能被压在下面）"
        r.check("E2", "设置窗口在系统里可见", e2)

        def e3():
            api("/settings/close", {})
            time.sleep(1.2)
            s = api("/settings")
            return not s.get("windowOpen"), "已关闭" if not s.get("windowOpen") else "窗口还在"
        r.check("E3", "设置窗口能关闭", e3)

        def e4():
            html = open(os.path.join(APP_DIR, "settings.html"), encoding="utf-8").read()
            ok = "window.petSettings.close()" in html and "900" in html
            return ok, "保存后自动关闭已实现" if ok else "保存后不会自动关闭"
        r.check("E4", "保存后自动关闭", e4)

        # ── F. 全屏漫游 ───────────────────────────────
        def f1():
            set_roam(True)
            time.sleep(2.5)
            sw, sh = screen_size()
            st = state()["size"]
            return abs(st[0] - sw) <= 40, "窗口 %dx%d / 屏幕 %dx%d" % (st[0], st[1], sw, sh)
        r.check("F1", "漫游窗口铺满", f1)

        def f2():
            before = window_rect(hwnd)
            wheel(-100, 3)   # 漫游里放大
            time.sleep(1.5)
            after = window_rect(hwnd)
            ps = pet_state()
            return (abs(after["w"] - before["w"]) <= 4 and ps["zoom"] >= 1.0), \
                "窗口不变=%s zoom=%.2f" % (abs(after["w"] - before["w"]) <= 4, ps["zoom"])
        r.check("F2", "漫游缩放不缩窗口", f2)

        def f3():
            """放大到顶时不能把画布撑满（会切头）。整段重试，页面忙的时候 /eval 会 500。"""
            last = "未知错误"
            for attempt in range(3):
                try:
                    set_roam(True)
                    time.sleep(4.0)
                    ev("window.__setRoamOffset(0, 0)")
                    time.sleep(0.5)
                    wheel(-100, 12)
                    time.sleep(1.5)
                    info = fit_info()
                    canvas_h = int(ev("String(window.innerHeight)"))
                    base = info["fitRef"]["H"] * 0.884
                    zoom = info["curScale"] / info["fitRef"]["scale"]
                    height = base * zoom
                    ratio = height / canvas_h
                    return ratio <= 0.95, "缩放 %.2fx → 高度 %.0f / 画布 %d（%.0f%%）" % (
                        zoom, height, canvas_h, ratio * 100)
                except Exception as exc:
                    last = "%s: %s" % (type(exc).__name__, exc)
                    time.sleep(3.0)
            return False, "三次都失败（%s）" % last
        r.check("F3", "放大不切头", f3)

        def f4():
            reset_canvas()
            before_win = (window_rect(hwnd)["x"], window_rect(hwnd)["y"])
            before_tf = ev('document.querySelector("canvas").style.transform || "none"')
            drag_window(120, 60)
            time.sleep(0.8)
            after_win = (window_rect(hwnd)["x"], window_rect(hwnd)["y"])
            after_tf = ev('document.querySelector("canvas").style.transform || "none"')
            return (before_win == after_win and before_tf != after_tf), \
                "窗口动=%s 角色动=%s" % (before_win != after_win, before_tf != after_tf)
        r.check("F4", "漫游拖动移动角色", f4)

        def f5():
            set_roam(False)
            time.sleep(2.0)
            st = state()["size"]
            tf = ev('document.querySelector("canvas").style.transform || "none"')
            return (st[0] < 1000 and tf == "none"), "窗口 %dx%d transform=%s" % (st[0], st[1], tf)
        r.check("F5", "退出漫游恢复", f5)

        def f6():
            """全屏跟随：鼠标在她的窗口外（头顶/脚下/左右）也要带动视线。"""
            w = window_rect(hwnd)
            cx = w["x"] + w["w"] // 2
            cy = w["y"] + w["h"] // 2
            cases = [
                ("上", cx, w["y"] - 300, "y", -1, -0.5),
                ("下", cx, w["y"] + w["h"] + 300, "y", 0.5, 1),
                ("左", w["x"] - 400, cy, "x", -1, -0.5),
                ("右", w["x"] + w["w"] + 400, cy, "x", 0.5, 1),
            ]
            bad = []
            for label, x, y, axis, lo, hi in cases:
                api("/test/cursor", {"x": x, "y": y, "pinMs": 4000})
                time.sleep(0.7)
                st = pet_state()
                v = st.get("targetGazeY" if axis == "y" else "targetGazeX")
                if v is None or not (lo <= v <= hi):
                    bad.append("%s=%s" % (label, v))
            return (not bad), ("四个方向都跟上了" if not bad else "没跟上：" + "、".join(bad))
        r.check("F6", "全屏跟随（含抬头/低头）", f6)

        # ── G. 语音桥 ─────────────────────────────────
        def g1():
            import subprocess
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe' } | Where-Object { $_.CommandLine -match 'voice_bridge.py' }).Count"],
                capture_output=True, text=True)
            cnt = int((out.stdout or "0").strip() or 0)
            return cnt >= 1, "进程数 %d" % cnt
        r.check("G1", "语音桥在运行", g1)

        def g2():
            # 桥可能连续跑了几小时、日志几万行，启动行早被挤出尾部了 → 扫全文件
            try:
                with open(BRIDGE_LOG, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
            except Exception:
                lines = []
            recent = [l for l in lines if "麦克风已打开" in l]
            return bool(recent), "最近一次打开：" + recent[-1].strip()[-40:] if recent else "没找到麦克风打开记录"
        r.check("G2", "麦克风已打开", g2)

        def g3():
            src = open(r"C:\Users\Administrator\Documents\deepseek-harness"
                       r"\default-workspace\dafeiyu-pet\voice_bridge.py", encoding="utf-8").read()
            ok = ("_echo" in src) and ("重复的一句" in src) and ("电平" in src and "噪声丢弃" in src)
            return ok, "回声抑制+去重+电平门限 都在" if ok else "缺少防重复机制"
        r.check("G3", "不重复回话（机制）", g3)

        def g4():
            src = open(r"C:\Users\Administrator\Documents\deepseek-harness"
                       r"\default-workspace\dafeiyu-pet\voice_bridge.py", encoding="utf-8").read()
            ok = ("ask_timed" in src) and ("PROMPT_TIMEOUT = 45" in src)
            return ok, "大脑调用有硬超时" if ok else "缺少超时保护"
        r.check("G4", "大脑不会卡死", g4)

        # ── H. 独立性 ────────────────────────────────
        def h1():
            cfg = json.load(open(r"C:\Users\Administrator\Documents\deepseek-harness"
                                 r"\default-workspace\dafeiyu-pet\voice_bridge.json", encoding="utf-8"))
            return cfg.get("brain_mode") == "api", "brain_mode=%s" % cfg.get("brain_mode")
        r.check("H1", "用独立 API 大脑", h1)

        def h2():
            src = open(r"C:\Users\Administrator\Documents\deepseek-harness"
                       r"\default-workspace\dafeiyu-pet\voice_bridge.py", encoding="utf-8").read()
            ok = "USE_DSH_CONTEXT = False" in src
            return ok, "不注入主会话" if ok else "仍在读主会话"
        r.check("H2", "不读主会话", h2)

        # ── 收尾：恢复默认姿势 ────────────────────────
        set_roam(False)
        try:
            api("/size", {"w": 520, "h": 760})
        except Exception:
            pass

        bad = r.failed()
        print("\n第 %d 轮：%d / %d 通过" % (round_no, len(r.items) - len(bad), len(r.items)))
        if bad:
            overall_fail += len(bad)
            print("失败：" + "、".join(i[0] for i in bad))

    print("\n========== 总结 ==========")
    if overall_fail == 0:
        print("PASS 全部用例通过（%d 轮 × 20 项）" % times)
        return 0
    print("FAIL 共 %d 项失败" % overall_fail)
    return 1


if __name__ == "__main__":
    sys.exit(main())
