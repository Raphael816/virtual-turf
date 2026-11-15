/**
 * 競馬のレース制度（第5段階）：クラス・収得賞金・出走条件・負担重量・本賞金。
 *
 * 数値は JRA 公式の次のページによる（2026年11月確認）。架空の重賞の賞金・別定の加算・ハンデの付け方など、
 * 公式に一律の値がないものは推定値で、docs/10-race-system.md に区別して記す。
 * - クラス分けと収得賞金：https://www.jra.go.jp/keiba/rules/class.html
 * - 負担重量（馬齢重量・3歳と4歳の減量表）：https://www.jra.go.jp/keiba/rules/weight.html
 * - 本賞金（第1着本賞・2〜5着の比率）：https://www.jra.go.jp/owner/members/prize/
 *
 * 金額の単位はすべて万円。
 */
import type { Horse } from '../data/roster';

export type ClassId = 'newcomer' | 'maiden' | 'win1' | 'win2' | 'win3' | 'open' | 'listed' | 'g3' | 'g2' | 'g1';
/** 出走条件の年齢：2歳・3歳・3歳以上・4歳以上 */
export type AgeCond = '2' | '3' | '3up' | '4up';
/** 負担重量の決め方：馬齢・定量・別定・ハンデキャップ */
export type WeightRule = 'age' | 'wfa' | 'allowance' | 'handicap';

export const CLASS_LABEL: Record<ClassId, string> = {
  newcomer: '新馬',
  maiden: '未勝利',
  win1: '1勝クラス',
  win2: '2勝クラス',
  win3: '3勝クラス',
  open: 'オープン',
  listed: 'リステッド',
  g3: 'GIII',
  g2: 'GII',
  g1: 'GI',
};
/** 出馬表の見出しなどに使う短い表記 */
export const CLASS_SHORT: Record<ClassId, string> = { newcomer: '新馬', maiden: '未勝利', win1: '1勝', win2: '2勝', win3: '3勝', open: 'OP', listed: 'L', g3: 'G3', g2: 'G2', g1: 'G1' };
export const AGE_LABEL: Record<AgeCond, string> = { '2': '2歳', '3': '3歳', '3up': '3歳以上', '4up': '4歳以上' };
export const RULE_LABEL: Record<WeightRule, string> = { age: '馬齢', wfa: '定量', allowance: '別定', handicap: 'ハンデ' };

/** クラスの格の順（出走できるかの判定・格上挑戦に使う） */
export const CLASS_RANK: Record<ClassId, number> = { newcomer: 0, maiden: 0, win1: 1, win2: 2, win3: 3, open: 4, listed: 5, g3: 6, g2: 7, g1: 8 };
export const isOpenClass = (c: ClassId) => CLASS_RANK[c] >= 4;
export const isGraded = (c: ClassId) => c === 'g1' || c === 'g2' || c === 'g3';

/** 馬の所属クラス（収得賞金で決まる。JRA：1勝 500万円以下／2勝 501〜1000万円／3勝 1001〜1600万円／オープン 1600万円超） */
export type HorseClass = 'maiden' | 'win1' | 'win2' | 'win3' | 'open';
export function classOfEarnings(earnings: number): HorseClass {
  if (earnings <= 0) return 'maiden';
  if (earnings <= 500) return 'win1';
  if (earnings <= 1000) return 'win2';
  if (earnings <= 1600) return 'win3';
  return 'open';
}
export const HORSE_CLASS_LABEL: Record<HorseClass, string> = { maiden: '未勝利', win1: '1勝クラス', win2: '2勝クラス', win3: '3勝クラス', open: 'オープン' };

// ---------------------------------------------------------------- 出走条件

/** 1レースの条件（出馬表に載せる・保存する） */
export interface RaceTerms {
  cls: ClassId;
  age: AgeCond;
  /** 牝馬限定 */
  filly?: boolean;
  rule: WeightRule;
  /** 特別競走（名前の付いたレース）。賞金が一般競走より高い */
  special: boolean;
  /** 第1着本賞金（万円） */
  prize: number;
}

