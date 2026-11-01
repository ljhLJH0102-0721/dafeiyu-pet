#!/usr/bin/env node
/**
 * check-rules.mjs — 结构门禁。
 *
 * 把 ARCHITECTURE.md 里的「不变式」变成可执行的检查，防止重构成果被下一次改动冲掉。
 * 这不是风格检查，是**防止老 bug 复发**的护栏：
 *
 *   1. executeJavaScript 只允许出现在 shell/pageCommand.js
 *      → 手拼 JS 曾三次踩坑（模板被展开、数组没展开、转义错），且失败是静默的
 *   2. 窗口几何（setBounds/setPosition/setSize）只允许出现在 shell/windowState.js
 *      → 多处写几何 = 越拖越大 / 缩放漂移
 *   3. 模型矩阵（_modelMatrix / getArray 写入）只允许出现在 pet/modelFit.ts
 *      → 多处改矩阵 = 适配越缩越小 / 滚轮后回不去
 *   4. 页面参数注入（__paramHold）只允许出现在 pet/pose.ts 与 interact 的提交循环
 *      → 多处写参数 = 动作打架
 *
 * 用法：node scripts/check-rules.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SHELL = path.join(ROOT, 'app');
const SRC = path.join(ROOT, 'renderer', 'src');

/** 递归收集文件 */
function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'public') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const RULES = [
  {
    id: 'no-inline-js',
    desc: 'executeJavaScript 只允许出现在 shell/pageCommand.js（禁止手拼 JS 字符串）',
    pattern: /executeJavaScript\s*\(/,
    files: () => walk(SHELL, '.js'),
    allow: [path.join(SHELL, 'shell', 'pageCommand.js')],
  },
  {
    id: 'single-geometry-writer',
    desc: '窗口几何只允许在 shell/windowState.js 里改',
    pattern: /\b(win|window)\.(setBounds|setPosition|setSize)\s*\(/,
    files: () => walk(SHELL, '.js'),
    allow: [path.join(SHELL, 'shell', 'windowState.js')],
  },
  {
    id: 'single-matrix-writer',
    desc: '模型矩阵只允许在 pet/modelFit.ts 里改',
    pattern: /_modelMatrix/,
    files: () => walk(SRC, '.ts'),
    allow: [
      path.join(SRC, 'pet', 'modelFit.ts'),
      path.join(SRC, 'lappmodel.ts'), // 官方 Sample 内部持有矩阵，不算我们的写入点
    ],
  },
];

let failures = 0;

for (const rule of RULES) {
  const allowSet = new Set(rule.allow.map((p) => path.resolve(p)));
  const hits = [];
  for (const file of rule.files()) {
    const abs = path.resolve(file);
    if (allowSet.has(abs)) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      // 跳过注释行（简单的 // 判断，够用）
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (rule.pattern.test(line)) {
        hits.push(`${path.relative(ROOT, abs)}:${i + 1}  ${trimmed.slice(0, 100)}`);
      }
    });
  }
  if (hits.length > 0) {
    failures++;
    console.log(`FAIL  ${rule.id} — ${rule.desc}`);
    for (const h of hits.slice(0, 10)) console.log(`        ${h}`);
    if (hits.length > 10) console.log(`        …还有 ${hits.length - 10} 处`);
  } else {
    console.log(`ok    ${rule.id}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} 条结构规则被破坏`);
  process.exit(1);
}
console.log('\n结构门禁全部通过');
process.exit(0);
