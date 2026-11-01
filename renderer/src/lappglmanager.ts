/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

export let canvas: HTMLCanvasElement = null;
export let gl: WebGLRenderingContext = null;
export let s_instance: LAppGlManager = null;

/**
 * Cubism SDKのサンプルで使用するWebGLを管理するクラス
 */
export class LAppGlManager {
  /**
   * クラスのインスタンス（シングルトン）を返す。
   * インスタンスが生成されていない場合は内部でインスタンスを生成する。
   *
   * @return クラスのインスタンス
   */
  public static getInstance(): LAppGlManager {
    if (s_instance == null) {
      s_instance = new LAppGlManager();
    }

    return s_instance;
  }

  /**
   * クラスのインスタンス（シングルトン）を解放する。
   */
  public static releaseInstance(): void {
    if (s_instance != null) {
      s_instance.release();
    }

    s_instance = null;
  }

  constructor() {
    // キャンバスの作成
    canvas = document.createElement('canvas');

    // glコンテキストを初期化
    // DSH: preserveDrawingBuffer を有効化。カーソル下のピクセルを readPixels で
    // 読んで「キャラの上にいるか」を判定し、透明部分はクリックを素通りさせる。
    // @ts-ignore
    gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });

    if (!gl) {
      // gl初期化失敗
      alert('Cannot initialize WebGL. This browser does not support.');
      gl = null;

      document.body.innerHTML =
        'This browser does not support the <code>&lt;canvas&gt;</code> element.';
    }
  }

  /**
   * 解放する。
   */
  public release(): void {}
}
