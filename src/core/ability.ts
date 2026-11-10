/**
 * 競走馬の能力・適性と、それがレースの計算にどう効くか（第2段階）。
 *
 * 能力（0〜100、75 前後が平均的なオープン馬。数値の尺度はゲーム内の目安）
 *   スピード：最高速度 ／ スタミナ：消耗のしにくさ ／ 瞬発力：仕掛けたときの加速と末脚の切れ
 *   持続力：高い速度を長く保つ力 ／ パワー：坂・重い馬場・ダートへの対応 ／ 気性：掛かりにくさ・ゲートでの落ち着き
 *   操縦性：騎手の指示への反応（位置取りの正確さ・掛かったときに折り合える早さ） ／ ゲート：スタートの反応
 *   健康：体調の安定と故障しにくさ（故障は第3段階） ／ 成長力：成長の伸びしろと成長型（成長の計算は第3段階）
 *
 * 適性（0〜100、50 が平均。距離だけは中心距離と幅）
 *   芝・ダート・距離・馬場（重・不良への強さ）・右回り・左回り・坂・小回り・長い直線・暑さ・寒さ
 *
 * 係数の多くは推定値（ゲームとしての調整値）。実際の競馬の傾向（短距離ほど速度、長距離ほどスタミナ、
 * 重馬場でパワー、坂でパワーなど）と矛盾しない向きと大きさにし、tests/ability.test.ts と多数のレースの集計で確かめている。
 * 速度の補正は m/s。基準の最高速度は芝良で約17.9m/s（1ハロン約11.2秒）。0.1m/s は1600mで約0.5秒（約3馬身）の差。
 */
import type { Grade, Horse } from '../data/roster';
import { Rng } from './rng';

export type GrowthType = 'early' | 'normal' | 'late';

export const GROWTH_LABEL: Record<GrowthType, string> = { early: '早熟', normal: '普通', late: '晩成' };

export interface DistanceAptitude {
  /** 最も得意な距離 (m) */
  center: number;
  /** 短い側・長い側の適性の幅 (m)。この距離だけ離れると、能力の発揮が一段落ちる */
  short: number;
  long: number;
}

export interface Aptitudes {
  turf: number;
  dirt: number;
  distance: DistanceAptitude;
  /** 重・不良への強さ（50 が平均） */
  going: number;
  right: number;
  left: number;
  slope: number;
  /** 小回り（コーナーがきつい）コース */
  tight: number;
  /** 直線の長いコース */
  longStraight: number;
  heat: number;
  cold: number;
}

/** レースの計算に使う、能力と適性のすべて */
export interface HorseProfile {
  speed: number;
  stamina: number;
  /** 瞬発力（データ上の名前は accel） */
  burst: number;
  sustain: number;
  power: number;
  temper: number;
  control: number;
  start: number;
  health: number;
  growth: number;
  growthType: GrowthType;
  apt: Aptitudes;
}

/** 追加の能力・適性（Horse に任意で持たせる。ない値は既存の能力から求める） */
export interface ExtendedAbilities {
  sustain?: number;
  control?: number;
  health?: number;
  growth?: number;
  growthType?: GrowthType;
  apt?: Partial<Aptitudes>;
}

const GRADE_NUM: Record<Grade, number> = { A: 85, B: 65, C: 45, D: 25 };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function gradeOf(v: number): Grade {
  return v >= 75 ? 'A' : v >= 55 ? 'B' : v >= 35 ? 'C' : 'D';
}

/**
 * 能力・適性のすべてをそろえる。追加の値がない馬（古い保存データ・テスト用の馬）は、既存の能力から決まった式で求める。
 */