/** 「3歳以上2勝クラス」「2歳新馬」「4歳以上オープン（牝）」のような条件の表記 */
export function termsLabel(t: Pick<RaceTerms, 'cls' | 'age' | 'filly'>): string {
  const cls = isGraded(t.cls) ? `(${CLASS_LABEL[t.cls]})` : t.cls === 'listed' ? '(L)' : CLASS_LABEL[t.cls];
  return `${AGE_LABEL[t.age]}${isGraded(t.cls) || t.cls === 'listed' ? 'オープン' : ''}${cls}${t.filly ? '（牝）' : ''}`;
}

export function ageEligible(age: AgeCond, horseAge: number): boolean {
  switch (age) {
    case '2':
      return horseAge === 2;
    case '3':
      return horseAge === 3;
    case '3up':
      return horseAge >= 3;
    case '4up':
      return horseAge >= 4;
  }
}

export interface ClassStatus {
  /** 収得賞金（万円） */
  earnings: number;
  /** 出走回数 */
  starts: number;
}

/**
 * 出走できるか：
 * - 新馬：まだ一度も走っていない馬だけ
 * - 未勝利：まだ勝っていない馬（収得賞金 0）だけ
 * - 1〜3勝クラス：そのクラス以下の馬（下のクラスの馬は格上挑戦として出られる）
 * - オープン以上：だれでも（格上挑戦。実際の選ばれやすさは meeting.ts の優先順位で決まる）
 */
export function classEligible(cls: ClassId, st: ClassStatus): boolean {
  if (cls === 'newcomer') return st.starts === 0;
  if (cls === 'maiden') return st.earnings <= 0;
  if (isOpenClass(cls)) return true;
  return CLASS_RANK[classOfEarnings(st.earnings)] <= CLASS_RANK[cls];
}

// ---------------------------------------------------------------- 負担重量

/**
 * 馬齢重量（JRA）：2歳 9月まで 牡・せん55／牝55、10〜12月 56／55、3歳 57／55（kg）。
 * 同じ年齢の馬だけのレースで使う。
 */
export function ageWeight(horseAge: number, sex: Horse['sex'], month: number): number {
  const filly = sex === '牝';
  if (horseAge <= 2) return filly ? 55 : month >= 10 ? 56 : 55;
  return filly ? 55 : 57;
}

/**
 * 3歳・4歳の減量（5歳以上 牡・せん58kg に対して。JRA の月別・距離別の表）。
 * 行：距離の区分、列：1〜12月。[オープン, オープン以外] の組。オープン以外で値が同じ月は同じ数字。
 */
const ALLOW_3: [number, number][][] = [
  // 1,400m 未満
  [[7, 6], [6, 5], [5, 4], [4, 3], [4, 3], [3, 3], [3, 3], [2, 2], [2, 2], [1, 1], [1, 1], [1, 1]],
  // 1,400m 以上 1,600m 以下
  [[8, 7], [7, 6], [6, 5], [5, 4], [4, 3], [4, 3], [3, 3], [3, 3], [2, 2], [2, 2], [1, 1], [1, 1]],
  // 1,600m 超 2,200m 未満
  [[9, 8], [8, 7], [7, 6], [6, 5], [5, 4], [4, 3], [4, 3], [3, 3], [3, 3], [2, 2], [2, 2], [1, 1]],
  // 2,200m 以上
  [[10, 9], [9, 8], [8, 7], [7, 6], [6, 5], [5, 4], [4, 3], [4, 3], [3, 3], [3, 3], [2, 2], [2, 2]],
];
/** 4歳の減量（1kg）がある月数：1,400m未満 0、1,400〜1,600m 1月、1,600超〜2,200m未満 1〜2月、2,200m以上 1〜3月 */
const ALLOW_4_MONTHS = [0, 1, 2, 3];

function distanceBand(distance: number): number {
  if (distance < 1400) return 0;
  if (distance <= 1600) return 1;
  if (distance < 2200) return 2;
  return 3;
}

/** 異なる年齢の馬が走るレースの基礎重量（定量・別定の基礎）：5歳以上 牡・せん58kg、牝56kg から3歳・4歳の減量を引く */
export function wfaWeight(horseAge: number, sex: Horse['sex'], month: number, distance: number, open: boolean): number {
  let w = sex === '牝' ? 56 : 58;
  const band = distanceBand(distance);
  if (horseAge === 3) w -= ALLOW_3[band][month - 1][open ? 0 : 1];
  if (horseAge === 4 && month <= ALLOW_4_MONTHS[band]) w -= 1;
  return w;
}

