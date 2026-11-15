/**
 * 競馬番組（第5段階）：1開催日8レースの組み方と、1年の重賞の日程。
 *
 * JRA の番組の大きな流れに合わせる（https://www.jra.go.jp/keiba/rules/class.html）：
 * - 1月〜6月上旬（春季）は「3歳」と「4歳以上」の2本立て。それ以後は「2歳」と「3歳以上」の2本立て
 * - 2歳戦は6月の新馬から。未勝利は少し遅れて始まり、1勝クラスは9月ごろから
 * - 3歳未勝利は9月中旬で終わる（https://www.jra.go.jp/owner/members/prize/ の「3歳未勝利競走の編成終了」）
 * 何週目から・何週目までといった細かい区切りは年によって違うため推定（docs/10-race-system.md）。
 *
 * レース名・重賞名はすべて架空。コースと距離は、いまの1場（第6段階で10場に広げる）で組める距離から選ぶ。
 */
import type { TimeOfDay } from './sim';
import type { Surface } from './track';
import { type AgeCond, type ClassId, type WeightRule } from './raceclass';

/** 春季（3歳／4歳以上）の最後の週。この翌週から 2歳／3歳以上 */
export const SPRING_LAST_WEEK = 22;
/** 3歳新馬の最後の週（推定：3月上旬） */
export const NEWCOMER3_LAST_WEEK = 10;
/** 2歳新馬の最初の週（春季が終わった翌週。6月） */
export const NEWCOMER2_FIRST_WEEK = 23;
/** 2歳未勝利の最初の週（推定：6月下旬） */
export const MAIDEN2_FIRST_WEEK = 26;
/** 2歳1勝クラスの最初の週（9月ごろ） */
export const WIN1_2_FIRST_WEEK = 35;
/** 2歳オープン特別の最初の週（推定：7月） */
export const OPEN2_FIRST_WEEK = 28;
/** 3歳未勝利の最後の週（9月中旬） */
export const MAIDEN3_LAST_WEEK = 37;

export interface ProgramAlt {
  cls: ClassId;
  age: AgeCond;
  /** 選ばれやすさ（出走できる馬の数にも比例させる） */
  w: number;
  /** その週に組めるか */
  when?: (week: number) => boolean;
}

export interface ProgramSlot {
  surface: Surface;
  layout?: 'inner' | 'outer';
  distances: number[];
  timeOfDay: TimeOfDay;
  field: [number, number];
  special: boolean;
  spring: ProgramAlt[];
  autumn: ProgramAlt[];
}

const w = (lo: number, hi: number) => (week: number) => week >= lo && week <= hi;

/**
 * 1開催日の8レース。前半（1〜4R）は一般競走、後半（5〜8R）は特別競走。8R はメインレース（重賞の週は重賞）。
 * 各レースの候補の中から、出走できる馬が足りるものを選ぶ（meeting.ts）。
 */
