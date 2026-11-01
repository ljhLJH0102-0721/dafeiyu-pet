/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppDelegate } from './lappdelegate';
import * as LAppDefine from './lappdefine';
import { LAppGlManager } from './lappglmanager';
import { LAppLive2DManager } from './lapplive2dmanager';
import { setupInteraction } from './interact';
import { installFaceCam } from './facecam';

// DSH 调试：把应用 / 模型管理器挂到 window，方便直接在控制台读写参数
(window as any).__l2d = () => LAppLive2DManager.getInstance();
(window as any).__model = () => {
  try {
    return LAppLive2DManager.getInstance().getModel(0);
  } catch (e) {
    return null;
  }
};

/**
 * ブラウザロード後の処理
 */
window.addEventListener(
  'load',
  (): void => {
    // Initialize WebGL and create the application instance
    if (
      !LAppGlManager.getInstance() ||
      !LAppDelegate.getInstance().initialize()
    ) {
      return;
    }

    LAppDelegate.getInstance().run();

    // DSH：拖动 / 视线跟随 / 待机动作 / 点击穿透
    try {
      setupInteraction();
    // 摄像头面捕接口（默认不开，由外壳 /camera 控制）
    installFaceCam();
    } catch (e) {
      console.error('[DSH] setupInteraction failed', e);
    }
  },
  { passive: true }
);

/**
 * 終了時の処理
 */
window.addEventListener(
  'beforeunload',
  (): void => LAppDelegate.releaseInstance(),
  { passive: true }
);

/**
 * Process when changing screen size.
 */
window.addEventListener(
  'resize',
  () => {
    if (LAppDefine.CanvasSize === 'auto') {
      LAppDelegate.getInstance().onResize();
    }
  },
  { passive: true }
);