/** 定量・馬齢の基本重量（同じ年齢だけのレースは馬齢重量、異なる年齢が走るレースは上の表） */
export function baseWeight(t: Pick<RaceTerms, 'age' | 'cls'>, horseAge: number, sex: Horse['sex'], month: number, distance: number): number {
  if (t.age === '2' || t.age === '3') return ageWeight(horseAge, sex, month);
  return wfaWeight(horseAge, sex, month, distance, isOpenClass(t.cls));
}

/** 別定の加算に使う、出走時点の実績 */
export interface WeightRecord {
  earnings: number;
  /** 過去1年の重賞勝ち（GI・GII・GIII の数） */
  g1Wins: number;
  g2Wins: number;
  g3Wins: number;
}

/**
 * 別定の加算（推定。実際は競走ごとに条件が決まっている）：
 * - 重賞：過去1年に GI を勝った馬 +2kg、GII を勝った馬 +1kg（GIII 競走では GIII 勝ちも +1kg）
 * - オープン特別・リステッド：収得賞金が 2,000万円を超える馬は、1,500万円ごとに +1kg
 * いずれも上限 +2kg（牡・せん馬で最大 60kg。JRA の別定戦で 60kg を超えることはまれ）
 */
export function allowanceExtra(cls: ClassId, r: WeightRecord): number {
  if (isGraded(cls)) {
    let x = r.g1Wins > 0 ? 2 : r.g2Wins > 0 ? 1 : 0;
    if (cls === 'g3' && x === 0 && r.g3Wins > 0) x = 1;
    return Math.min(2, x);
  }
  if (cls === 'open' || cls === 'listed') return Math.min(2, Math.floor(Math.max(0, r.earnings - 2000) / 1500));
  return 0;
}

// ---------------------------------------------------------------- ハンデ

/**
 * レース1走の能力評価（kg 単位。推定）：クラスの基準値 − 1着からの着差（馬身）＋ 背負った重量の補正。
 * 「斤量1kg ≒ 1馬身」という一般的な目安で、着差と重量を同じ単位にそろえる。
 */
export const CLASS_PAR: Record<ClassId, number> = { newcomer: 0, maiden: 0, win1: 3, win2: 6, win3: 9, open: 12, listed: 13, g3: 14, g2: 16, g1: 18 };
/** 1秒 ≒ 6馬身（1馬身 ≒ 0.17秒） */
export const LENGTHS_PER_SEC = 6;

export interface RunForRating {
  /** クラス */
  k?: ClassId;
  /** 背負った重量 */
  kg?: number;
  /** 1着とのタイム差（秒） */
  tb?: number;
  rk: number;
}

export function runFigure(r: RunForRating): number | null {
  if (!r.k) return null;
  const behind = Math.min(10, (r.tb ?? 0) * LENGTHS_PER_SEC);
  return CLASS_PAR[r.k] - behind + ((r.kg ?? 56) - 56);
}

/** ハンデキャッパーの評価：直近5走の評価の上位2走の平均。評価できる走がなければ所属クラスの基準値 */
export function handicapRating(runs: RunForRating[], earnings: number): number {
  const figs = runs
    .slice(0, 5)
    .map(runFigure)
    .filter((x): x is number => x !== null)
    .sort((a, b) => b - a);
  if (figs.length === 0) return CLASS_PAR[classOfEarnings(earnings)];
  const top = figs.slice(0, 2);
  return top.reduce((a, b) => a + b, 0) / top.length;
}

/**
 * ハンデの重量（推定）：評価が出走馬の中央値の馬を 55kg（牝馬は評価が 2kg 分高く出るので補正しない）とし、
 * 評価の差 1 につき 1kg。0.5kg 単位で、下限 49kg・上限 60kg。
 */
export function handicapWeights(ratings: number[]): number[] {
  const sorted = [...ratings].sort((a, b) => a - b);
  const mid = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return ratings.map((r) => Math.max(49, Math.min(60, Math.round((55 + (r - mid)) * 2) / 2)));
}

// ---------------------------------------------------------------- 重量の影響

/** 重量の基準（この重量で能力どおり。これより重いと遅く、軽いと速い） */
export const WEIGHT_NEUTRAL = 56;