export const SLOTS: ProgramSlot[] = [
  {
    surface: 'dirt', distances: [1200], timeOfDay: 'day', field: [11, 16], special: false,
    spring: [{ cls: 'maiden', age: '3', w: 1 }],
    autumn: [
      { cls: 'maiden', age: '3', w: 1, when: w(1, MAIDEN3_LAST_WEEK) },
      { cls: 'maiden', age: '2', w: 1, when: w(MAIDEN2_FIRST_WEEK, 52) },
      { cls: 'newcomer', age: '2', w: 0.6, when: w(NEWCOMER2_FIRST_WEEK, 52) },
    ],
  },
  {
    surface: 'turf', layout: 'outer', distances: [1600], timeOfDay: 'day', field: [11, 16], special: false,
    spring: [
      { cls: 'newcomer', age: '3', w: 0.6, when: w(1, NEWCOMER3_LAST_WEEK) },
      { cls: 'maiden', age: '3', w: 1 },
    ],
    autumn: [
      { cls: 'newcomer', age: '2', w: 1, when: w(NEWCOMER2_FIRST_WEEK, 52) },
      { cls: 'maiden', age: '2', w: 0.6, when: w(MAIDEN2_FIRST_WEEK, 52) },
      { cls: 'maiden', age: '3', w: 0.6, when: w(1, MAIDEN3_LAST_WEEK) },
    ],
  },
  {
    surface: 'dirt', distances: [1800], timeOfDay: 'day', field: [11, 16], special: false,
    spring: [
      { cls: 'maiden', age: '3', w: 1 },
      { cls: 'win1', age: '4up', w: 0.4 },
    ],
    autumn: [
      { cls: 'maiden', age: '3', w: 1, when: w(1, MAIDEN3_LAST_WEEK) },
      { cls: 'maiden', age: '2', w: 1, when: w(MAIDEN2_FIRST_WEEK, 52) },
      { cls: 'win1', age: '3up', w: 0.4 },
    ],
  },
  {
    surface: 'turf', layout: 'inner', distances: [2000], timeOfDay: 'day', field: [10, 16], special: false,
    spring: [
      { cls: 'win1', age: '3', w: 1 },
      { cls: 'win1', age: '4up', w: 1 },
    ],
    autumn: [
      { cls: 'win1', age: '3up', w: 1 },
      { cls: 'win1', age: '2', w: 0.7, when: w(WIN1_2_FIRST_WEEK, 52) },
    ],
  },
  {
    surface: 'turf', layout: 'outer', distances: [1200], timeOfDay: 'day', field: [10, 16], special: true,
    spring: [
      { cls: 'win1', age: '3', w: 1 },
      { cls: 'win1', age: '4up', w: 1 },
    ],
    autumn: [{ cls: 'win1', age: '3up', w: 1 }],
  },
  {
    surface: 'dirt', distances: [1800], timeOfDay: 'dusk', field: [10, 16], special: true,
    spring: [
      { cls: 'win2', age: '4up', w: 1 },
      { cls: 'win1', age: '3', w: 0.5 },
      { cls: 'open', age: '3', w: 0.25 },
    ],
    autumn: [
      { cls: 'win2', age: '3up', w: 1 },
      { cls: 'win1', age: '2', w: 0.4, when: w(WIN1_2_FIRST_WEEK, 52) },
      { cls: 'open', age: '2', w: 0.25, when: w(OPEN2_FIRST_WEEK, 52) },
    ],
  },
  {
    surface: 'turf', layout: 'outer', distances: [2200], timeOfDay: 'dusk', field: [10, 16], special: true,
    spring: [
      { cls: 'win2', age: '4up', w: 1 },
      { cls: 'win3', age: '4up', w: 0.6 },
    ],
    autumn: [
      { cls: 'win2', age: '3up', w: 1 },
      { cls: 'win3', age: '3up', w: 0.6 },
    ],
  },
  {
    surface: 'turf', layout: 'inner', distances: [2500], timeOfDay: 'night', field: [10, 16], special: true,
    spring: [
      { cls: 'win3', age: '4up', w: 1 },
      { cls: 'open', age: '4up', w: 0.6 },
      { cls: 'listed', age: '4up', w: 0.3 },
      { cls: 'listed', age: '3', w: 0.3 },
    ],
    autumn: [
      { cls: 'win3', age: '3up', w: 1 },
      { cls: 'open', age: '3up', w: 0.6 },
      { cls: 'listed', age: '3up', w: 0.3 },
    ],
  },
];

/** 特別競走の名前（架空）。条件戦は「〜特別」、3勝クラス以上は「〜ステークス」 */
export const SPECIAL_NAMES = [
  '暁雲', '翠嶺', '湖月', '星見坂', '灯台岬', '銀砂', '宵灯', '霧ヶ丘', '風見野', '若潮', '月影', '花野', '雲雀野', '遠雷', '朝凪',
  '夕凪', '白浜', '青葉台', '鈴蘭', '星雲', '翠ヶ原', '古城', '水鏡', '虹橋', '黎明', '琥珀', '瑠璃', '浜風', '桐生野', '藤棚',
];

export interface Stakes {
  week: number;
  name: string;
  cls: 'g1' | 'g2' | 'g3' | 'listed';
  age: AgeCond;
  filly?: boolean;
  surface: Surface;
  layout?: 'inner' | 'outer';
  distance: number;
  rule: WeightRule;
  /** 第1着本賞金（万円。架空の設定値。JRA の同じ格の重賞のおおよその水準に合わせた推定） */
  prize: number;
  timeOfDay?: TimeOfDay;
}

