import type { RaceCard } from '../core/meeting';
import type { SimResult } from '../core/sim';

export interface HorseFrame {
  /** runner index */
  index: number;
  number: number;
  frame: number;
  x: number;
  lane: number;
  v: number;
  /** 現在の順位（1始まり） */
  rank: number;
  finished: boolean;
}

export type CameraMode = 'auto' | 'overview' | 'leaders' | 'follow' | 'finish';

export const CAMERA_LABEL: Record<CameraMode, string> = {
  auto: '自動',
  overview: '全景',
  leaders: '先頭集団',
  follow: '注目馬',
  finish: 'ゴール前',
};

/** 映像の描画部分。2D（Canvas）と3D（three.js）で差し替える */
export interface RaceViewer {
  readonly kind: '2d' | '3d';
  mount(container: HTMLElement): void;
  /** 出走表と走行ログ（発走前は null）を設定 */
  setRace(card: RaceCard, result: SimResult | null): void;
  render(time: number, horses: HorseFrame[]): void;
  setCamera?(mode: CameraMode, followIndex?: number): void;
  resize(): void;
  dispose(): void;
}
