/**
 * pose.ts — 姿态的唯一写者。
 *
 * 以前参数写入散在很多地方（视线、手势、困倦、惊讶、表情、面捕），
 * 谁最后写谁生效，顺序不可控 → 偶发卡姿势、动作打架。
 *
 * 现在：这个模块是纯函数，只**计算**目标参数；真正写进模型的地方只有
 * interact 里那一个循环。任何新动作都应该在这里产出偏移，而不是自己调 setParam。
 *
 * 约定：所有角度单位是「度」，所有开闭是 0~1。
 */

/** 手势对头部/身体的偏移（由 gesture.ts 产出） */
export interface GestureOffset {
  dx: number;
  dy: number;
  dz: number;
  body: number;
}

/** 弹簧状态：被拖动时的摆动 */
export interface SwayState {
  x: number;
  v: number;
}

export interface PoseInput {
  /** 从启动到现在的秒数 */
  t: number;
  /** 视线 -1~1 */
  gazeX: number;
  gazeY: number;
  /** 鼠标是否落在她身上（会减小待机摆动幅度） */
  onChar: boolean;
  /** 惊讶 0~1 */
  surprise: number;
  /** 困倦 0~1 */
  sleepy: number;
  /** 当前摆动量 */
  swayX: number;
  /** 当前小动作偏移 */
  gesture: GestureOffset | null;
}

/** 参数名 → 值 */
export type PoseParams = Record<string, number>;

/** 视线/头部的最大幅度（度）。改这里就能整体调灵敏度。 */
export const GAZE = {
  angleX: 28,
  angleY: 18,
  bodyX: 10,
  eye: 1.0,
};

/**
 * 弹簧：被拖动时随速度摆动，松手后阻尼回中。
 * 纯函数，返回新的状态，不改入参。
 */
export function stepSway(
  sway: SwayState,
  input: { dragging: boolean; vx: number },
  dt: number
): SwayState {
  let v = sway.v;
  if (input.dragging) {
    v += (-input.vx * 0.06 - sway.x * 0.12) * 1.0;
  } else {
    v += (-sway.x * 0.25) * 1.0;
  }
  v *= 0.86;
  let x = sway.x + v * dt * 8;
  x = Math.max(-14, Math.min(14, x));
  return { x, v };
}

/**
 * 计算这一帧应有的全部参数。
 * 顺序即优先级：待机 → 视线 → 小动作 → 困倦（困倦会覆盖头部的合成结果）。
 */
