/**
 * 競走馬の生涯（第3段階）：成長曲線・疲労・調子・故障・引退・新しい世代。
 *
 * すべて週単位の決まった乱数（年・週・馬のID から作る）で進むので、同じ経過からは同じ競馬界になる。
 * 数値の多くは推定値（docs/08-lifecycle.md に根拠と目安を記載）。
 *
 * - 成長：馬ごとに「能力の上限（ピーク時の能力）」を持ち、現在の能力 = 上限 × 成長曲線（年齢・成長型・成長力）
 *   早熟は3歳前後、普通は4〜5歳、晩成は5〜6歳がピーク。ピーク後はスピード・瞬発力から先に衰える
 * - 疲労：身体的疲労（レースの距離・馬場・健康で増え、週ごとに回復）と精神的疲労（レース・掛かりで増える）
 * - 調子：馬ごとの周期（10〜16週）の波に、疲労と休養明けの影響を加える。発揮できる能力への影響は小さく抑える
 * - 故障：レース後に、疲労・健康・年齢・馬場で決まる確率で発生（軽度・中度・重度）。治療・休養のあと復帰し、重度は能力が落ちる
 * - 引退：年明けに年齢・成績・故障から判断。毎年2歳の新しい世代が加わり、現役の頭数を保つ
 */
import type { Horse } from '../data/roster';
import type { GrowthType } from './ability';
import { Rng } from './rng';

/** 成長で変わる能力 */
export const GROWTH_KEYS = ['speed', 'stamina', 'accel', 'sustain', 'power'] as const;
export type GrowthKey = (typeof GROWTH_KEYS)[number];
export type Potential = Record<GrowthKey, number>;

export type InjurySeverity = 'minor' | 'moderate' | 'severe';
export const INJURY_LABEL: Record<InjurySeverity, string> = { minor: '軽度', moderate: '中度', severe: '重度' };

export interface Injury {
  name: string;
  severity: InjurySeverity;
  /** 復帰までの残り週 */
  weeksLeft: number;
  /** 復帰後に能力の上限が下がる割合 */
  loss: number;
}

export interface Life {
  /** 能力の上限（ピーク時の能力） */
  pot: Potential;
  /** 身体的疲労・精神的疲労（0〜100） */
  fatigue: number;
  mental: number;
  /** 調子の波（位相・周期 週） */
  phase: number;
  period: number;
  /** 成長のピークの時期の個体差（年） */
  peakShift: number;
  injury?: Injury;
  /** 復帰後の休み明け（週）。休み明けの初戦は調子が上がりきらないことがある */
  layoff: number;
  /**
   * 調教による鍛え具合（能力ごと 0〜1。第4段階）。現在の能力 = 上限 × 成長曲線 × (0.97 + 0.05 × 鍛え具合)。
   * 鍛えないと少しずつ落ち、調教の効果は上限（1）に近いほど小さくなる
   */
  dev?: Potential;
  /** 仕上がり（0〜100）：強めの調教で上がり、休むと下がる。調子に反映される */
  fitness?: number;
  /** 調教履歴（新しい順、直近 TRAIN_HISTORY 週） */
  train?: TrainRecord[];
}

/** 調教1回の記録（保存容量を抑えるため短いキー） */
export interface TrainRecord {
  y: number;
  w: number;
  /** メニュー */
  m: string;
  /** 時計・内容の評価（A〜D） */
  e?: string;
}

/** 鍛え具合の既定値（記録のない古いデータ・既存の馬）。ふつうに調教している馬が釣り合う値で、成長曲線どおりの能力になる */
export const DEV_DEFAULT = 0.6;
/** 鍛え具合 → 能力の倍率（0 で 0.97、0.6 で 1.0、1 で 1.02） */
export const devFactor = (d: number) => 0.97 + 0.05 * d;

/** 年齢・週から、生まれてからの年数（JRA の馬齢は1月1日に加算。誕生は春と仮定） */
export function bioAge(birthYear: number, date: { year: number; week: number }): number {
  return date.year - birthYear - 0.3 + (date.week - 1) / 52;
}

