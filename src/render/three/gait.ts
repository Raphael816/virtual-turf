/**
 * 襲歩（ギャロップ）の歩様と脚の逆運動学（IK）。DOM や three.js に依存しない純粋関数。
 *
 * 考え方：
 * - 1完歩の位相 phase（0〜1）を、歩幅に応じた速さで進める
 * - 各脚は「着地（stance）」と「遊脚（swing）」を繰り返す。着地中は蹄を地面に固定し、
 *   体が前に進む分だけ体に対して後ろへ動かす → 世界座標では蹄が滑らない
 * - 膝・飛節の角度は、蹄（球節）の目標位置から2関節IKで逆算する
 */

export type LegId = 'FL' | 'FR' | 'HL' | 'HR';

export interface LegSpec {
  id: LegId;
  fore: boolean;
  /** 体（胴の基準座標）に対する付け根の位置。x: 前方、y: 上方 */
  ax: number;
  ay: number;
  /** 上の骨（前腕／下腿）と下の骨（管骨）の長さ */
  l1: number;
  l2: number;
  /** 球節から蹄底までの高さ */
  pastern: number;
}

export interface GaitTraits {
  /** 歩幅のピッチの個体差（1 ± 0.05 程度） */
  freqScale: number;
  /** 着地時間の割合の個体差（± 0.02 程度） */
  dutyOffset: number;
  /** 手前（右手前なら右の前後肢が後から着地する） */
  lead: 'left' | 'right';
  /** 脚の上げ方の個体差 */
  lift: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v: number) => v - Math.floor(v);

/** 1秒あたりの完歩数。競走速度（約17m/s）で約2.4回 */
export function strideFrequency(v: number, t: GaitTraits): number {
  return clamp(0.85 + 0.092 * v, 0.85, 2.45) * t.freqScale;
}

/** 着地中に蹄が体に対して動ける最大の長さ (m)。脚の長さで決まる */
export const MAX_STANCE_LENGTH = 1.45;

/**
 * 着地時間の割合（デューティ比）。速いほど短い。
 * 着地中に体が進む距離（v × 着地時間）が脚の届く範囲を超えないようにする。
 */
export function dutyFactor(v: number, t: GaitTraits): number {
  const f = strideFrequency(v, t);
  const byReach = (MAX_STANCE_LENGTH * f) / Math.max(v, 0.1);
  return clamp(Math.min(0.62 - 0.025 * v + t.dutyOffset, byReach), 0.15, 0.62);
}

/** 回転襲歩の着地順（位相のずれ）。右手前：左後 → 右後 → 左前 → 右前 */
export function legOffset(id: LegId, t: GaitTraits): number {
  const right = { HL: 0.0, HR: 0.11, FL: 0.31, FR: 0.41 };
  const left = { HR: 0.0, HL: 0.11, FR: 0.31, FL: 0.41 };
  return (t.lead === 'right' ? right : left)[id];
}

export interface FootTarget {
  /** 体に対する蹄の位置（x: 前方, y: 地面からの高さ。体の上下動は呼び出し側で補正） */
  x: number;
  y: number;
  stance: boolean;
  /** 遊脚の進み具合 0〜1（着地中は 0） */
  swing: number;
  /** 着地の進み具合 0〜1（遊脚中は 0） */
  stanceT: number;
  /** この位相で着地したばかりか（蹄跡・砂の跳ね用） */
  justLanded: boolean;
}

/**
 * 位相 phase における蹄の目標位置。
 * prevPhase を渡すと、着地の瞬間（justLanded）を判定する。
 */
export function footTarget(leg: LegSpec, phase: number, prevPhase: number, v: number, t: GaitTraits): FootTarget {
  const neutral = leg.ax + (leg.fore ? 0.06 : 0.12);
  if (v < 0.3) return { x: neutral, y: 0, stance: true, swing: 0, stanceT: 0.5, justLanded: false };
  const f = strideFrequency(v, t);
  const duty = dutyFactor(v, t);
  const off = legOffset(leg.id, t);
  const q = frac(phase - off);
  const qPrev = frac(prevPhase - off);
  const stanceLen = (v * duty) / f; // dutyFactor により MAX_STANCE_LENGTH 以下
  const reach = stanceLen * 0.52;
  const speed = clamp(v / 16, 0, 1);
  if (q < duty) {
    const s = q / duty;
    const justLanded = qPrev > q || qPrev >= duty; // 位相が着地区間に入った
    return { x: neutral + reach - stanceLen * s, y: 0, stance: true, swing: 0, stanceT: s, justLanded };
  }
  const s = (q - duty) / (1 - duty);
  const x0 = neutral + reach - stanceLen;
  const x1 = neutral + reach;
  const e = s * s * (3 - 2 * s);
  // 後肢は蹴り上げてから前へ、前肢は高く折りたたんで前へ
  const kick = (leg.fore ? 0.08 : 0.28) * speed * Math.sin(Math.PI * s) * (1 - s);
  const lift = (leg.fore ? 0.36 : 0.3) * t.lift * (0.35 + 0.65 * speed) * Math.pow(Math.sin(Math.PI * s), 0.85);
  return { x: x0 + (x1 - x0) * e - kick, y: lift, stance: false, swing: s, stanceT: 0, justLanded: false };
}

export interface IKResult {
  /** 上の骨・下の骨の向き（真下を 0 とし、前方 +x 側へ回る角度） */
  a1: number;
  a2: number;
  /** 中間関節（膝・飛節）の位置 */
  jx: number;
  jy: number;
  /** 目標に届いたか（届かない場合は脚を伸ばしきる） */
  reached: boolean;
}

/**
 * 2関節IK（矢状面の2D）。付け根 (ax, ay) から目標 (tx, ty) へ。
 * bend = +1 は関節が前に出る（前肢の膝）、-1 は後ろに出る（後肢の飛節）。
 */
export function solveTwoBone(ax: number, ay: number, tx: number, ty: number, l1: number, l2: number, bend: 1 | -1): IKResult {
  const dx = tx - ax;
  const dy = ty - ay;
  const dist = Math.hypot(dx, dy);
  const maxD = l1 + l2 - 1e-4;
  const minD = Math.abs(l1 - l2) + 1e-4;
  const base = Math.atan2(dx, -dy); // 目標方向（真下 0）
  if (dist >= maxD) {
    // 届かない：目標方向へまっすぐ伸ばす
    return { a1: base, a2: base, jx: ax + l1 * Math.sin(base), jy: ay - l1 * Math.cos(base), reached: dist <= maxD + 1e-3 };
  }
  const d = clamp(dist, minD, maxD);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a1 = base + bend * Math.acos(cosA);
  const jx = ax + l1 * Math.sin(a1);
  const jy = ay - l1 * Math.cos(a1);
  // 実際の目標（届かない場合は方向だけ合わせた点）
  const ex = ax + (dx / (dist || 1)) * d;
  const ey = ay + (dy / (dist || 1)) * d;
  const a2 = Math.atan2(ex - jx, -(ey - jy));
  return { a1, a2, jx, jy, reached: dist <= maxD + 1e-3 };
}
