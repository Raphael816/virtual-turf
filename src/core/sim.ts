/**
 * レースシミュレーター（決定論的・0.1秒刻みのエージェントモデル）。
 *
 * 同じ (条件, 出走馬, seed) からは常に同じ結果を返す。映像はこの走行ログを再生するだけで、
 * 描画が結果に影響することはない。モデルの全体像は docs/02-architecture.md §4.2 を参照。
 */
import type { Horse, RunningStyle } from '../data/roster';
import { type AptitudeBreakdown, type ExtendedAbilities, profileOf, raceAbility } from './ability';
import { Rng } from './rng';
import { weightEffect } from './raceclass';
import { VENUES, type VenueId } from '../data/venues';
import { type Surface, cornersOnRoute, courseFor, courseTraits, curvatureAt, gradeAt, raceU } from './track';

/**
 * 2.0.0: 中山を参考にした右回りのコース・起伏（坂）の影響を導入
 * 3.1.0: 出走時点の状態（調子・疲労・精神的疲労）を計算に入れる
 * 3.0.0: 能力・適性を拡張（持続力・操縦性・健康・距離の幅・回り・坂・小回り・直線・季節）、脚質の位置取りを展開で変える
 */
export const ENGINE_VERSION = 'sim-4.0.0';

export type Weather = 'sunny' | 'cloudy' | 'drizzle' | 'rain' | 'lightsnow' | 'snow';
export type Going = 'good' | 'yielding' | 'soft' | 'heavy';
export type TimeOfDay = 'day' | 'dusk' | 'night';

export const WEATHER_LABEL: Record<Weather, string> = { sunny: '晴', cloudy: '曇', drizzle: '小雨', rain: '雨', lightsnow: '小雪', snow: '雪' };
export const GOING_LABEL: Record<Going, string> = { good: '良', yielding: '稍重', soft: '重', heavy: '不良' };
export const TIME_LABEL: Record<TimeOfDay, string> = { day: 'デイ', dusk: '薄暮', night: 'ナイター' };
export const SURFACE_LABEL: Record<Surface, string> = { turf: '芝', dirt: 'ダート' };

/** 「芝外1600m」「ダ1800m」のような短い表記 */
export function courseShort(c: Pick<RaceConditions, 'surface' | 'layout' | 'distance'> & { venue?: VenueId }): string {
  // 競馬場のあるレース（第6段階から）は場名を付ける（「東京芝1600m」）。外回りのない場は内・外を付けない
  const v = c.venue ? VENUES[c.venue] : undefined;
  const prefix = v ? v.name : '';
  if (c.surface === 'dirt') return `${prefix}ダ${c.distance}m`;
  const lay = v && !v.outer ? '' : c.layout === 'outer' ? '外' : c.layout === 'inner' ? '内' : '';
  return `${prefix}芝${lay}${c.distance}m`;
}

export interface RaceConditions {
  surface: Surface;
  /** 芝の内回り／外回り（ダートでは無視） */
  layout?: 'inner' | 'outer';
  distance: number;
  weather: Weather;
  going: Going;
  timeOfDay: TimeOfDay;
  /** ゲーム内の月（季節の適性に使う。ない場合は季節の影響なし） */
  month?: number;
  /** 競馬場（第6段階から。ない場合は中山） */
  venue?: VenueId;
  /** 第7段階から：芝・ダートそれぞれの馬場状態と含水率 (%)、芝のクッション値、内外の差（0〜1）、使用コース（A〜）、開催日数、気温 */
  turfGoing?: Going;
  dirtGoing?: Going;
  moisture?: { turf: number; dirt: number };
  cushion?: number;
  wear?: number;
  rail?: string;
  meetDay?: number;
  temp?: number;
}

export interface SimRunner {
  horse: Horse & ExtendedAbilities;
  /** 馬番 */
  number: number;
  /** 負担重量 (kg)。ない場合は重量の影響なし（古い出走表） */
  weight?: number;
}

export interface SimOptions {
  /** 刻み幅（秒）。オッズ推定用の高速モードでは大きくする */
  dt?: number;
  /** 走行ログを記録するか */
  record?: boolean;
}

/** 結果を説明するために記録する要素 */
export interface RunnerFactors {
  style: RunningStyle;
  /** 最高速度 (m/s) */
  topSpeed: number;
  /** 芝ダート・道悪・距離適性による速度補正の合計 (m/s) */
  aptitude: number;
  /** 当日の調子 (m/s) */
  condition: number;
  /** ゴール時のスタミナ残量 0-1 */
  staminaEnd: number;
  /** コーナーで外を回ったことによるロス距離 (m) */
  laneLoss: number;
  /** スパート中に前が詰まっていた時間 (s) */
  blockedTime: number;
  kakari: boolean;
  /** 発走の遅れ (s) */
  startDelay: number;
  lateStart: boolean;
  /** ハナ争いに参加して競り負けたか */
  gaveUpLead: boolean;
  /** 4コーナー（最終コーナー）での順位（1始まり） */
  posAtLastCorner: number;
  /** 適性による速度補正の内訳 (m/s) */
  breakdown: AptitudeBreakdown;
  /** 実際の位置取り（1コーナーの位置から判定。脚質どおりとは限らない） */
  actualStyle: RunningStyle;
  /** 負担重量 (kg) と、それによる最高速度の補正 (m/s) */
  weight?: number;
  weightEffect: number;
  /** 段階ごとの順位（1始まり）：スタート直後（200m）・序盤の終わり・中盤の終わり・直線の入口・ゴール */
  phasePos: number[];
  /** 序盤に横へ動いた距離 (m)（外枠から内へ入る・前へ出るための移動） */
  earlyLateral: number;
  /** まくり（ペースが遅いと見て早めに動いた）・直線の叩き合い */
  makuri: boolean;
  fought: boolean;
}

export type SimEventType = 'late_start' | 'kakari' | 'lead' | 'duel' | 'spurt' | 'makuri' | 'fight' | 'blocked' | 'fade' | 'finish';

/** レースの段階（第8段階）：スタート・序盤・中盤・勝負どころ（最後のコーナー）・最終直線 */
export type RacePhase = 'start' | 'early' | 'middle' | 'turn' | 'straight';
export const PHASE_LABEL: Record<RacePhase, string> = { start: 'スタート', early: '序盤', middle: '中盤', turn: '勝負どころ', straight: '最終直線' };

