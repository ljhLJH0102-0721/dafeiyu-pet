/**
 * sfx.ts — 触摸音效（纯 WebAudio 合成，不带音频资源）。
 *
 * 为什么用合成而不是 wav/mp3：
 *   · 开源项目不该塞来源不明的音效文件（授权问题）
 *   · 体积为零、离线可用、改音色只改几个参数
 *
 * 用法：摸她 / 点她 / 被拖动时各来一声，音量与开关由设置界面控制。
 */

export interface SfxOptions {
  enabled: boolean;
  volume: number;
}

export interface Sfx {
  setOptions(next: Partial<SfxOptions>): void;
  /** 轻触（鼠标碰到她） */
  hover(): void;
  /** 点她 */
  click(): void;
  /** 被拎起来 */
  pick(): void;
  /** 放下来 */
  drop(): void;
}

export function createSfx(initial?: Partial<SfxOptions>): Sfx {
  const opt: SfxOptions = { enabled: true, volume: 0.5, ...(initial || {}) };
  let ctx: AudioContext | null = null;

  function audio(): AudioContext | null {
    if (!opt.enabled || opt.volume <= 0) return null;
    try {
      if (!ctx) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    } catch (e) {
      return null;
    }
  }

  /** 一个带包络的短音：freq 起始频率，slide 结束频率，dur 秒 */
  function blip(freq: number, slide: number, dur: number, gain: number, type: OscillatorType): void {
    const ac = audio();
    if (!ac) return;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
    const peak = Math.max(0.0001, gain * opt.volume);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  return {
    setOptions(next: Partial<SfxOptions>): void {
      if (next.enabled != null) opt.enabled = !!next.enabled;
      if (next.volume != null) opt.volume = Math.max(0, Math.min(1, Number(next.volume)));
    },
    hover(): void {
      blip(1180, 1560, 0.07, 0.05, 'sine');
    },
    click(): void {
      blip(760, 1180, 0.11, 0.11, 'triangle');
    },
    pick(): void {
      blip(420, 880, 0.14, 0.10, 'sine');
    },
    drop(): void {
      blip(880, 360, 0.16, 0.10, 'sine');
    },
  };
}