export function computePose(input: PoseInput): PoseParams {
  const { t, gazeX, gazeY, onChar, surprise, sleepy, swayX, gesture } = input;

  // 待机摆动：鼠标跟着她时幅度小一点
  const idleAmp = onChar ? 0.6 : 1.0;
  const idleX = Math.sin(t * 0.9) * 2.2 * idleAmp;
  const idleZ = Math.sin(t * 0.63 + 1.1) * 1.6 * idleAmp;

  const g = gesture;
  const params: PoseParams = {};

  // 眼睛：跟着鼠标，再叠惊讶/困倦
  let eyeOpen = 1;
  if (surprise > 0.01) {
    eyeOpen = 1 + surprise * 0.35;
  } else if (sleepy > 0.01) {
    eyeOpen = 1 - sleepy * 0.72;
  }

  if (surprise <= 0.01 && sleepy <= 0.01) {
    // 交还给模型自己的眨眼：调用方负责删掉这两个键
    params['__releaseEyes'] = 1;
  } else {
    params['ParamEyeLOpen'] = eyeOpen;
    params['ParamEyeROpen'] = eyeOpen;
  }

  // 眼球
  params['ParamEyeBallX'] = gazeX * GAZE.eye;
  params['ParamEyeBallY'] = -gazeY * GAZE.eye;

  // 头部/身体：待机 + 视线 + 摆动 + 小动作
  const headX = idleX + gazeX * GAZE.angleX + swayX * 0.4 + (g ? g.dx : 0);
  const headY = -gazeY * GAZE.angleY + (g ? g.dy : 0);
  const headZ = idleZ + swayX + (g ? g.dz : 0);
  const bodyX = gazeX * GAZE.bodyX + swayX * 0.5 + (g ? g.body : 0);

  if (sleepy > 0.01) {
    // 犯困：头往下垂 + 轻微前后晃
    params['ParamAngleX'] = headX;
    params['ParamAngleY'] = -gazeY * 4 - sleepy * 5 + (g ? g.dy : 0);
    params['ParamAngleZ'] = idleZ + swayX + Math.sin(t * 0.5) * sleepy * 2.5 + (g ? g.dz : 0);
    params['ParamBodyAngleX'] = bodyX;
  } else {
    params['ParamAngleX'] = headX;
    params['ParamAngleY'] = headY;
    params['ParamAngleZ'] = headZ;
    params['ParamBodyAngleX'] = bodyX;
  }

  // ── 下半身：裙摆 / 胯部 / 尾鳍 ─────────────────────────────
  // 这个模型（VTube 系）下半身有 60 多个参数，但 physics 的驱动输入全是 0，
  // 所以默认状态下裙子、尾巴一动不动。这里直接给它们加呼吸感的慢摆，
  // 参数写在 paramHold 里 → 在模型 update 之前套用，会盖掉 physics 的 0 值。
  // 幅度都压得很小，避免看起来像在抽搐。
  const slow1 = Math.sin(t * 0.55);
  const slow2 = Math.sin(t * 0.82 + 1.3);
  const slow3 = Math.sin(t * 1.15 + 2.1);
  const breathe = Math.sin(t * 1.6);
  const move = Math.max(-1, Math.min(1, swayX / 6)) * 0.6;   // 被拖动时的惯性

  // 胯：轻微重心变化（角度单位是度，范围 ±30）
  params['HipAngleX'] = (slow1 * 4.2 + move * 5.0) * idleAmp;
  params['HipAngleZ'] = (slow2 * 3.0 + move * 2.5) * idleAmp;
  params['HipAngleYDOWN'] = (breathe * 0.6) * idleAmp;

  // 裙子四片：相位错开，越外层越滞后（看起来像布料跟得上身体）
  const skirtAmp = 0.34;
  params['SkirtX1'] = (slow1 * skirtAmp + move * 0.5) * 0.8;
  params['SkirtX2'] = (Math.sin(t * 0.55 - 0.35) * skirtAmp + move * 0.6) * 0.9;
  params['SkirtX3'] = (Math.sin(t * 0.55 - 0.7) * skirtAmp + move * 0.7) * 1.0;
  params['SkirtX4'] = (Math.sin(t * 0.55 - 1.05) * skirtAmp + move * 0.8) * 1.1;
  params['SkirtY'] = breathe * 0.10;
  params['SkirtY2'] = Math.sin(t * 1.6 - 0.4) * 0.08;
  params['SkirtYBS'] = breathe * 0.06;

  // 裙摆分层：更慢、更小，做出"两层布料"的感觉
  const layerAmp = 0.20;
  for (let i = 1; i <= 3; i++) {
    params['SkirtLayerX' + i] = Math.sin(t * 0.5 - i * 0.22) * layerAmp + move * (0.18 * i);
  }

  // 蕾丝边：只留最外层两条（参数少、效果一样）
  params['LaceX1'] = Math.sin(t * 0.48 - 0.3) * 0.16;
  params['LaceX3'] = Math.sin(t * 0.48 - 0.9) * 0.16;

  // 尾巴（Wing*）：轻轻开合，幅度小但能看出来在动
  params['WingOpenClose'] = 0.16 + breathe * 0.20;
  params['WingSpread'] = 0.10 + slow3 * 0.16;
  params['WingRotation'] = slow2 * 0.18;

  // 鳍/耳（LEar / REar / Flip）：跟着呼吸轻微抖（各留两节就够了）
  for (let i = 1; i <= 2; i++) {
    const k = 0.07 + i * 0.03;
    params['LEar' + i] = Math.sin(t * 1.7 - i * 0.25) * k;
    params['REar' + i] = Math.sin(t * 1.7 - i * 0.25 + 0.5) * k;
  }
  params['LFlip'] = Math.sin(t * 1.1) * 0.05;
  params['RFlip'] = Math.sin(t * 1.1 + 0.4) * 0.05;

  // 胸口：呼吸起伏
  // 身体整体左右重心（配合腹部）
  params['ParamBodyAngleY'] = Math.sin(t * 0.45) * 1.6 * idleAmp;
  params['ChestY1'] = breathe * 0.06;
  params['ChestY2'] = Math.sin(t * 1.6 - 0.3) * 0.05;

  return params;
}

/** 参数名里带这个标记的表示「删除该参数，交还模型自身动画」 */
export const RELEASE_EYES_KEY = '__releaseEyes';