export function profileOf(h: Horse & ExtendedAbilities): HorseProfile {
  const a = h.apt ?? {};
  return {
    speed: h.speed,
    stamina: h.stamina,
    burst: h.accel,
    sustain: h.sustain ?? Math.round((h.stamina + h.accel) / 2),
    power: h.power,
    temper: h.temper,
    control: h.control ?? h.temper,
    start: h.start,
    health: h.health ?? 65,
    growth: h.growth ?? 60,
    growthType: h.growthType ?? 'normal',
    apt: {
      turf: a.turf ?? GRADE_NUM[h.turf],
      dirt: a.dirt ?? GRADE_NUM[h.dirt],
      distance: a.distance ?? { center: h.bestDistance, short: 400, long: 400 },
      going: a.going ?? GRADE_NUM[h.heavy],
      right: a.right ?? 60,
      left: a.left ?? 60,
      slope: a.slope ?? 50,
      tight: a.tight ?? 50,
      longStraight: a.longStraight ?? 50,
      heat: a.heat ?? 50,
      cold: a.cold ?? 50,
    },
  };
}

/**
 * 能力の個体差（追加の能力・適性）を決まった乱数で作る。既存の能力と相関を持たせる。
 * 例：持続力はスタミナと瞬発力の中間に近い、操縦性は気性と相関、坂適性はパワーと相関
 */
export function generateExtended(h: Horse, seed: string): Required<Omit<ExtendedAbilities, 'apt'>> & { apt: Aptitudes } {
  const rng = new Rng(`ext:${seed}`);
  const n = (mu: number, sd: number, lo = 20, hi = 98) => Math.round(clamp(rng.normal(mu, sd), lo, hi));
  const longer = (h.bestDistance - 1800) / 400;
  // 成長型：若い馬ほど早熟〜普通、高齢で現役の馬ほど晩成の可能性が高い（推定）
  const r = rng.next();
  const lateBias = (h.age - 4) * 0.08;
  const growthType: GrowthType = r < 0.28 - lateBias ? 'early' : r < 0.78 - lateBias ? 'normal' : 'late';
  return {
    sustain: n((h.stamina + h.accel) / 2 + longer * 3, 5),
    control: n(h.temper + 3, 8),
    health: n(66, 11),
    growth: n(62, 14),
    growthType,
    apt: {
      turf: n(GRADE_NUM[h.turf], 6),
      dirt: n(GRADE_NUM[h.dirt], 6),
      distance: {
        center: h.bestDistance,
        // 短距離向きの馬ほど長い側の幅が狭い（スタミナで決まる）。短い側の幅は速度で決まる（推定）
        short: Math.round(clamp(rng.normal(300 + (h.speed - 70) * 10, 70), 160, 700) / 10) * 10,
        long: Math.round(clamp(rng.normal(300 + (h.stamina - 70) * 12, 70), 160, 800) / 10) * 10,
      },
      going: n(GRADE_NUM[h.heavy], 6),
      right: n(60, 12),
      left: n(60, 12),
      slope: n(50 + (h.power - 70) * 0.6, 10),
      tight: n(52 + (h.accel - 75) * 0.3, 12),
      longStraight: n(50 + (h.stamina + h.accel - 150) * 0.3, 12),
      heat: n(55, 12),
      cold: n(55, 12),
    },
  };
}

// ---------------------------------------------------------------- コースと季節

/** コースの特徴（適性の計算に使う） */
export interface CourseTraits {
  /** 1 = 右回り、-1 = 左回り */
  hand: 1 | -1;
  /** 最後の直線の長さ (m) */
  straight: number;
  /** 代表的なコーナー半径 (m) */
  turnRadius: number;
  /** ゴール前の上り坂の高さ (m) */
  finalHill: number;
}

/** 月 → 季節の厳しさ（暑さ・寒さ、0〜1。推定） */
export function seasonStress(month: number | undefined): { heat: number; cold: number } {
  if (!month) return { heat: 0, cold: 0 };
  const heat = month === 7 || month === 8 ? 1 : month === 6 || month === 9 ? 0.4 : 0;
  const cold = month === 1 || month === 2 ? 1 : month === 12 || month === 3 ? 0.4 : 0;
  return { heat, cold };
}