/**
 * 重量の影響（推定）。「1kg ≒ 1馬身（2,000m前後）」という目安に合わせる：
 * - 最高速度が 1kg につき 0.11% 下がる（2,000m で約0.12秒）
 * - スタミナの持ちが 1kg につき 0.4% × 距離/2000 下がる（長い距離ほど効く。2,000mで合計 約0.17秒 ≒ 1馬身）
 */
export function weightEffect(kg: number | undefined, distance: number): { speed: number; stamina: number } {
  if (kg === undefined) return { speed: 1, stamina: 1 };
  const d = kg - WEIGHT_NEUTRAL;
  return { speed: 1 - 0.0011 * d, stamina: 1 - 0.004 * d * (distance / 2000) };
}

// ---------------------------------------------------------------- 賞金

/**
 * 第1着本賞金（万円。JRA の表）。[一般競走, 特別競走]。
 * 重賞は競走ごとに決まっている（架空の重賞は program.ts で設定）。
 */
export function basePrize(cls: ClassId, age: AgeCond, special: boolean, month: number, surface: 'turf' | 'dirt', distance: number, filly = false): number {
  const sp = special ? 1 : 0;
  const spring = month <= 5;
  if (age === '2') {
    if (cls === 'newcomer') return 780;
    if (cls === 'maiden') return 590;
    if (cls === 'win1') return [820, 1140][sp];
    if (cls === 'listed') return 1800;
    return [1250, 1700][sp];
  }
  if (age === '3') {
    if (cls === 'newcomer') return 650;
    if (cls === 'maiden') return spring ? 590 : 580;
    if (cls === 'win1') return [820, 1140][sp];
    if (cls === 'win2') return [1110, 1480][sp];
    if (cls === 'listed') return surface === 'turf' ? 2100 : 2000;
    return surface === 'turf' ? [1450, 2000][sp] : [1450, 1900][sp];
  }
  // 3（4）歳以上
  if (cls === 'win1' || cls === 'maiden' || cls === 'newcomer') return [820, 1140][sp];
  if (cls === 'win2') return [1190, 1580][sp];
  if (cls === 'win3') return [1810, 1870][sp];
  if (cls === 'listed') {
    if (surface === 'dirt') return 2400;
    if (filly) return distance >= 1800 ? 2700 : 2600;
    return distance >= 1800 ? 2800 : 2700;
  }
  if (surface === 'dirt') return [2000, 2200][sp];
  return distance >= 1800 ? [2100, 2400][sp] : [2100, 2300][sp];
}

/** 2〜5着の本賞は1着の 40%・25%・15%・10%（JRA） */
export const PRIZE_SHARE = [1, 0.4, 0.25, 0.15, 0.1];
export function prizeFor(firstPrize: number, rank: number): number {
  return rank >= 1 && rank <= 5 ? Math.round(firstPrize * PRIZE_SHARE[rank - 1]) : 0;
}

/**
 * 収得賞金に加える額（JRA）：
 * - オープン以外：1着のとき 新馬・未勝利 400万円、1勝 500万円、2勝 600万円、3勝 900万円
 * - 重賞：2歳GIIIは 1着 1,600万円・2着 600万円、それ以外の重賞は 1・2着の本賞金の半額
 * - オープン特別・リステッド（1着）：2歳 600／800万円、3歳 1,000／1,200万円、3（4）歳以上 1,200／1,400万円
 */
export function earningsAdd(t: Pick<RaceTerms, 'cls' | 'age' | 'prize'>, rank: number): number {
  if (isGraded(t.cls)) {
    if (rank > 2) return 0;
    if (t.age === '2' && t.cls === 'g3') return rank === 1 ? 1600 : 600;
    return Math.round(prizeFor(t.prize, rank) / 2);
  }
  if (rank !== 1) return 0;
  switch (t.cls) {
    case 'newcomer':
    case 'maiden':
      return 400;
    case 'win1':
      return 500;
    case 'win2':
      return 600;
    case 'win3':
      return 900;
    case 'open':
      return t.age === '2' ? 600 : t.age === '3' ? 1000 : 1200;
    case 'listed':
      return t.age === '2' ? 800 : t.age === '3' ? 1200 : 1400;
  }
  return 0;
}
