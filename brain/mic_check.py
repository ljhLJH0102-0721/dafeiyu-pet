#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
mic_check.py —— 麦克风自检

回答三个问题：
  1. 现在这个设备收到的是什么电平？（持续噪声还是安静）
  2. 你说话的时候，电平有没有明显抬起来？（能不能被检测到）
  3. 这段录音转写出来是什么？

用法：
    python mic_check.py                # 录 8 秒
    python mic_check.py 12             # 录 12 秒
    python mic_check.py 8 --device 11  # 指定设备

输出会同时写进 logs/mic_check.log，方便贴出来看。
"""

import array
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

LOG_PATH = os.path.join(HERE, "logs", "mic_check.log")


def log(line):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    text = "[%s] %s" % (stamp, line)
    print(text)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except Exception:
        pass


def rms_of(data):
    a = array.array("h")
    a.frombytes(data)
    if not len(a):
        return 0.0
    return (sum(x * x for x in a) / len(a)) ** 0.5 / 32768.0


def peak_of(data):
    a = array.array("h")
    a.frombytes(data)
    if not len(a):
        return 0.0
    return max(abs(x) for x in a) / 32768.0


def pick_device(pa, wanted=None):
    """默认选和语音桥一样的策略：能打开、默认采样率、名字含麦克风。"""
    if wanted is not None:
        return wanted
    best = None
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if int(info.get("maxInputChannels", 0)) <= 0:
            continue
        name = str(info.get("name", ""))
        if "立体声混音" in name or "混音" in name:
            continue
        if "麦克风" not in name and "Microphone" not in name and "阵列" not in name:
            continue
        try:
            ch = min(2, int(info["maxInputChannels"]))
            sr = int(info.get("defaultSampleRate", 16000))
            st = pa.open(format=8, channels=ch, rate=sr, input=True,
                         input_device_index=i, frames_per_buffer=512)
            st.close()
            best = i
            break
        except Exception:
            continue
    return best


def main():
    seconds = 8
    device = None
    args = sys.argv[1:]
    for k, a in enumerate(args):
        if a == "--device" and k + 1 < len(args):
            device = int(args[k + 1])
        elif a.isdigit():
            seconds = int(a)

    import pyaudio
    pa = pyaudio.PyAudio()
    dev = pick_device(pa, device)
    if dev is None:
        log("找不到可用的麦克风设备")
        return 1
    info = pa.get_device_info_by_index(dev)
    sr = int(info.get("defaultSampleRate", 16000))
    ch = max(1, min(2, int(info.get("maxInputChannels", 1))))
    log("设备 %d：%s  %d Hz  %d ch" % (dev, info.get("name", ""), sr, ch))
    log("开始录 %d 秒 —— 请正常说一句话（比如：大肥鱼，在吗）" % seconds)

    st = pa.open(format=pyaudio.paInt16, channels=ch, rate=sr, input=True,
                 input_device_index=dev, frames_per_buffer=512)
    frames = []
    levels = []
    t0 = time.time()
    next_report = 0.0
    while time.time() - t0 < seconds:
        try:
            data = st.read(512, exception_on_overflow=False)
        except Exception as e:
            log("读取失败：%s" % e)
            break
        frames.append(data)
        r = rms_of(data)
        levels.append(r)
        el = time.time() - t0
        if el >= next_report:
            bar = "#" * int(min(40, r * 120))
            log("  %4.1fs  %.4f  %s" % (el, r, bar))
            next_report = el + 1.0
    st.stop_stream()
    st.close()
    pa.terminate()

    if not levels:
        log("没采到数据")
        return 1
    srt = sorted(levels)
    floor = srt[max(0, int(len(srt) * 0.1))]
    p50 = srt[len(srt) // 2]
    p95 = srt[int(len(srt) * 0.95) - 1] if len(srt) > 20 else srt[-1]
    loud = max(levels)
    log("统计：底噪(p10)=%.4f 中位=%.4f 强峰(p95)=%.4f 最大=%.4f" % (floor, p50, p95, loud))
    if floor > 0.02:
        log("⚠ 底噪很响（%.3f）—— 麦克风可能一直在收环境噪声/风扇/回授，会淹没说话声" % floor)
    ratio = (p95 / floor) if floor > 1e-6 else 0
    log("语音检测比：p95/底噪 = %.1f 倍" % ratio)
    if ratio >= 2.0:
        log("✅ 说话时电平明显抬高，VAD 应该能检测到")
    elif ratio >= 1.3:
        log("⚠ 说话时电平只抬高一点点，容易被噪声淹没（建议关小环境噪声或更换麦克风）")
    else:
        log("❌ 说话声几乎没抬起来 —— 这个输入设备很可能收不到你的声音")

    # 转写
    try:
        import wave as _wave
        import numpy as _np

        import voice_bridge as vb

        wav = os.path.join(HERE, "logs", "mic_check.wav")
        with _wave.open(wav, "wb") as w:
            w.setnchannels(ch)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(b"".join(frames))

        # 原始采样 → 16k 单声道 float
        raw = _np.frombuffer(b"".join(frames), dtype=_np.int16).astype(_np.float32) / 32768.0
        if ch > 1:
            raw = raw.reshape(-1, ch)[:, 0]
        if sr != 16000:
            idx = _np.arange(0, len(raw), sr / 16000.0)
            raw = _np.interp(idx, _np.arange(len(raw)), raw).astype(_np.float32)

        asr = vb.DualAsr(("zh",))
        cfg = vb.load_config()
        try:
            norm = vb.normalize_peak(raw, 0.9)
        except Exception:
            norm = raw
        t0 = time.time()
        den = vb.segment_denoise(norm, cfg)
        den_ms = (time.time() - t0) * 1000
        log("降噪耗时 %.0f ms（这段如果没说话，说明 CPU 白花了）" % den_ms)

        for label, data in (("原声", norm), ("降噪后", den)):
            r = asr.transcribe(data)
            log("%s 转写：%r（%d ms）" % (label, r.get("text", ""), r.get("decode_ms", 0)))
    except Exception as e:
        log("转写失败：%s" % e)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
