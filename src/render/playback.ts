/**
 * 走行ログの再生制御。生中継（発走時刻に同期）とリプレイ（速度変更・一時停止・シーク）に対応する。
 */
import type { RaceCard } from '../core/meeting';
import { type SimResult, sampleAt } from '../core/sim';
import type { HorseFrame } from './types';

export class Playback {
  readonly duration: number;
  private samples: { x: number; lane: number; v: number }[] = [];
  private frames: HorseFrame[];
  // リプレイ用の時計
  private replayTime = 0;
  private lastWall = 0;
  speed = 1;
  paused = false;

  constructor(
    readonly card: RaceCard,
    readonly result: SimResult,
  ) {
    this.duration = (result.frames - 1) * result.dt;
    this.frames = card.entries.map((e, i) => ({
      index: i,
      number: e.number,
      frame: e.frame,
      x: 0,
      lane: 0,
      v: 0,
      rank: i + 1,
      finished: false,
    }));
  }

  /** リプレイの時計を進め、現在のレース時刻を返す */
  replayClock(wallMs: number): number {
    if (this.lastWall && !this.paused) {
      this.replayTime = Math.min(this.duration, this.replayTime + ((wallMs - this.lastWall) / 1000) * this.speed);
    }
    this.lastWall = wallMs;
    return this.replayTime;
  }

  seek(t: number) {
    this.replayTime = Math.max(0, Math.min(this.duration, t));
  }

  get time() {
    return this.replayTime;
  }

  /** 時刻 t の各馬の状態と順位 */
  at(t: number): HorseFrame[] {
    sampleAt(this.result, t, this.samples);
    const D = this.card.conditions.distance;
    const ft = this.result.finishTimes;
    this.frames.forEach((f, i) => {
      f.x = this.samples[i].x;
      f.lane = this.samples[i].lane;
      f.v = this.samples[i].v;
      f.finished = t >= ft[i];
    });
    // 入線済みの馬は着順、未入線の馬は走破距離で並べる
    const order = [...this.frames].sort((a, b) => {
      if (a.finished && b.finished) return ft[a.index] - ft[b.index];
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return Math.min(b.x, D) - Math.min(a.x, D);
    });
    order.forEach((f, r) => (f.rank = r + 1));
    return this.frames;
  }

  ranking(t: number): HorseFrame[] {
    return [...this.at(t)].sort((a, b) => a.rank - b.rank);
  }

  leaderRemaining(frames: HorseFrame[]): number {
    const lead = Math.max(...frames.map((f) => f.x));
    return Math.max(0, this.card.conditions.distance - lead);
  }
}

/** 発走前の表示用：全馬をゲートに並べたフレーム */
export function gateFrames(card: RaceCard): HorseFrame[] {
  return card.entries.map((e, i) => ({
    index: i,
    number: e.number,
    frame: e.frame,
    x: 0,
    lane: 0.6 + (e.number - 1) * 1.05,
    v: 0,
    rank: i + 1,
    finished: false,
  }));
}
