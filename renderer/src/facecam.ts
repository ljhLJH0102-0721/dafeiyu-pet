/**
 * facecam.ts — 摄像头面部捕捉，驱动 Live2D 角色。
 *
 * 原理：MediaPipe FaceLandmarker 每帧给出
 *   · 52 个表情 blend shape（眨眼、张嘴、微笑、挑眉…）
 *   · 头部姿态矩阵（转头、点头、歪头）
 * 把它们映射成 Cubism 的参数写进 window.__faceHold，
 * lappmodel.ts 每帧提交模型前会套用这些值。
 *
 * 没有摄像头 / 用户不开权限时，start() 会返回错误字符串，不会崩。
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_DIR = 'mediapipe/wasm';
const MODEL_PATH = 'mediapipe/face_landmarker.task';

export interface FaceCamStatus {
  running: boolean;
  ready: boolean;
  error: string;
  fps: number;
  frames: number;
  faceFound: boolean;
  lastBlink: number;
  lastYaw: number;
  lastPitch: number;
  lastRoll: number;
  lastMouth: number;
}

let landmarker: any = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let running = false;
let lastTs = -1;
let frames = 0;
let fps = 0;
let fpsT0 = 0;
let errorText = '';

const stat: FaceCamStatus = {
  running: false,
  ready: false,
  error: '',
  fps: 0,
  frames: 0,
  faceFound: false,
  lastBlink: 0,
  lastYaw: 0,
  lastPitch: 0,
  lastRoll: 0,
  lastMouth: 0,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

async function ensureLandmarker(): Promise<any> {
  if (landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const base = {
    modelAssetPath: MODEL_PATH,
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { ...base, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  } catch (e) {
    // 某些机器 GPU delegate 不可用，退回 CPU
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { ...base, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  }
  stat.ready = true;
  return landmarker;
}

/** 只加载模型（不碰摄像头），用来验证环境是否装好 */
export async function initFaceCam(): Promise<{ ok: boolean; ready?: boolean; error?: string }> {
  try {
    await ensureLandmarker();
    return { ok: true, ready: stat.ready };
  } catch (e: any) {
    errorText = String((e && e.message) || e);
    stat.error = errorText;
    return { ok: false, error: errorText };
  }
}

/** 从 4x4（列主序）旋转矩阵里拆出 yaw/pitch/roll，单位：度 */
function eulerFromMatrix(m: number[]): { yaw: number; pitch: number; roll: number } {
  const r00 = m[0], r01 = m[4], r02 = m[8];
  const r10 = m[1], r11 = m[5], r12 = m[9];
  const r20 = m[2], r21 = m[6], r22 = m[10];
  const yaw = Math.atan2(r02, r22);
  const pitch = Math.atan2(-r12, Math.sqrt(r02 * r02 + r22 * r22));
  const roll = Math.atan2(r10, r00);
  const d = (r: number) => (r * 180) / Math.PI;
  // r01/r20/r21 只用于让 TypeScript 不报未使用
  void r01; void r20; void r21;
  return { yaw: d(yaw), pitch: d(pitch), roll: d(roll) };
}

function blendshapeMap(result: any): Record<string, number> {
  const out: Record<string, number> = {};
  const cats = result && result.faceBlendshapes && result.faceBlendshapes[0];
  if (cats && cats.categories) {
    for (const c of cats.categories) {
      if (c && c.categoryName) out[c.categoryName] = c.score || 0;
    }
  }
  return out;
}