/** 成長型ごとの、成長が完成する年齢とピークが終わる年齢（推定） */
const PEAK: Record<GrowthType, { full: number; end: number }> = {
  early: { full: 2.7, end: 4.2 },
  normal: { full: 3.8, end: 5.3 },
  late: { full: 4.8, end: 6.4 },
};
/** ピーク後の1年あたりの衰え（能力ごと。スピード・瞬発力が先に衰え、スタミナは遅い） */
const DECLINE: Record<GrowthKey, number> = { speed: 0.035, accel: 0.035, sustain: 0.025, power: 0.02, stamina: 0.015 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 成長曲線：ピーク時を 1 とした能力の割合。2歳春（生後約1.7年）の割合は成長型と成長力で決まる
 * （成長力が高いほど、若いうちと完成時の差が大きい＝伸びしろが大きい）。
 */
export function maturity(type: GrowthType, growth: number, age: number, key: GrowthKey, shift = 0): number {
  const p = PEAK[type];
  const full = p.full + shift;
  const end = p.end + shift;
  const startAge = 1.7;
  const base = type === 'early' ? 0.9 : type === 'normal' ? 0.86 : 0.82;
  const low = 1 - (1 - base) * (0.6 + (0.8 * growth) / 100);
  if (age <= startAge) return low;
  if (age < full) {
    const t = (age - startAge) / (full - startAge);
    return low + (1 - low) * (1 - (1 - t) * (1 - t));
  }
  if (age <= end) return 1;
  // 衰えは年を追うごとに少し速くなる
  const y = age - end;
  return Math.max(0.6, 1 - DECLINE[key] * y * (1 + 0.15 * y));
}

/** 現在の能力（上限 × 成長曲線） */
export function currentAbilities(h: Pick<Horse, 'growthType' | 'growth'>, life: Life, age: number): Potential {
  const out = {} as Potential;
  for (const k of GROWTH_KEYS) out[k] = Math.round(clamp(life.pot[k] * maturity(h.growthType ?? 'normal', h.growth ?? 60, age, k, life.peakShift) * devFactor(life.dev?.[k] ?? DEV_DEFAULT), 20, 99));
  return out;
}

/** 既存の能力（現在の年齢での値）から、能力の上限を逆算して生涯の状態を作る */
export function initLife(h: Horse, age: number, seed: string): Life {
  const rng = new Rng(`life:${seed}`);
  const peakShift = rng.normal(0, 0.25);
  const pot = {} as Potential;
  for (const k of GROWTH_KEYS) {
    const now = k === 'sustain' ? (h.sustain ?? Math.round((h.stamina + h.accel) / 2)) : h[k];
    pot[k] = Math.round(clamp(now / maturity(h.growthType ?? 'normal', h.growth ?? 60, age, k, peakShift), 20, 99));
  }
  return { pot, fatigue: rng.range(0, 15), mental: rng.range(0, 10), phase: rng.next(), period: rng.int(10, 16), peakShift, layoff: 0 };
}

/** 調子（−1〜1）：周期の波に、疲労（悪化）と休み明け（上がりきらない）を加える */
export function conditionOf(life: Life, weekIndex: number): number {
  const wave = Math.sin(2 * Math.PI * (weekIndex / life.period + life.phase));
  const fatigue = -Math.max(0, life.fatigue - 30) / 70;
  const layoff = life.layoff > 0 ? -0.25 : 0;
  // 仕上がり：50（ふつうに調教している馬の平均）を普通として、仕上がっているほど上がり、緩いと下がる
  const fit = ((life.fitness ?? 50) - 50) / 120;
  return clamp(wave * 0.6 + fatigue + layoff + fit - life.mental / 250, -1, 1);
}

export function conditionLabel(c: number): string {
  return c > 0.6 ? '絶好調' : c > 0.2 ? '好調' : c > -0.2 ? '普通' : c > -0.6 ? '不調' : '絶不調';
}

/** 1週分の回復と経過（休養中・レースのない週） */
export function weeklyRecovery(life: Life, health: number): Life {
  const next: Life = { ...life };
  // 1600m のレースの疲労（約40）は、平均的な健康で約5週で抜ける
  next.fatigue = Math.max(0, life.fatigue - (5 + health / 20));
  next.mental = Math.max(0, life.mental - 4);
  if (life.injury) {
    const left = life.injury.weeksLeft - 1;
    if (left <= 0) {
      // 復帰：重度・中度は能力の上限が下がる
      const pot = { ...life.pot };
      for (const k of GROWTH_KEYS) pot[k] = Math.round(pot[k] * (1 - life.injury.loss));
      next.pot = pot;
      next.injury = undefined;
      next.layoff = 1;
    } else next.injury = { ...life.injury, weeksLeft: left };
  }
  return next;
}

export interface RaceStress {
  distance: number;
  /** 0 良〜3 不良 */
  goingIndex: number;
  kakari: boolean;
  /** 着順と頭数（大敗は精神的疲労が少し増える） */
  rank: number;
  field: number;
}

/** 故障の種類（一般的な分類。発生割合と期間は推定） */
const INJURIES: { name: string; severity: InjurySeverity; share: number; weeks: [number, number]; loss: [number, number] }[] = [
  { name: '筋肉痛・捻挫', severity: 'minor', share: 0.38, weeks: [3, 6], loss: [0, 0] },
  { name: '球節炎・ソエ', severity: 'minor', share: 0.22, weeks: [5, 10], loss: [0, 0.01] },
  { name: '骨折', severity: 'moderate', share: 0.3, weeks: [16, 32], loss: [0, 0.03] },
  { name: '屈腱炎', severity: 'severe', share: 0.1, weeks: [40, 60], loss: [0.04, 0.1] },
];

/** レース1走あたりの故障の確率（推定。軽度を含めて、出走全体で約1%になるよう調整） */
export function injuryRisk(life: Life, health: number, age: number, goingIndex: number): number {
  const fatigueK = 1 + life.fatigue / 40;
  const healthK = 1.45 - health / 100;
  const ageK = age >= 7 ? 1.3 : 1;
  const goingK = goingIndex >= 2 ? 1.15 : 1;
  return 0.008 * fatigueK * healthK * ageK * goingK;
}

/** レース後：疲労・精神的疲労の加算と、故障の判定 */
export function afterRace(life: Life, health: number, age: number, s: RaceStress, seed: string): Life {
  const rng = new Rng(`race-stress:${seed}`);
  const risk = injuryRisk(life, health, age, s.goingIndex);
  const next: Life = { ...life, layoff: 0 };
  next.fatigue = Math.min(100, life.fatigue + (20 + s.distance / 80) * (s.goingIndex >= 2 ? 1.15 : 1) * (1.15 - health / 400));
  next.mental = Math.min(100, life.mental + 8 + (s.kakari ? 10 : 0) + (s.rank > s.field * 0.7 ? 4 : 0));
  if (rng.chance(risk)) {
    let r = rng.next();
    const kind = INJURIES.find((k) => (r -= k.share) <= 0) ?? INJURIES[0];
    next.injury = {
      name: kind.name,
      severity: kind.severity,
      weeksLeft: rng.int(kind.weeks[0], kind.weeks[1]),
      loss: rng.range(kind.loss[0], kind.loss[1]),
    };
  }
  return next;
}

/**
 * 出走表に写す当日の状態。レースの計算では、調子は最大 ±0.06 m/s、疲労は最大 −0.08 m/s と
 * スタミナの倍率 −8%、精神的疲労は掛かりやすさに効く（ability.ts の raceAbility）。
 */
export interface RaceForm {
  condition: number;
  fatigue: number;
  mental: number;
}

/** 引退の確率（年明けに判断。推定） */
export function retireProbability(h: Pick<Horse, 'sex'>, age: number, life: Life, recentWins: number, starts: number, conditionClass = false): number {
  if (age >= 10) return 1;
  let p = age >= 9 ? 0.75 : age >= 8 ? 0.45 : age >= 7 ? 0.25 : age >= 6 ? 0.12 : age >= 5 ? 0.05 : 0.02;
  // 牝馬は5〜6歳で繁殖入りすることが多い
  if (h.sex === '牝' && age >= 5) p += 0.15;
  // 長く勝てていない
  if (starts >= 8 && recentWins === 0) p += 0.1;
  // 5歳以上で条件クラス（オープン未満）にとどまり、勝てていない馬は引退・地方への転出が多い（第5段階。推定）
  if (conditionClass && age >= 5 && recentWins === 0) p += 0.15;
  if (life.injury?.severity === 'severe') p += 0.4;
  return clamp(p, 0, 1);
}