export interface SimEvent {
  t: number;
  type: SimEventType;
  runner: number;
  other?: number;
}

export type Pace = 'high' | 'middle' | 'slow';
export const PACE_LABEL: Record<Pace, string> = { high: 'ハイペース', middle: 'ミドルペース', slow: 'スローペース' };

export interface SimResult {
  dt: number;
  n: number;
  frames: number;
  /** [frame][runner][x(走破距離), lane(内ラチからの距離), v(速度)] */
  data: Float32Array | null;
  finishTimes: number[];
  /** 着順（runner index の配列） */
  order: number[];
  /** 前の馬との着差（1着は ''） runner index 順 */
  margins: string[];
  /** 上がり3F（最後の600mのタイム）runner index 順 */
  last3F: number[];
  /** 先頭馬の200mごとのラップ */
  splits: number[];
  cornerOrders: { corner: number; at: number; order: number[] }[];
  pace: Pace;
  /** 先頭の後半 ÷ 前半 − 1（大きいほど前半が速い＝ハイペース） */
  halfDiff: number;
  /** 段階の区切り（走破距離 m）：[スタート直後, 序盤の終わり, 中盤の終わり, 直線の入口] */
  phaseMarks: number[];
  /** 中盤の先頭の平均速度 ÷ 基準ペース（1より大きいほど速い流れ） */
  paceRatio: number;
  first3F: number;
  final3F: number;
  events: SimEvent[];
  factors: RunnerFactors[];
}

export const GOING_INDEX: Record<Going, number> = { good: 0, yielding: 1, soft: 2, heavy: 3 };
const SPURT_DIST: Record<RunningStyle, number> = { nige: 490, senko: 570, sashi: 660, oikomi: 680 };
const GAP_FRAC: Record<RunningStyle, number> = { nige: 0, senko: 0.22, sashi: 0.52, oikomi: 0.85 };

/** 1馬身 = 2.4m として、時間差を着差表記に変換 */
export function marginLabel(lengths: number): string {
  const table: [number, string][] = [
    [0.05, 'ハナ'], [0.15, 'アタマ'], [0.3, 'クビ'], [0.6, '1/2'], [0.85, '3/4'], [1.1, '1'],
    [1.35, '1 1/4'], [1.6, '1 1/2'], [1.85, '1 3/4'], [2.25, '2'], [2.75, '2 1/2'],
    [3.25, '3'], [3.75, '3 1/2'], [4.5, '4'],
  ];
  for (const [lim, label] of table) if (lengths < lim) return label;
  if (lengths < 10) return String(Math.round(lengths));
  return '大差';
}

/** 着差の読み（「ハナ」「大差」などはそのまま、数値には「馬身」をつける） */
export const marginText = (m: string): string => (['ハナ', 'アタマ', 'クビ', '大差'].includes(m) ? m : `${m}馬身`);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 展開の調整値（多数のレースの集計で決めた推定値。tests/style.test.ts で分布を確かめる）
 * - relax：先頭から離れて追走する馬ほど、前を追う圧力が小さく消耗が少ない（脚を溜める）。離れ具合 0〜1 に掛ける
 * - saveKick：スパート時に残っているスタミナが多いほど末脚が伸びる度合い
 * - duelDrain：ハナ争いをしている馬の消耗の上乗せ
 * - draft：他馬の直後につけたときの消耗の倍率（風よけ）
 * - myPace：競りかけられない逃げ馬のペース（基準ペースに対する割合）
 * - relaxDistExp：溜めの効果を距離で弱める指数（溜め × (1600/距離)^指数。長いレースほど溜めの差が積み上がりすぎないように）
 * - respondWindow：後ろから並びかけられたときに応戦して仕掛ける範囲（予定の仕掛け地点の何倍の距離から）
 * - fadeFloor：スタミナが尽きたときの速度の割合（スタミナが残り少ないほど、この値まで直線的に落ちる）
 * - leaderRelax：競りかけられずに自分のペースで行く先頭の馬の溜め（後方の馬の最大の溜めに対する割合）
 * 第8段階で追加（docs/13-race-simulation.md）：
 * - condScale：当日の出来の幅（ability.ts の conditionSd に掛ける）。騎手など、まだ表していない要素の分も含む
 * - timingSd・posScale・kickSd：仕掛けの地点（m）・位置取り・末脚のばらつき（騎手の判断と展開の不確実性）
 * - laneCost：序盤の横移動 1m あたりのスタミナの消耗
 * - makuri：スローペースで、後方の馬が予定より早く仕掛ける地点（予定の仕掛け地点の倍率）
 * - respondFront：後ろの馬が仕掛けたとき、前の集団が応じて仕掛ける範囲（予定の仕掛け地点の倍率）
 * - fight：直線の叩き合いで、勝負根性の差 1 あたりの速度の差
 * - spurtSpread：脚質ごとの仕掛け地点の差の大きさ（1 で以前どおり）
 * - spreadPer：道中の隊列の長さ（1頭あたり m）
 * - earlyDash：序盤の位置取り争いで隊列が巡航より速く流れる割合（1200m・逃げ馬2頭のとき）
 * - tuckAhead・tuckBehind：内へ寄せるときに空いている必要がある前後の距離（m）
 */
export const TUNE = {
  relax: 0.18,
  saveKick: 0.02,
  duelDrain: 2.4,
  draft: 0.94,
  myPace: 0.99,
  leaderRelax: 0,
  fadeFloor: 0.9,
  relaxDistExp: 0.7,
  respondWindow: 1.4,
  // 第8段階
  condScale: 3.3,
  timingSd: 80,
  posScale: 1.5,
  kickSd: 0.008,
  laneCost: 0.0005,
  makuri: 1.35,
  respondFront: 1.6,
  spurtSpread: 0.5,
  spreadPer: 1.6,
  earlyDash: 0.06,
  tuckAhead: 0.4,
  tuckBehind: 0.8,
  spreadScale: 1,
  ease: 0.3,
  tuckSlow: 0.03,
  fight: 0.02,
};
/**
 * 先頭のペースへのついて行き方（第8段階）：1 なら先頭と同じ速さで追走、0 なら先頭に関係なく基準のペース。
 * 前の馬ほど先頭について行き、後ろの馬は自分のペースを守る（ハイペースでは隊列が縦長になり、後ろの馬が脚を溜められる）
 */