function applyFace(result: any): void {
  const bs = blendshapeMap(result);
  const hasFace = Object.keys(bs).length > 0;
  stat.faceFound = hasFace;

  const hold: Record<string, number> = {};

  if (hasFace) {
    const blinkL = bs['eyeBlinkLeft'] || 0;
    const blinkR = bs['eyeBlinkRight'] || 0;
    hold['ParamEyeLOpen'] = clamp(1 - blinkL * 1.15, 0, 1);
    hold['ParamEyeROpen'] = clamp(1 - blinkR * 1.15, 0, 1);

    const jaw = bs['jawOpen'] || 0;
    hold['ParamMouthOpenY'] = clamp(jaw * 1.6, 0, 1);

    const smileL = bs['mouthSmileLeft'] || 0;
    const smileR = bs['mouthSmileRight'] || 0;
    const smile = (smileL + smileR) / 2;
    hold['ParamMouthForm'] = clamp(smile * 1.6 - 0.2, -1, 1);

    const browIn = bs['browInnerUp'] || 0;
    const browDown = (bs['browDownLeft'] || 0 + (bs['browDownRight'] || 0)) / 2;
    hold['ParamBrowLY'] = clamp(browIn * 1.2 - browDown * 0.8, -1, 1);
    hold['ParamBrowRY'] = hold['ParamBrowLY'];

    const lookX = (bs['eyeLookOutLeft'] || 0) - (bs['eyeLookInLeft'] || 0);
    const lookY = (bs['eyeLookUpLeft'] || 0) - (bs['eyeLookDownLeft'] || 0);
    hold['ParamEyeBallX'] = clamp(lookX * 1.4, -1, 1);
    hold['ParamEyeBallY'] = clamp(lookY * 1.4, -1, 1);

    stat.lastBlink = Math.max(blinkL, blinkR);
    stat.lastMouth = jaw;
  }

  // 头部姿态
  let yaw = 0, pitch = 0, roll = 0;
  const mats = result && result.facialTransformationMatrixes;
  if (mats && mats[0] && mats[0].data && mats[0].data.length >= 16) {
    const e = eulerFromMatrix(mats[0].data as number[]);
    yaw = e.yaw; pitch = e.pitch; roll = e.roll;
  }
  // MediaPipe 的 yaw 方向与 Cubism 相反，这里取反；幅度压低一些更自然
  hold['ParamAngleX'] = clamp(-yaw * 1.6, -30, 30);
  hold['ParamAngleY'] = clamp(pitch * 1.2, -30, 30);
  hold['ParamAngleZ'] = clamp(roll * 1.2, -30, 30);
  hold['ParamBodyAngleX'] = clamp(-yaw * 0.5, -10, 10);
  hold['ParamBodyAngleZ'] = clamp(roll * 0.4, -10, 10);

  stat.lastYaw = yaw;
  stat.lastPitch = pitch;
  stat.lastRoll = roll;

  (window as any).__faceHold = hold;
}

function loop(): void {
  if (!running || !video || !landmarker) return;
  try {
    if (video.readyState >= 2) {
      const ts = Math.max(lastTs + 1, performance.now());
      lastTs = ts;
      const res = landmarker.detectForVideo(video, ts);
      applyFace(res);
      frames++;
      stat.frames = frames;
      const now = performance.now();
      if (!fpsT0) fpsT0 = now;
      else if (now - fpsT0 >= 1000) {
        fps = Math.round((frames * 1000) / (now - fpsT0));
        stat.fps = fps;
        frames = 0;
        fpsT0 = now;
      }
    }
  } catch (e) {
    stat.error = String(e);
  }
  requestAnimationFrame(loop);
}

/**
 * 开始面捕。source 可选（测试时传一个 canvas 流进来，正常留空用摄像头）。
 */
export async function startFaceCam(source?: MediaStream): Promise<{ ok: boolean; error?: string }> {
  stopFaceCam();
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('这个环境没有摄像头接口');
    }
    let s = source;
    if (!s) {
      s = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: false,
      });
    }
    stream = s;

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    document.body.appendChild(video);
    await video.play();

    await ensureLandmarker();
    running = true;
    stat.running = true;
    stat.error = '';
    errorText = '';
    fpsT0 = 0;
    requestAnimationFrame(loop);
    return { ok: true };
  } catch (e: any) {
    errorText = String((e && e.message) || e);
    stat.error = errorText;
    stat.running = false;
    running = false;
    return { ok: false, error: errorText };
  }
}

export function stopFaceCam(): void {
  running = false;
  stat.running = false;
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (e) {}
  stream = null;
  try {
    if (video && video.parentNode) video.parentNode.removeChild(video);
  } catch (e) {}
  video = null;
  (window as any).__faceHold = null;
}

export function faceCamStatus(): FaceCamStatus {
  return { ...stat, error: errorText || stat.error };
}

/** 把接口挂到 window 上，供桌宠外壳调用 */
export function installFaceCam(): void {
  (window as any).__face = {
    start: startFaceCam,
    stop: stopFaceCam,
    status: faceCamStatus,
    init: initFaceCam,
  };
}
