/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 *
 * DSH 改动：原始脚本的相对路径是「Demo 放在三层深目录」时的写法
 * （../../../Core、../../Resources），在当前布局下会直接抛 ENOENT，
 * 让 `npm run build` 崩掉。这里改成按 __dirname 解析、源不存在就跳过。
 */

'use strict';
const fs = require('fs');
const path = require('path');

const DEMO = __dirname;

const copies = [
  // Cubism Core（专有文件，不入仓库）
  { src: path.join(DEMO, '..', 'Core'), dst: path.join(DEMO, 'public', 'Core') },
];

for (const e of copies) {
  if (!fs.existsSync(e.src)) {
    console.log('[copy_resources] 跳过（源不存在）: ' + e.src);
    continue;
  }
  try {
    if (fs.existsSync(e.dst)) fs.rmSync(e.dst, { recursive: true, force: true });
    fs.cpSync(e.src, e.dst, { recursive: true });
    console.log('[copy_resources] ' + e.src + ' -> ' + e.dst);
  } catch (err) {
    console.warn('[copy_resources] 拷贝失败 ' + e.src + ': ' + err.message);
  }
}

// Resources 现在就在 public/Resources；外部若还有一份旧目录而 public 没有，才补拷
const extRes = path.join(DEMO, '..', 'Resources');
const pubRes = path.join(DEMO, 'public', 'Resources');
if (fs.existsSync(extRes) && !fs.existsSync(pubRes)) {
  try {
    fs.cpSync(extRes, pubRes, { recursive: true });
    console.log('[copy_resources] ' + extRes + ' -> ' + pubRes);
  } catch (err) {
    console.warn('[copy_resources] 拷贝 Resources 失败: ' + err.message);
  }
}