// ---------------------------------------------------------------- レースへの効き方

export interface RaceAbilityInput {
  surface: 'turf' | 'dirt';
  distance: number;
  /** 0 良 〜 3 不良 */
  goingIndex: number;
  course: CourseTraits;
  month?: number;
}

/** 内訳（解説・テスト用、m/s） */
export interface AptitudeBreakdown {
  surface: number;
  distance: number;
  going: number;
  direction: number;
  season: number;
}

export interface RaceAbility {
  /** 最高速度への補正の合計 (m/s) と内訳 */
  speedAdj: number;
  breakdown: AptitudeBreakdown;
  /** スタミナの倍率（距離が長すぎると下がる） */
  staminaFactor: number;
  /** スタートの加速 (m/s²)・巡航中の加速 (m/s²) */
  aStart: number;
  aRun: number;
  /** スパート時の速度の上乗せ（最高速度に対する割合） */
  kick: number;
  /** スパート中の消耗の倍率（持続力が高いほど小さい） */
  spurtDrain: number;
  /** スタミナが少なくなってから失速しはじめる残量 */
  fadeThreshold: number;
  /** 上り坂での失速の受けやすさ */
  hill: number;
  /** コーナーでの速度の倍率（小回り） */
  cornerFactor: number;
  /** 掛かる確率・掛かっている時間の倍率 */
  kakariProb: number;
  kakariDuration: number;
  /** スタートの遅れ (s)・出遅れの確率 */
  startDelay: number;
  lateStartProb: number;
  /** 位置取りのぶれ（操縦性が低いほど大きい） */
  positionNoise: number;
  /** 当日の体調のばらつき (m/s) */
  conditionSd: number;
  /** 前に行きたがる度合い（0〜1）：ゲートの速さ・二の脚・気性から */
  earlySpeed: number;
}

/** 距離適性による発揮の割合（1 が最大）。中心から幅だけ離れると約0.75、2倍で約0.3（表示・解説用） */
export function distanceFit(apt: DistanceAptitude, D: number): number {
  const x = D - apt.center;
  const z = x / (x >= 0 ? apt.long : apt.short);
  return Math.exp(-0.29 * z * z);
}

/** 距離適性の表示（◎○△×） */
export function distanceMark(apt: DistanceAptitude, D: number): string {
  const f = distanceFit(apt, D);
  return f > 0.9 ? '◎' : f > 0.7 ? '○' : f > 0.4 ? '△' : '×';
}

