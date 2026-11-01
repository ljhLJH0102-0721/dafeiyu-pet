/**
 * pose.ts 的单元测试。
 *
 * pose 是纯函数，所以可以脱离浏览器直接测——这正是把它抽出来的目的：
 * 以前这些合成逻辑埋在 requestAnimationFrame 里，只能靠肉眼看。
 *
 * 运行：node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require(path.join(__dirname, '..', 'Demo', 'node_modules', 'typescript', 'lib', 'typescript.js'));

const SRC = path.join(__dirname, '..', 'Demo', 'src', 'pet', 'pose.ts');

async function loadPose() {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
  return await import(url);
}

const pose = await loadPose();

function base(over = {}) {
  return {
    t: 0,
    gazeX: 0,
    gazeY: 0,
    onChar: false,
    surprise: 0,
    sleepy: 0,
    swayX: 0,
    gesture: null,
    ...over,
  };
}

test('GAZE 常量把视线幅度固定下来（改这里就能整体调灵敏度）', () => {
  assert.equal(pose.GAZE.angleX, 28);
  assert.equal(pose.GAZE.angleY, 18);
  assert.equal(pose.GAZE.eye, 1.0);
});

test('视线朝右：头部转正、眼球拉满', () => {
  const p = pose.computePose(base({ gazeX: 1 }));
  // 待机会叠 ±2.2° 的正弦，所以给一个容差带
  assert.ok(p['ParamAngleX'] >= 25 && p['ParamAngleX'] <= 31, `AngleX=${p['ParamAngleX']}`);
  assert.equal(p['ParamEyeBallX'], 1);
});

test('视线朝左：头部反转、眼球反向拉满', () => {
  const p = pose.computePose(base({ gazeX: -1 }));
  assert.ok(p['ParamAngleX'] <= -25 && p['ParamAngleX'] >= -31, `AngleX=${p['ParamAngleX']}`);
  assert.equal(p['ParamEyeBallX'], -1);
});

test('视线朝上：Y 轴为负（抬头）', () => {
  const p = pose.computePose(base({ gazeY: 1 }));
  assert.ok(p['ParamAngleY'] <= -15, `AngleY=${p['ParamAngleY']}`);
});

test('不惊讶不困倦时：释放眼睛，交给模型自己眨眼', () => {
  const p = pose.computePose(base());
  assert.equal(p[pose.RELEASE_EYES_KEY], 1);
  assert.equal(p['ParamEyeLOpen'], undefined);
});

test('惊讶：眼睛睁大', () => {
  const p = pose.computePose(base({ surprise: 1 }));
  assert.ok(p['ParamEyeLOpen'] > 1.2, `EyeL=${p['ParamEyeLOpen']}`);
  assert.equal(p[pose.RELEASE_EYES_KEY], undefined);
});

test('困倦：眼睛半闭 + 头往下垂', () => {
  const p = pose.computePose(base({ sleepy: 1 }));
  assert.ok(p['ParamEyeLOpen'] < 0.4, `EyeL=${p['ParamEyeLOpen']}`);
  assert.ok(p['ParamAngleY'] < -4, `AngleY=${p['ParamAngleY']}`);
});

test('小动作的偏移会叠加到头部和身体上', () => {
  const none = pose.computePose(base());
  const withG = pose.computePose(base({ gesture: { dx: 20, dy: 5, dz: 8, body: 10 } }));
  assert.ok(Math.abs(withG['ParamAngleX'] - none['ParamAngleX'] - 20) < 0.001);
  assert.ok(Math.abs(withG['ParamAngleY'] - none['ParamAngleY'] - 5) < 0.001);
  assert.ok(Math.abs(withG['ParamAngleZ'] - none['ParamAngleZ'] - 8) < 0.001);
  assert.ok(Math.abs(withG['ParamBodyAngleX'] - none['ParamBodyAngleX'] - 10) < 0.001);
});

test('摆动弹簧：松手后衰减回中，不会发散', () => {
  let s = { x: 10, v: 0 };
  for (let i = 0; i < 300; i++) {
    s = pose.stepSway(s, { dragging: false, vx: 0 }, 1 / 60);
  }
  assert.ok(Math.abs(s.x) < 0.5, `回中后 x=${s.x.toFixed(3)}`);
});

test('摆动弹簧：被拖动时随速度偏转，且始终被夹在 ±14° 内', () => {
  let s = { x: 0, v: 0 };
  for (let i = 0; i < 120; i++) {
    s = pose.stepSway(s, { dragging: true, vx: 300 }, 1 / 60);
  }
  assert.ok(Math.abs(s.x) <= 14.0001, `x=${s.x} 应被夹住`);
});

test('stepSway 是纯函数：不改入参', () => {
  const s = { x: 5, v: 1 };
  const copy = { ...s };
  pose.stepSway(s, { dragging: false, vx: 0 }, 1 / 60);
  assert.deepEqual(s, copy);
});
