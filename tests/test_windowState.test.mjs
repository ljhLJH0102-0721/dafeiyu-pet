/**
 * windowState 的单元测试（node --test）。
 *
 * 这些正是「越拖越大」「缩放漂移」的根因断言：
 *   · 尺寸夹取保持宽高比、不超过工作区
 *   · 坐标按设备像素对齐（125% 缩放下不漂）
 *   · 拖动中不采信 resize
 *   · ≤2px 抖动不更新基准
 *
 * 运行：node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWindowState } = require('../pet-shell/shell/windowState.js');

/** 假 screen：1920x1080，125% 缩放 */
function fakeScreen(dpr = 1.25) {
  return {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1536, height: 864 }, scaleFactor: dpr }),
  };
}

function makeState(opts = {}) {
  const posPath = path.join(os.tmpdir(), `pettest-${process.pid}-${Math.random()}.json`);
  try { fs.unlinkSync(posPath); } catch (e) {}
  return createWindowState({
    screen: fakeScreen(opts.dpr),
    fs,
    posPath,
    defaults: { width: 520, height: 760 },
    log: () => {},
  });
}

/** 假 BrowserWindow：记录最后一次 setBounds 的结果 */
function fakeWin() {
  const w = { bounds: { x: 0, y: 0, width: 0, height: 0 } };
  w.isDestroyed = () => false;
  w.getBounds = () => ({ ...w.bounds });
  w.setBounds = (b) => { w.bounds = { ...b }; };
  w.setPosition = (x, y) => { w.bounds.x = x; w.bounds.y = y; };
  return w;
}

test('初始尺寸来自 defaults，且是整数', () => {
  const s = makeState();
  const g = s.get();
  assert.equal(g.w, 520);
  assert.equal(g.h, 760);
});

test('夹取：超过工作区时等比缩小，不超界', () => {
  const s = makeState();
  s.setSize(5000, 5000);
  const g = s.get();
  assert.ok(g.w <= 1536 - 20, `宽 ${g.w} 应 <= 1516`);
  assert.ok(g.h <= 864 - 20, `高 ${g.h} 应 <= 844`);
  // 形状恒定：无论请求什么尺寸，宽高比都沿用当前窗口（0.684）
  const ar = g.w / g.h;
  assert.ok(Math.abs(ar - 520 / 760) < 0.01, `宽高比 ${ar.toFixed(3)} 应接近 0.684`);
});

test('夹取：低于下限时等比放大', () => {
  const s = makeState();
  s.setSize(10, 10);
  const g = s.get();
  assert.ok(g.w >= 240 && g.h >= 320);
  assert.ok(Math.abs(g.w / g.h - 520 / 760) < 0.02);
});

test('坐标按设备像素对齐（125% 缩放不漂移）', () => {
  const s = makeState({ dpr: 1.25 });
  const p = s.clampPosition(100.3, 200.7, 520, 760);
  // 1/1.25 = 0.8 的倍数
  assert.equal(Math.round(p.x * 1.25) % 1, 0, `x=${p.x} 应落在物理像素上`);
  assert.equal(Math.round(p.y * 1.25) % 1, 0, `y=${p.y} 应落在物理像素上`);
});

test('拖动中不采信 resize（治越拖越大）', () => {
  const s = makeState();
  const w = fakeWin();
  s.bind(w);
  const r = s.reconcile({ x: 10, y: 10, width: 521, height: 761 }, { dragging: true });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'dragging');
  assert.equal(s.get().w, 520);
  assert.equal(s.get().h, 760);
});

test('≤2px 抖动不更新基准（治正反馈累积）', () => {
  const s = makeState();
  const w = fakeWin();
  s.bind(w);
  for (let i = 0; i < 20; i++) {
    const r = s.reconcile({ x: i, y: i, width: 521, height: 761 }, { dragging: false });
    assert.equal(r.changed, false, `第 ${i} 次抖动不应改基准`);
  }
  assert.equal(s.get().w, 520);
  assert.equal(s.get().h, 760);
});

test('用户真的拖边改尺寸时才更新基准', () => {
  const s = makeState();
  const w = fakeWin();
  s.bind(w);
  const r = s.reconcile({ x: 0, y: 0, width: 600, height: 877 }, { dragging: false });
  assert.equal(r.changed, true);
  assert.equal(s.get().w, 600);
});

test('请求方块尺寸也不改变形状（锁形状）', () => {
  const s = makeState();
  s.bind(fakeWin());
  s.setSize(600, 600);
  const g = s.get();
  const ar = g.w / g.h;
  assert.ok(Math.abs(ar - 520 / 760) < 0.01, `形状应保持 0.684，实际 ${ar.toFixed(3)}`);
});

test('setSize 连调 5 次同一目标 → 只有第一次算变更', () => {
  const s = makeState();
  const w = fakeWin();
  s.bind(w);
  assert.equal(s.setSize(520, 760), false, '与当前相同应返回 false');
  assert.equal(s.setSize(600, 877), true);
  assert.equal(s.setSize(600, 877), false);
  assert.equal(s.setSize(600, 877), false);
});

test('moveTo 一次 setBounds 同时钉住尺寸', () => {
  const s = makeState();
  const w = fakeWin();
  s.bind(w);
  w.bounds = { x: 100, y: 100, width: 531, height: 771 }; // 模拟被 OS 抖动过
  s.moveTo(300, 50);
  assert.equal(w.bounds.width, 520, '尺寸应被钉回基准');
  assert.equal(w.bounds.height, 760);
  assert.equal(w.bounds.x, 300);
  assert.equal(w.bounds.y, 50);
});

test('位置夹取：不会跑出工作区', () => {
  const s = makeState();
  const p = s.clampPosition(-9999, 99999, 520, 760);
  assert.ok(p.x >= 0);
  assert.ok(p.y <= 864 - 760);
});
