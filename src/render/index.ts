import type { RaceViewer } from './types';
import { Viewer2D } from './viewer2d';

/** 表示設定と端末の対応状況から映像の描画方式を選ぶ（3D は Step 5 で追加） */
export function createViewer(_pref: '3d' | '2d'): RaceViewer {
  return new Viewer2D();
}