/** 1年の重賞（架空）。8R のメインレースとして行う */
export const STAKES: Stakes[] = [
  { week: 3, name: '寒椿ステークス', cls: 'g3', age: '4up', surface: 'turf', layout: 'inner', distance: 2000, rule: 'handicap', prize: 4100 },
  { week: 6, name: '白梅賞', cls: 'g3', age: '3', surface: 'turf', layout: 'outer', distance: 1600, rule: 'allowance', prize: 3900 },
  { week: 8, name: '雪解けステークス', cls: 'listed', age: '4up', surface: 'dirt', distance: 1800, rule: 'allowance', prize: 2400 },
  { week: 10, name: '早春杯', cls: 'g2', age: '4up', surface: 'turf', layout: 'outer', distance: 2200, rule: 'allowance', prize: 6200 },
  { week: 12, name: '春霞ステークス', cls: 'g2', age: '3', surface: 'turf', layout: 'inner', distance: 2000, rule: 'age', prize: 5400 },
  { week: 14, name: '花筏賞', cls: 'g1', age: '3', filly: true, surface: 'turf', layout: 'outer', distance: 1600, rule: 'age', prize: 14000 },
  { week: 15, name: '青嵐賞', cls: 'g1', age: '3', surface: 'turf', layout: 'inner', distance: 2000, rule: 'age', prize: 20000 },
  { week: 17, name: '春雷ステークス', cls: 'g2', age: '4up', surface: 'turf', layout: 'inner', distance: 2500, rule: 'allowance', prize: 6700 },
  { week: 19, name: '薫風カップ', cls: 'g1', age: '4up', surface: 'turf', layout: 'outer', distance: 1600, rule: 'wfa', prize: 18000 },
  { week: 21, name: '緑陰記念', cls: 'g1', age: '3', surface: 'turf', layout: 'inner', distance: 2500, rule: 'age', prize: 30000 },
  { week: 25, name: '夏至ステークス', cls: 'g1', age: '3up', surface: 'turf', layout: 'outer', distance: 2200, rule: 'wfa', prize: 22000 },
  { week: 27, name: '夏雲ステークス', cls: 'g3', age: '3up', surface: 'turf', layout: 'outer', distance: 1200, rule: 'handicap', prize: 4100 },
  { week: 30, name: '蝉時雨カップ', cls: 'g3', age: '2', surface: 'turf', layout: 'outer', distance: 1600, rule: 'age', prize: 3300 },
  { week: 32, name: '白砂ステークス', cls: 'g3', age: '3up', surface: 'dirt', distance: 1800, rule: 'allowance', prize: 3800 },
  { week: 35, name: '晩夏記念', cls: 'g2', age: '3up', surface: 'turf', layout: 'outer', distance: 2200, rule: 'allowance', prize: 6000 },
  { week: 37, name: '野分ステークス', cls: 'g2', age: '3', surface: 'turf', layout: 'inner', distance: 2000, rule: 'age', prize: 5400 },
  { week: 39, name: '月見ステークス', cls: 'g1', age: '3up', surface: 'turf', layout: 'outer', distance: 1200, rule: 'wfa', prize: 17000 },
  { week: 41, name: '錦秋賞', cls: 'g1', age: '3', surface: 'turf', layout: 'inner', distance: 2500, rule: 'age', prize: 20000 },
  { week: 42, name: '深秋ステークス', cls: 'g2', age: '3up', surface: 'turf', layout: 'inner', distance: 2000, rule: 'allowance', prize: 6700 },
  { week: 44, name: '霜月記念', cls: 'g1', age: '3up', surface: 'turf', layout: 'inner', distance: 2000, rule: 'wfa', prize: 22000 },
  { week: 45, name: '黄金砂カップ', cls: 'g1', age: '3up', surface: 'dirt', distance: 1800, rule: 'wfa', prize: 12000 },
  { week: 46, name: '冬隣ステークス', cls: 'g3', age: '3up', surface: 'dirt', distance: 1200, rule: 'allowance', prize: 3900 },
  { week: 47, name: '白秋杯', cls: 'g1', age: '3up', filly: true, surface: 'turf', layout: 'outer', distance: 2200, rule: 'wfa', prize: 13000 },
  { week: 48, name: '天穹カップ', cls: 'g1', age: '3up', surface: 'turf', layout: 'outer', distance: 2200, rule: 'wfa', prize: 50000 },
  { week: 50, name: '雪花賞', cls: 'g1', age: '2', surface: 'turf', layout: 'outer', distance: 1600, rule: 'age', prize: 7000 },
  { week: 51, name: '翠ヶ原記念', cls: 'g1', age: '3up', surface: 'turf', layout: 'inner', distance: 2500, rule: 'wfa', prize: 50000 },
];

export function stakesOfWeek(week: number): Stakes | undefined {
  return STAKES.find((s) => s.week === week);
}

export function isSpring(week: number): boolean {
  return week <= SPRING_LAST_WEEK;
}

/** その週に組める候補 */
export function altsFor(slot: ProgramSlot, week: number): ProgramAlt[] {
  return (isSpring(week) ? slot.spring : slot.autumn).filter((a) => !a.when || a.when(week));
}