export function raceAbility(p: HorseProfile, inp: RaceAbilityInput): RaceAbility {
  const { distance: D, goingIndex: g, course } = inp;
  const a = p.apt;

  // 芝・ダート：A(85) で +0.1、B(65) で 0、C(45) で −0.2、D(25) で −0.4（以前の段階評価と同じ大きさ）
  const sApt = inp.surface === 'turf' ? a.turf : a.dirt;
  let surface = sApt >= 65 ? 0.005 * (sApt - 65) : 0.01 * (sApt - 65);
  // パワー：ダートでは常に、芝では馬場が重いほど効く
  surface += inp.surface === 'dirt' ? (p.power - 70) * 0.005 : ((p.power - 70) * 0.004 * g) / 3;

  // 距離：中心から外れた量を、その側の幅で割った z で評価する
  //   長い側：スタミナが持たない（スタミナの倍率が下がる）＋わずかに速度も落ちる
  //   短い側：速度の絶対値・テンの速さが足りない（速度が落ちる）
  //   幅を超えて離れるほど落ち方が急になる（1 + 0.3·(|z|−1)）
  const x = D - a.distance.center;
  const z = x / (x >= 0 ? a.distance.long : a.distance.short);
  const steep = Math.abs(z) * (1 + 0.3 * Math.max(0, Math.abs(z) - 1));
  // スタミナの差は距離が長いほど効く（マイルで 0.75 + スタミナ/200。1200mではその差が 0.75 倍、2400mでは 1.5 倍）
  let staminaFactor = 1.125 + ((p.stamina - 75) / 200) * clamp(D / 1600, 0.5, 1.6);
  let distance = 0;
  if (x > 0) {
    staminaFactor *= Math.max(0.55, 1 - 0.09 * steep);
    distance = -0.02 * steep;
  } else {
    distance = -0.07 * steep;
  }

  // 馬場：重・不良（g ≥ 2）で、適性 A(85) は +0.1、C(45) は約 −0.11、D(25) は −0.25（以前の段階評価と同じ大きさ）。
  // 道悪の適性だけは、段階評価 B に当たる 60 を「普通」とする
  let going = 0;
  const gv = a.going >= 60 ? ((a.going - 60) / 25) * 0.1 : ((a.going - 60) / 35) * 0.25;
  if (g >= 2) going = gv * ((g - 1) / 2);
  else if (g === 1) going = gv * 0.2;

  // 回り：苦手な回りでは手前を替えにくく、コーナーで速度を落とす（全体の速度で近似。60 が平均）
  const dirApt = course.hand > 0 ? a.right : a.left;
  const direction = ((dirApt - 60) / 40) * 0.08;

  // 季節：暑さ・寒さに弱い馬は真夏・真冬に少し落ちる（推定）
  const st = seasonStress(inp.month);
  const season = st.heat * ((a.heat - 50) / 50) * 0.05 + st.cold * ((a.cold - 50) / 50) * 0.05;

  // 直線の長さ：長い直線は持続力・長い直線適性の高い馬に、短い直線は瞬発力の高い馬にわずかに有利（推定）
  const straightK = clamp((course.straight - 380) / 150, -1, 1);
  const kick = 0.01 * straightK * ((a.longStraight - 50) / 50) + 0.008 * -straightK * ((p.burst - 75) / 25);

  // 小回り：コーナー半径が小さいほど、小回り適性の低い馬はコーナーで速度を落とす
  const tightness = clamp((190 - course.turnRadius) / 80, 0, 1);
  const cornerFactor = 1 - 0.02 * tightness * ((50 - a.tight) / 50);

  // 坂：パワーと坂適性。ゴール前の坂が高いほど差が出る（坂の高さは勾配として計算側で効く）
  const hill = (1.5 - p.power / 100) * (1.25 - a.slope / 200);

  const speedAdj = surface + distance + going + direction + season;
  return {
    speedAdj,
    breakdown: { surface, distance, going, direction, season },
    staminaFactor,
    aStart: 4.5 + (p.start / 100) * 0.6 + (p.burst / 100) * 0.9,
    aRun: 0.3 + (p.burst / 100) * 0.5,
    kick,
    spurtDrain: 1 + (75 - p.sustain) / 250,
    fadeThreshold: clamp(0.3 + (75 - p.sustain) / 500, 0.2, 0.4),
    hill,
    cornerFactor,
    kakariProb: Math.pow((100 - p.temper) / 100, 1.5) * 0.35,
    kakariDuration: clamp(1 + (75 - p.control) / 125, 0.6, 1.5),
    startDelay: 0.1 + ((100 - p.start) / 100) * 0.3,
    lateStartProb: 0.03 + ((100 - p.start) / 100) * 0.05 + ((100 - p.temper) / 100) * 0.02,
    positionNoise: 0.05 * clamp(1 + (75 - p.control) / 75, 0.6, 1.6),
    conditionSd: 0.06 * clamp(1 + (65 - p.health) / 120, 0.75, 1.35),
    earlySpeed: clamp((p.start * 0.45 + p.burst * 0.25 + p.speed * 0.3) / 100 + (60 - p.temper) / 400, 0, 1),
  };
}