/** ペース判定のしきい値（後半 ÷ 前半 − 1） */
/** 距離ごとの標準的な「後半 ÷ 前半 − 1」（多数のレースの中央値） */
const HALF_BASE: [number, number][] = [
  [1200, 0.025],
  [1600, -0.007],
  [2400, -0.032],
];
/** 発馬の加速で前半にかかる余分な時間（秒。推定） */
const START_LOSS = 1.0;
export const PACE_THRESH = { slow: -0.0135, high: 0.0135 };
const PACE_SLOW = (): number => PACE_THRESH.slow;
const PACE_HIGH = (): number => PACE_THRESH.high;
const TRACK: Record<RunningStyle, number> = { nige: 1, senko: 0.85, sashi: 0.55, oikomi: 0.3 };

/** 距離による速さの倍率（推定の較正。1,800〜2,400m を基準の 1） */
/** 巡航速度の割合（推定。JRA の良馬場の一般的な前半・後半3Fの目安に合わせる） */
const CRUISE: [number, number][] = [
  [1000, 1.0],
  [1200, 0.99],
  [1600, 0.97],
  [2000, 0.955],
  [2400, 0.945],
  [3200, 0.93],
];
/** スタミナの使い切り具合（基準ペースで走ったときに使うスタミナの割合。推定） */
const USAGE: [number, number][] = [
  [1000, 0.9],
  [1400, 0.88],
  [2000, 0.85],
];
/**
 * 短距離の終いの失速（推定）：短距離は前半から速く流れるため、どの馬も最後の600mで少しずつ脚が鈍る（スタミナの能力とは別の、全馬に共通の疲れ）。
 * ゴールでの速度の低下の割合。実際の芝1200mの前半3F・後半3Fの目安（後半の方が遅い）に合わせる
 */
const FINAL_DECEL: [number, number][] = [
  [1000, 0.08],
  [1200, 0.09],
  [1600, 0.04],
  [2000, 0.0],
];
/** スピードの能力の効き方（距離による倍率。推定） */
const SPEED_K: [number, number][] = [
  [1200, 1.2],
  [2000, 1.0],
  [3000, 0.85],
];
const DIST_SPEED: [number, number][] = [
  [1000, 1.061],
  [1200, 1.031],
  [1400, 1.009],
  [1600, 0.993],
  [1800, 0.979],
  [2000, 0.974],
  [2400, 0.975],
  [3600, 0.977],
];
function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

export function simulateRace(cond: RaceConditions, runners: SimRunner[], seed: string, opts: SimOptions = {}): SimResult {
  const dt = opts.dt ?? 0.1;
  const record = opts.record ?? true;
  const rng = new Rng(`${seed}|${ENGINE_VERSION}`);
  const course = courseFor(cond.surface, cond.layout, cond.venue);
  const n = runners.length;
  const D = cond.distance;
  const g = GOING_INDEX[cond.going];
  // 道中の巡航速度（最高速度に対する割合。第8段階で見直し）：短距離ほど最高速度に近いペースで流れ、直線で伸びる余地が小さい
  // （実際の芝1200mは前半3Fの方が後半3Fより速いことが多い）。中長距離ほど道中に余裕があり、直線で加速する
  const cruiseFrac = interp(CRUISE, D);
  const goingDrain = cond.surface === 'turf' ? 1 + 0.06 * g : 1 + 0.02 * g;

  // 距離による速さ（推定の較正）：短距離ほど道中が速い。JRA の良馬場の一般的な走破時計の目安に合わせる（docs/11-venues.md）
  const distSpeed = interp(DIST_SPEED, D);
  // 北海道（札幌・函館）の洋芝は、野芝より時計がかかる（公式のコース紹介）。
  // 第7段階からはクッション値で表す（硬いほど速い：1 につき 0.4%。推定）。クッション値のない古いレースは以前どおり
  const grassSpeed =
    cond.surface !== 'turf' ? 1 : cond.cushion !== undefined ? 1 + 0.004 * (cond.cushion - 9.6) : cond.venue && VENUES[cond.venue].grass === '洋芝' ? 0.994 : 1;
  // 内外の差：内側の芝が傷んでいるほど、内ラチ沿い（6m 以内）が遅い（最大 0.4%。重い馬場ほど大きい。推定）
  const wearPenalty = cond.surface === 'turf' && cond.wear ? 0.004 * cond.wear * (1 + GOING_INDEX[cond.going] / 3) : 0;

  const speedK = interp(SPEED_K, D);

  // ---- 馬ごとのパラメータ（能力・適性の効き方は ability.ts。乱数の消費順は固定） ----
  const traits = courseTraits(course);
  const P = runners.map((r) => {
    const h = r.horse;
    const prof = profileOf(h);
    const ab = raceAbility(prof, { surface: cond.surface, distance: D, goingIndex: g, course: traits, month: cond.month });
    // 当日の出来（調子とは別の、その日のレースでの能力の出し具合）。第8段階で幅を広げた（TUNE.condScale）
    const condition = rng.normal(0, ab.conditionSd * TUNE.condScale);
    const base = (cond.surface === 'turf' ? 17.9 - 0.12 * g : (17.3 + 0.07 * g) * 0.993) * distSpeed * grassSpeed;
    // スピードの差は短距離ほど効く（道中から最高速度に近いペースで流れるため。長距離はスタミナの比重が増す）
    // 能力・適性・当日の出来による速度の差は TUNE.spreadScale 倍にそろえて縮める（第8段階：着差が実際の競馬に近くなるように）
    const vTop0 = base + ((h.speed - 75) * 0.018 * speedK + ab.speedAdj + condition) * TUNE.spreadScale;
    // 負担重量（raceclass.ts。1kg ≒ 1馬身の目安）
    const we = weightEffect(r.weight, D);
    const vTop = vTop0 * we.speed;
    const kakari = rng.chance(ab.kakariProb);
    const kakariStart = rng.range(4, 12);
    const kakariDur = rng.range(10, 28) * ab.kakariDuration;
    let startDelay = ab.startDelay + Math.abs(rng.normal(0, 0.06));
    const lateStart = rng.chance(ab.lateStartProb);
    if (lateStart) startDelay += rng.range(0.5, 1.0);
    // 仕掛けの地点は騎手の判断でばらつく（第8段階で幅を 40m → TUNE.timingSd に）
    const spurtDist = (580 + (SPURT_DIST[h.style] - 580) * TUNE.spurtSpread) * clamp(D / 1600, 0.85, 1.2) + rng.normal(0, TUNE.timingSd);
    const gapFrac = GAP_FRAC[h.style] + rng.normal(0, ab.positionNoise * TUNE.posScale);
    const kick = (rng.normal(0, TUNE.kickSd) + ab.kick) * TUNE.spreadScale;
    return {
      style: h.style,
      vTop,
      aptitude: ab.speedAdj,
      breakdown: ab.breakdown,
      condition,
      // スタミナの差も同じ割合で縮める（速度の差だけ縮めると、相対的にスタミナが効きすぎる）
      staminaFactor: (1.125 + (ab.staminaFactor - 1.125) * TUNE.spreadScale) * we.stamina,
      weight: r.weight,
      weightEffect: vTop - vTop0,
      kakari,
      kakariStart,
      kakariEnd: kakariStart + (kakari ? kakariDur : 0),
      startDelay,
      lateStart,
      spurtDist,
      gapFrac,
      kick,
      aStart: ab.aStart,
      aRun: ab.aRun,
      spurtDrain: ab.spurtDrain,
      fadeThreshold: ab.fadeThreshold,
      cornerFactor: ab.cornerFactor,
      earlySpeed: ab.earlySpeed,
      /** 逃げ馬がいないために押し出された先頭（自分のペースでゆったり行く） */
      reluctantLead: false,
      // 上り坂での失速の受けやすさ（パワーと坂適性）
      hill: ab.hill,
      // 勝負根性（直線の叩き合いの強さ）：持続力と気性から（0〜1）
      guts: clamp((prof.sustain * 0.6 + prof.temper * 0.4) / 100, 0, 1),
    };
  });

  // 脚質は目安であり、実際の位置取りは出走メンバーで変わる：
  // - テンの速さ（ゲート・瞬発力・スピード・気性）がメンバーの中で速い馬ほど前に、遅い馬ほど後ろになる
  // - 逃げ馬がいないときは、テンの速い先行馬がハナに立つ（スローペースになりやすい）
  const meanEarly = P.reduce((s, p) => s + p.earlySpeed, 0) / n;
  P.forEach((p) => {
    p.gapFrac = Math.max(0, p.gapFrac + (meanEarly - p.earlySpeed) * 0.6);
  });
  if (!P.some((p) => p.style === 'nige')) {
    // テンの速さが同じくらいなら、その日の出方（乱数）で決まる
    const es = P.map((p) => p.earlySpeed + rng.normal(0, 0.02));
    const lead = P.reduce((a, p, i) => (p.style === 'senko' && (a < 0 || es[i] > es[a]) ? i : a), -1);
    if (lead >= 0) {
      P[lead].gapFrac = 0;
      P[lead].reluctantLead = true;
    }
  }

  const paceRef = (P.reduce((s, p) => s + p.vTop, 0) / n) * cruiseFrac;
  // 隊列の長さ：1頭あたり TUNE.spreadPer m（第8段階で 1.5m → 実際の競馬の道中の隊列（16頭で15〜20馬身）に近づけた）
  const spread = n * TUNE.spreadPer;
  const expectedTime = D / paceRef;
  const spurtFrac = Math.min(0.5, 600 / D);
  const relaxScale = Math.pow(1600 / D, TUNE.relaxDistExp);
  // 騎手は出走馬のスタミナに見合ったペースで乗る：長距離で出走馬のスタミナ（中央値）が距離に足りないときは、消耗を小さくする
  // （3,000m級で全頭がばてて走破時計が極端に遅くなるのを防ぐ。スタミナの相対的な差はそのまま効く）
  const sfs = P.map((p) => p.staminaFactor).sort((a, b) => a - b);
  const sfMed = sfs[Math.floor(sfs.length / 2)];
  // 2,400m までは補正なし、3,000m 以上で半分（平方根）まで。中距離ではスタミナの差がそのまま効く
  const relief = 0.5 * clamp((D - 2400) / 600, 0, 1);
  // スタミナの使い切り具合：短距離ほど余裕がなく、最後の1ハロンで脚が鈍る（推定。前半・後半3Fの目安に合わせる）
  const usage = interp(USAGE, D);
  // 序盤の位置取り争い（テンの速さ）の区間と強さ
  const finalDecel = interp(FINAL_DECEL, D);
  // 抜け出した馬を流しはじめる差（m）。騎手と展開による（レースごとに 0.5〜2.5馬身）
  const easeAt = rng.range(0.5, 2.5) * 2.4;
  const earlyEnd = Math.min(700, D * 0.4);
  // 先手争いの激しさは、ハナを主張する逃げ馬の数で決まる（0頭で半分、1頭で 0.75、2頭で標準、3頭以上で最大 1.25 倍）
  const nigeCount = P.filter((p) => p.style === 'nige').length;
  const earlyDash = TUNE.earlyDash * Math.sqrt(1200 / D) * clamp(0.5 + 0.25 * nigeCount, 0.5, 1.25);
  // 消耗の基準：基準ペースで走った馬（序盤の速い流れ・道中・スパートの区間ごとの速さ）が、スタミナのちょうど usage を使う
  const eFrac = earlyEnd / D;
  const profile = eFrac * Math.pow(cruiseFrac * (1 + earlyDash / 2), 4) + Math.max(0, 1 - spurtFrac - eFrac) * Math.pow(cruiseFrac, 4) + spurtFrac;
  const drainK = ((usage * 1.125) / (expectedTime * profile)) * Math.pow(Math.min(1, sfMed / 1.125), relief);

  // ---- 状態 ----
  const x = new Float64Array(n);
  const lane = new Float64Array(n);
  const v = new Float64Array(n);
  const S = new Float64Array(n).fill(1);
  const laneTarget = new Float64Array(n);
  const noise = new Float64Array(n);
  const xPrev = new Float64Array(n);
  const lanePrev = new Float64Array(n);
  const vPrev = new Float64Array(n);
  const finishT = new Array<number>(n).fill(Infinity);
  const t600 = new Array<number>(n).fill(NaN);
  const spurting = new Array<boolean>(n).fill(false);
  const blockedT = new Float64Array(n);
  const laneLoss = new Float64Array(n);
  const duelT = new Float64Array(n);
  const gaveUp = new Array<boolean>(n).fill(false);
  const earlyLat = new Float64Array(n);
  const makuri = new Array<boolean>(n).fill(false);
  const fought = new Array<boolean>(n).fill(false);
  // 段階の区切り：スタート直後 200m、序盤の終わり（距離の 25%・最低 400m）、中盤の終わり（直線の入口の 600m 手前）、直線の入口
  const straightAt = D - course.finishU;
  const phaseMarks = [200, Math.max(400, D * 0.25), Math.max(Math.max(400, D * 0.25) + 100, straightAt - 600), straightAt];
  const phaseOrders: number[][] = [];
  // 中盤の先頭の速さ（まくりの判断に使う）
  let leadSum = 0;
  let leadCnt = 0;
  const flags = { blocked: new Array<boolean>(n).fill(false), fade: new Array<boolean>(n).fill(false) };
  const events: SimEvent[] = [];

  runners.forEach((r, i) => {
    lane[i] = 0.6 + (r.number - 1) * 1.05;
    laneTarget[i] = lane[i];
    if (P[i].lateStart) events.push({ t: 0, type: 'late_start', runner: i });
  });

  const laps = Math.floor(D / 200);
  const crossT = new Array<number>(laps + 1).fill(NaN);
  crossT[0] = 0;
  const corners = cornersOnRoute(course, D).map((c) => ({ ...c, order: [] as number[] }));
  let cornerIdx = 0;
  let lastLeader = -1;
  let lastLeadEventT = -10;

  const maxT = D / 12 + 30;
  const maxFrames = Math.ceil(maxT / dt) + 2;
  const data = record ? new Float32Array(maxFrames * n * 3) : null;
  let frame = 0;
  let t = 0;
  let finishedCount = 0;
  let lastFinishT = Infinity;

  /** cand レーンの前方 ahead(m)・後方 behind(m) に他馬がいなければ移動できる */
  const isFree = (i: number, cand: number, ahead = 3.0, behind = 1.5): boolean => {
    if (cand < 0.4 || cand > course.width - 1) return false;
    for (let k = 0; k < n; k++) {
      if (k === i || finishT[k] < Infinity) continue;
      const dx = xPrev[k] - xPrev[i];
      if (dx < ahead && dx > -behind && Math.abs(lanePrev[k] - cand) < 0.95) return false;
    }
    return true;
  };

  const writeFrame = () => {
    if (!data) return;
    const base = frame * n * 3;
    for (let i = 0; i < n; i++) {
      data[base + i * 3] = x[i];
      data[base + i * 3 + 1] = lane[i];
      data[base + i * 3 + 2] = v[i] + noise[i];
    }
  };
  writeFrame();
  frame++;

  while (t < maxT && !(finishedCount === n && t > lastFinishT + 4)) {
    xPrev.set(x);
    lanePrev.set(lane);
    vPrev.set(v);

    // 先頭馬（未入線の中で最も前）
    let leader = 0;
    for (let i = 1; i < n; i++) if (xPrev[i] > xPrev[leader]) leader = i;
    const leaderX = xPrev[leader];
    if (leader !== lastLeader && leaderX > 150 && leaderX < D && t - lastLeadEventT > 3) {
      events.push({ t, type: 'lead', runner: leader });
      lastLeadEventT = t;
    }
    lastLeader = leader;

    // 仕掛けた馬がいるか、前の集団（先頭から 35% 以内の順位）の位置
    let anySpurt = false;
    let meanS = 0;
    for (let k = 0; k < n; k++) {
      if (spurting[k] && finishT[k] === Infinity) anySpurt = true;
      meanS += S[k] / n;
    }
    const sortedX = Array.from(xPrev).sort((a, b) => b - a);
    // 2番手（先頭を除いて最も前にいる、まだ入線していない馬）
    let second = -1;
    for (let k = 0; k < n; k++) if (k !== leader && finishT[k] === Infinity && (second < 0 || xPrev[k] > xPrev[second])) second = k;
    const frontX = sortedX[Math.min(n - 1, Math.floor(n * 0.35))];

    for (let i = 0; i < n; i++) {
      const p = P[i];

      // 入線後は流して減速
      if (finishT[i] < Infinity) {
        v[i] = Math.max(8, v[i] - 1.6 * dt);
        noise[i] *= 0.9;
        x[i] += v[i] * dt;
        continue;
      }
      if (t < p.startDelay) continue;

      const rem = D - xPrev[i];
      const uNow = raceU(course, D, xPrev[i]);
      const grade = gradeAt(course, uNow);
      const fatigue = S[i] >= p.fadeThreshold ? 1 : TUNE.fadeFloor + ((1 - TUNE.fadeFloor) * S[i]) / p.fadeThreshold;
      const vMax = p.vTop * fatigue * (wearPenalty > 0 ? 1 - wearPenalty * Math.max(0, 1 - lane[i] / 6) : 1);
      const kakariActive = p.kakari && t >= p.kakariStart && t < p.kakariEnd;
      if (p.kakari && Math.abs(t - p.kakariStart) < dt / 2) events.push({ t, type: 'kakari', runner: i });

      // 仕掛け：予定の地点に来たとき、または後ろから仕掛けてきた馬に並びかけられたとき（応戦。予定の地点に近い場合）
      let challenged = false;
      if (!spurting[i] && rem <= p.spurtDist * TUNE.respondWindow) {
        for (let k = 0; k < n; k++) {
          const dx = xPrev[i] - xPrev[k];
          if (k !== i && spurting[k] && finishT[k] === Infinity && dx > -1 && dx < 4 && vPrev[k] > vPrev[i]) {
            challenged = true;
            break;
          }
        }
      }
      // まくり（騎手の判断）：中盤の先頭のペースが遅く、後方で脚が残っている差し・追込は早めに動く
      const slowPace = leadCnt > 20 && leadSum / leadCnt < paceRef * 0.995;
      const goEarly =
        !spurting[i] && slowPace && (p.style === 'sashi' || p.style === 'oikomi') && S[i] > meanS + 0.03 && leaderX - xPrev[i] > spread * 0.3 && rem <= p.spurtDist * TUNE.makuri;
      if (goEarly) {
        makuri[i] = true;
        events.push({ t, type: 'makuri', runner: i });
      }
      // ペースアップへの対応（騎手の判断）：後ろの馬が仕掛けたら、前にいる馬も脚が残っていれば早めに仕掛ける
      const respond = !spurting[i] && anySpurt && xPrev[i] >= frontX && S[i] > 0.55 && rem <= p.spurtDist * TUNE.respondFront;
      if (!spurting[i] && (goEarly || challenged || respond || rem <= p.spurtDist * clamp(0.7 + S[i] * 0.6, 0.75, 1.25))) {
        spurting[i] = true;
        events.push({ t, type: 'spurt', runner: i });
      }

      let target: number;
      if (spurting[i]) {
        // 脚を溜めた馬ほど末脚が伸びる
        target = vMax * (1 + p.kick + TUNE.saveKick * clamp(S[i] - 0.3, -0.3, 0.4));
        // 直線の叩き合い：残り300mで、並んで追い比べている馬がいれば、勝負根性の強い方が伸び、弱い方は脚が鈍る
        if (rem < 300) {
          for (let k = 0; k < n; k++) {
            if (k !== i && spurting[k] && finishT[k] === Infinity && Math.abs(xPrev[k] - xPrev[i]) < 1.2 && Math.abs(lanePrev[k] - lanePrev[i]) < 2.5) {
              target *= 1 + TUNE.fight * (p.guts - P[k].guts);
              if (!fought[i]) {
                fought[i] = true;
                if (p.guts >= P[k].guts) events.push({ t, type: 'fight', runner: i, other: k });
              }
              break;
            }
          }
        }
        // 抜け出した馬は、ゴール前で騎手が追うのをやめる（大差がつきすぎない。残り250m、2番手に1.5馬身以上の差があるとき）
        // 2番手の速さに合わせて流すので、差は流しはじめる差（レースごとに 0.5〜2.5馬身）まで縮んでいく（最高速度の 90% より遅くはしない）
        if (i === leader && rem < 300 && second >= 0) {
          const lead = xPrev[i] - xPrev[second];
          if (lead > easeAt) target = Math.min(target, Math.max(vMax * 0.9, vPrev[second] - (TUNE.ease * (lead - easeAt)) / 2.4));
        }
      } else {
        const gapTarget = (gaveUp[i] ? 0.2 : p.gapFrac) * spread;
        const gap = leaderX - xPrev[i];
        // 追走する馬は先頭のペースに合わせ、目標の位置との差だけ速度を調整する（逃げ馬のペースが隊列のペースになる）
        const lead = i === leader ? paceRef : Math.max(vPrev[leader], paceRef * 0.95);
        // 先頭が速すぎる（ハイペース）とき、後ろの馬は無理について行かない（TRACK）
        const tr = TRACK[p.style];
        const base = paceRef + (lead - paceRef) * tr;
        target = base + clamp((gap - gapTarget) * 0.06, -0.15, 0.6 * tr + 0.1);
        if (p.style === 'nige' && !gaveUp[i]) {
          if (i === leader) {
            // 後ろから別の逃げ馬が競りかけてくればハナを譲らず応戦する
            let rival = -1;
            for (let k = 0; k < n; k++) {
              if (k !== i && P[k].style === 'nige' && !gaveUp[k] && leaderX - xPrev[k] < 1.8) rival = k;
            }
            if (rival >= 0) {
              target += 0.4;
              if (duelT[i] === 0) events.push({ t, type: 'duel', runner: i, other: rival });
              duelT[i] += dt;
            } else {
              target = paceRef * TUNE.myPace; // 単騎逃げ：マイペース
            }
          } else if (gap < 2.5) {
            // ハナを奪いに行く。先頭も逃げ馬なら競り合い（ハナ争い）になる
            target += 0.4;
            if (P[leader].style === 'nige') duelT[i] += dt;
          }
          if (i !== leader && duelT[i] > 22) gaveUp[i] = true;
        }
        // 押し出された先頭は、競りかけられない限り無理をしない（逃げ馬不在のスローペース）
        if (p.reluctantLead && i === leader) target = paceRef * 0.975;
        if (kakariActive) target += 0.35;
        // 序盤の位置取り争い（テンの速さ）：スタートから序盤の終わりまで、隊列全体が巡航より速く流れる（短距離ほど大きい。推定）。
        // 速く走る分だけスタミナを使う（消耗は速度の4乗）ので、短距離では終盤に脚が鈍る
        if (xPrev[i] < earlyEnd) target *= 1 + earlyDash * (1 - xPrev[i] / earlyEnd);
        target = Math.min(target, vMax * 1.02);
      }

      // 前の馬との干渉（進路の詰まり）
      let ahead = -1;
      let aheadDx = Infinity;
      for (let k = 0; k < n; k++) {
        if (k === i || finishT[k] < Infinity) continue;
        const dx = xPrev[k] - xPrev[i];
        if (dx > 0 && dx < 3.2 && Math.abs(lanePrev[k] - lanePrev[i]) < 1.0 && dx < aheadDx) {
          ahead = k;
          aheadDx = dx;
        }
      }
      if (ahead >= 0 && target > vPrev[ahead]) {
        const wantsOut = spurting[i] || xPrev[leader] - xPrev[i] > p.gapFrac * spread + 2;
        let moved = false;
        if (wantsOut) {
          // 長く詰まっている馬は、後ろの馬に構わず強引に外へ持ち出す
          const behind = blockedT[i] > 1.5 ? 0.3 : 1.5;
          for (const cand of [lanePrev[i] + 1.3, lanePrev[i] - 1.3, lanePrev[i] + 2.5, lanePrev[i] + 3.7]) {
            if (isFree(i, cand, 3.0, behind)) {
              laneTarget[i] = cand;
              moved = true;
              break;
            }
          }
        }
        if (!moved || aheadDx < 1.8) {
          target = Math.min(target, vPrev[ahead]);
          if (spurting[i] && !moved) {
            blockedT[i] += dt;
            if (!flags.blocked[i] && blockedT[i] > 2.0) {
              flags.blocked[i] = true;
              events.push({ t, type: 'blocked', runner: i });
            }
          }
        }
      } else if (!spurting[i] && lanePrev[i] > 0.8) {
        // 内ラチ沿いへ寄せる（第8段階：前の馬の後ろに入れるなら、すぐ横の馬と重ならない範囲で内へ。外枠の馬も隊列に収まる）
        let movedIn = false;
        for (const step of [0.9, 0.5]) {
          if (isFree(i, lanePrev[i] - step, TUNE.tuckAhead, TUNE.tuckBehind)) {
            laneTarget[i] = Math.max(0.6, lanePrev[i] - step);
            movedIn = true;
            break;
          }
        }
        // 控える（騎手の判断）：序盤に外にいて内へ入れない、ハナを主張しない馬は、少し速度を落として前の馬の後ろに入る
        if (!movedIn && xPrev[i] < earlyEnd && lanePrev[i] > 1.2 && p.style !== 'nige' && i !== leader) target *= 1 - TUNE.tuckSlow;
      }

      // 短距離の終いの失速（全馬に共通）
      if (finalDecel > 0 && rem < 600) target *= 1 - finalDecel * (1 - rem / 600);
      // 坂：上りは減速（パワーと坂適性で軽減）、下りはわずかに加速
      target *= 1 - 2.4 * Math.max(0, grade) * p.hill + 0.9 * Math.max(0, -grade);
      // コーナー：小回り適性の低い馬は、きついコーナーで速度を落とす
      if (Math.abs(curvatureAt(course, uNow)) > 1 / 1500) target *= p.cornerFactor;

      // 加減速
      if (v[i] < target) {
        // スタートの加速は巡航速度の近くまで続く（第8段階：以前は基準ペースの95%までで、残りをゆっくり加速していた）
        const a = v[i] < 0.99 * paceRef ? p.aStart : p.aRun;
        v[i] = Math.min(target, v[i] + a * dt);
      } else {
        v[i] = Math.max(target, v[i] - 1.2 * dt);
      }
      noise[i] += -noise[i] * 0.3 * dt + rng.normal(0, 0.02) * Math.sqrt(dt);
      const vEff = Math.max(0, v[i] + noise[i]);

      // スタミナ消費（他馬の直後につけると風よけになり消耗が減る）
      let draft = 1;
      for (let k = 0; k < n; k++) {
        const dx = xPrev[k] - xPrev[i];
        if (k !== i && dx > 0.5 && dx < 4 && Math.abs(lanePrev[k] - lanePrev[i]) < 1.2) {
          draft = TUNE.draft;
          break;
        }
      }
      const ratio = vEff / p.vTop;
      const hillDrain = 1 + 6 * Math.max(0, grade) * p.hill;
      // ハナ争い：逃げ馬どうしが 2.5m 以内で競り合っているか
      let contested = false;
      if (!spurting[i] && p.style === 'nige' && !gaveUp[i]) {
        for (let k = 0; k < n; k++) {
          if (k !== i && P[k].style === 'nige' && !gaveUp[k] && !spurting[k] && Math.abs(xPrev[k] - xPrev[i]) < 2.5) {
            contested = true;
            break;
          }
        }
      }
      // 持続力：スパート中の消耗の大きさ
      const sustainK = spurting[i] ? p.spurtDrain : 1;
      // 脚を溜める：スパート前に先頭から離れて追走している馬ほど消耗が少ない
      let behind = spurting[i] ? 0 : clamp((leaderX - xPrev[i]) / spread, 0, 1);
      if (!spurting[i] && i === leader && !contested) behind = TUNE.leaderRelax;
      const relaxK = 1 - TUNE.relax * relaxScale * behind;
      // ハナ争い：競り合っている間は消耗が大きい
      const duelK = contested ? TUNE.duelDrain : 1;
      S[i] = Math.max(0, S[i] - (drainK * ratio ** 4 * goingDrain * draft * hillDrain * sustainK * relaxK * duelK * (kakariActive ? 1.4 : 1) * dt) / p.staminaFactor);
      if (!flags.fade[i] && S[i] < 0.05 && rem > 200) {
        flags.fade[i] = true;
        events.push({ t, type: 'fade', runner: i });
      }

      // 横移動と前進（コーナーで外を回るほど進みが減る）
      const dLane = clamp(laneTarget[i] - lane[i], -0.8 * dt, 0.8 * dt);
      lane[i] += dLane;
      // 序盤の横移動（外枠から内へ入る・前へ出る）はスタミナを使う
      if (xPrev[i] < phaseMarks[1]) {
        earlyLat[i] += Math.abs(dLane);
        S[i] = Math.max(0, S[i] - TUNE.laneCost * Math.abs(dLane));
      }
      // コーナーで外を回るほど進みが減る（曲率 κ のとき 1/(1+κ·レーン)）
      // 発走直後の 250m は、実際はポケット（コースの外に張り出した直線の発走地点）を走ることが多いので、外を回る距離損を小さくする（近似）
      const chute = clamp(xPrev[i] / 250, 0, 1);
      const progress = (vEff * dt) / (1 + curvatureAt(course, uNow) * lane[i] * chute);
      laneLoss[i] += vEff * dt - progress;
      x[i] = xPrev[i] + progress;

      if (xPrev[i] < D - 600 && x[i] >= D - 600) {
        t600[i] = t + (dt * (D - 600 - xPrev[i])) / (x[i] - xPrev[i]);
      }
      if (x[i] >= D) {
        finishT[i] = t + (dt * (D - xPrev[i])) / (x[i] - xPrev[i]);
        finishedCount++;
        if (finishedCount === n) lastFinishT = finishT[i];
        events.push({ t: finishT[i], type: 'finish', runner: i });
      }
    }

    // 先頭馬の200mごとの通過タイム
    let maxX = 0;
    let maxXPrev = 0;
    for (let i = 0; i < n; i++) {
      if (x[i] > maxX) maxX = x[i];
      if (xPrev[i] > maxXPrev) maxXPrev = xPrev[i];
    }
    for (let k = 1; k <= laps; k++) {
      if (Number.isNaN(crossT[k]) && maxX >= k * 200) {
        crossT[k] = t + (dt * (k * 200 - maxXPrev)) / Math.max(1e-6, maxX - maxXPrev);
      }
    }
    // 中盤の先頭の速さ
    if (maxX > phaseMarks[1] && maxX < phaseMarks[2]) {
      leadSum += v[leader];
      leadCnt++;
    }
    // 段階の区切りの隊列（先頭馬が区切りを通過した時点）
    while (phaseOrders.length < phaseMarks.length && maxX >= phaseMarks[phaseOrders.length]) {
      phaseOrders.push(Array.from({ length: n }, (_, i) => i).sort((a, b) => x[b] - x[a]));
    }
    // コーナー通過順（先頭馬が通過した時点の隊列）
    if (cornerIdx < corners.length && maxX >= corners[cornerIdx].at) {
      corners[cornerIdx].order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[b] - x[a]);
      cornerIdx++;
    }

    t += dt;
    writeFrame();
    frame++;
    if (frame >= maxFrames) break;
  }

  // 規定時間内に入線しなかった馬は現在位置から推定（通常は発生しない）
  for (let i = 0; i < n; i++) {
    if (finishT[i] === Infinity) finishT[i] = t + (D - x[i]) / Math.max(1, v[i]);
    if (Number.isNaN(t600[i])) t600[i] = finishT[i] - 600 / Math.max(1, v[i]);
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => finishT[a] - finishT[b]);
  const margins = new Array<string>(n).fill('');
  for (let k = 1; k < n; k++) {
    const dtime = finishT[order[k]] - finishT[order[k - 1]];
    margins[order[k]] = marginLabel((dtime * 16.5) / 2.4);
  }
  const splits: number[] = [];
  for (let k = 1; k <= laps; k++) splits.push(crossT[k] - crossT[k - 1]);
  const first3F = crossT[3];
  const final3F = crossT[laps] - crossT[laps - 3];

  // 中盤の先頭の平均速度と基準ペースの比（実況の「速い流れ」などに使う）
  const midEnd = Math.max(3, laps - 3);
  const midSpeed = ((midEnd - 1) * 200) / (crossT[midEnd] - crossT[1]);
  const paceRatio = midSpeed / paceRef;
  // ペース判定（第8段階）：実際の競馬と同じく、先頭の前半と後半のタイムの差で決める（前半が速いほどハイペース）。
  // 後半 ÷ 前半 − 1 を距離で補正した値（PACE_SLOW 以下 スロー、PACE_HIGH 以上 ハイ）。しきい値は多数のレースの分布の上下およそ25%
  // 先頭が距離のちょうど半分を通過した時刻（200m ごとの通過時刻から補間）。前半は発馬の加速（約1秒）を除く
  const hk = D / 2 / 200;
  const k0 = Math.floor(hk);
  const tHalf = crossT[k0] + (crossT[Math.min(laps, k0 + 1)] - crossT[k0]) * (hk - k0);
  const tWin = Math.min(...finishT);
  // 距離ごとの標準的な前後半の差（短距離は前半が速いのがふつう）を引いた値で判定する
  const halfDiff = (tWin - tHalf) / Math.max(1, tHalf - START_LOSS) - 1 - interp(HALF_BASE, D);
  const pace: Pace = halfDiff >= PACE_HIGH() ? 'high' : halfDiff <= PACE_SLOW() ? 'slow' : 'middle';

  const lastCorner = corners.filter((c) => c.order.length).at(-1);
  // 実際の位置取り：最初に記録したコーナー（またはゴール前の隊列）での順位の割合
  const firstOrder = corners.find((c) => c.order.length)?.order ?? order;
  const actualStyleOf = (i: number): RunningStyle => {
    const r = firstOrder.indexOf(i) / Math.max(1, n - 1);
    return firstOrder.indexOf(i) === 0 ? 'nige' : r <= 0.35 ? 'senko' : r <= 0.75 ? 'sashi' : 'oikomi';
  };
  const factors: RunnerFactors[] = P.map((p, i) => ({
    style: p.style,
    topSpeed: p.vTop,
    aptitude: p.aptitude,
    condition: p.condition,
    staminaEnd: S[i],
    laneLoss: laneLoss[i],
    blockedTime: blockedT[i],
    kakari: p.kakari,
    startDelay: p.startDelay,
    lateStart: p.lateStart,
    gaveUpLead: gaveUp[i],
    posAtLastCorner: lastCorner ? lastCorner.order.indexOf(i) + 1 : 0,
    breakdown: p.breakdown,
    actualStyle: actualStyleOf(i),
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
    weightEffect: p.weightEffect,
    phasePos: [...phaseOrders.map((o) => o.indexOf(i) + 1), order.indexOf(i) + 1],
    earlyLateral: earlyLat[i],
    makuri: makuri[i],
    fought: fought[i],
  }));

  events.sort((a, b) => a.t - b.t);
  return {
    dt,
    n,
    frames: frame,
    data: data ? data.subarray(0, frame * n * 3) : null,
    finishTimes: finishT,
    order,
    margins,
    last3F: finishT.map((ft, i) => ft - t600[i]),
    splits,
    cornerOrders: corners.filter((c) => c.order.length),
    pace,
    halfDiff,
    phaseMarks,
    paceRatio,
    first3F,
    final3F,
    events,
    factors,
  };
}

/** 走行ログから時刻 time の各馬の状態を線形補間で取り出す（描画用） */
export function sampleAt(res: SimResult, time: number, out: { x: number; lane: number; v: number }[]): void {
  if (!res.data) throw new Error('record=false の結果からはサンプリングできません');
  const f = clamp(time / res.dt, 0, res.frames - 1);
  const f0 = Math.floor(f);
  const f1 = Math.min(res.frames - 1, f0 + 1);
  const a = f - f0;
  const d = res.data;
  for (let i = 0; i < res.n; i++) {
    const b0 = (f0 * res.n + i) * 3;
    const b1 = (f1 * res.n + i) * 3;
    const o = out[i] ?? (out[i] = { x: 0, lane: 0, v: 0 });
    o.x = d[b0] + (d[b1] - d[b0]) * a;
    o.lane = d[b0 + 1] + (d[b1 + 1] - d[b0 + 1]) * a;
    o.v = d[b0 + 2] + (d[b1 + 2] - d[b0 + 2]) * a;
  }
}

export function formatTime(sec: number): string {
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : s.toFixed(1);
}
