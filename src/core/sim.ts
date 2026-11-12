/**
 * レースシミュレーター（決定論的・0.1秒刻みのエージェントモデル）。
 *
 * 同じ (条件, 出走馬, seed) からは常に同じ結果を返す。映像はこの走行ログを再生するだけで、
 * 描画が結果に影響することはない。モデルの全体像は docs/02-architecture.md §4.2 を参照。
 */
import type { Horse, RunningStyle } from '../data/roster';
import { type AptitudeBreakdown, type ExtendedAbilities, profileOf, raceAbility } from './ability';
import { Rng } from './rng';
import { type Surface, cornersOnRoute, courseFor, courseTraits, curvatureAt, gradeAt, raceU } from './track';

/**
 * 2.0.0: 中山を参考にした右回りのコース・起伏（坂）の影響を導入
 * 3.1.0: 出走時点の状態（調子・疲労・精神的疲労）を計算に入れる
 * 3.0.0: 能力・適性を拡張（持続力・操縦性・健康・距離の幅・回り・坂・小回り・直線・季節）、脚質の位置取りを展開で変える
 */
export const ENGINE_VERSION = 'sim-3.1.0';

export type Weather = 'sunny' | 'cloudy' | 'drizzle' | 'rain';
export type Going = 'good' | 'yielding' | 'soft' | 'heavy';
export type TimeOfDay = 'day' | 'dusk' | 'night';

export const WEATHER_LABEL: Record<Weather, string> = { sunny: '晴', cloudy: '曇', drizzle: '小雨', rain: '雨' };
export const GOING_LABEL: Record<Going, string> = { good: '良', yielding: '稍重', soft: '重', heavy: '不良' };
export const TIME_LABEL: Record<TimeOfDay, string> = { day: 'デイ', dusk: '薄暮', night: 'ナイター' };
export const SURFACE_LABEL: Record<Surface, string> = { turf: '芝', dirt: 'ダート' };

/** 「芝外1600m」「ダ1800m」のような短い表記 */
export function courseShort(c: Pick<RaceConditions, 'surface' | 'layout' | 'distance'>): string {
  if (c.surface === 'dirt') return `ダ${c.distance}m`;
  return `芝${c.layout === 'outer' ? '外' : c.layout === 'inner' ? '内' : ''}${c.distance}m`;
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
}

export interface SimRunner {
  horse: Horse & ExtendedAbilities;
  /** 馬番 */
  number: number;
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
}

export type SimEventType = 'late_start' | 'kakari' | 'lead' | 'duel' | 'spurt' | 'blocked' | 'fade' | 'finish';

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
 */
export const TUNE = { relax: 0.25, saveKick: 0.07, duelDrain: 1.3, draft: 0.94, myPace: 0.99, leaderRelax: 0, fadeFloor: 0.8, relaxDistExp: 0.7, respondWindow: 1.4 };

export function simulateRace(cond: RaceConditions, runners: SimRunner[], seed: string, opts: SimOptions = {}): SimResult {
  const dt = opts.dt ?? 0.1;
  const record = opts.record ?? true;
  const rng = new Rng(`${seed}|${ENGINE_VERSION}`);
  const course = courseFor(cond.surface, cond.layout);
  const n = runners.length;
  const D = cond.distance;
  const g = GOING_INDEX[cond.going];
  const cruiseFrac = 0.955 - (0.035 * (D - 1200)) / 1200;
  const goingDrain = cond.surface === 'turf' ? 1 + 0.06 * g : 1 + 0.02 * g;

  // ---- 馬ごとのパラメータ（能力・適性の効き方は ability.ts。乱数の消費順は固定） ----
  const traits = courseTraits(course);
  const P = runners.map((r) => {
    const h = r.horse;
    const prof = profileOf(h);
    const ab = raceAbility(prof, { surface: cond.surface, distance: D, goingIndex: g, course: traits, month: cond.month });
    const condition = rng.normal(0, ab.conditionSd);
    const base = cond.surface === 'turf' ? 17.9 - 0.12 * g : 17.3 + 0.07 * g;
    const vTop = base + (h.speed - 75) * 0.018 + ab.speedAdj + condition;
    const kakari = rng.chance(ab.kakariProb);
    const kakariStart = rng.range(4, 12);
    const kakariDur = rng.range(10, 28) * ab.kakariDuration;
    let startDelay = ab.startDelay + Math.abs(rng.normal(0, 0.06));
    const lateStart = rng.chance(ab.lateStartProb);
    if (lateStart) startDelay += rng.range(0.5, 1.0);
    const spurtDist = SPURT_DIST[h.style] * clamp(D / 1600, 0.85, 1.2) + rng.normal(0, 40);
    const gapFrac = GAP_FRAC[h.style] + rng.normal(0, ab.positionNoise);
    const kick = rng.normal(0, 0.004) + ab.kick;
    return {
      style: h.style,
      vTop,
      aptitude: ab.speedAdj,
      breakdown: ab.breakdown,
      condition,
      staminaFactor: ab.staminaFactor,
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
    const lead = P.reduce((a, p, i) => (p.style === 'senko' && (a < 0 || p.earlySpeed > P[a].earlySpeed) ? i : a), -1);
    if (lead >= 0) {
      P[lead].gapFrac = 0;
      P[lead].reluctantLead = true;
    }
  }

  const paceRef = (P.reduce((s, p) => s + p.vTop, 0) / n) * cruiseFrac;
  const spread = n * 1.5;
  const expectedTime = D / paceRef;
  const spurtFrac = Math.min(0.5, 600 / D);
  const relaxScale = Math.pow(1600 / D, TUNE.relaxDistExp);
  const drainK = (0.85 * 1.125) / (expectedTime * ((1 - spurtFrac) * Math.pow(cruiseFrac, 4) + spurtFrac));

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
      const vMax = p.vTop * fatigue;
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
      if (!spurting[i] && (challenged || rem <= p.spurtDist * clamp(0.7 + S[i] * 0.6, 0.75, 1.25))) {
        spurting[i] = true;
        events.push({ t, type: 'spurt', runner: i });
      }

      let target: number;
      if (spurting[i]) {
        // 脚を溜めた馬ほど末脚が伸びる
        target = vMax * (1 + p.kick + TUNE.saveKick * clamp(S[i] - 0.3, -0.3, 0.4));
      } else {
        const gapTarget = (gaveUp[i] ? 0.2 : p.gapFrac) * spread;
        const gap = leaderX - xPrev[i];
        // 追走する馬は先頭のペースに合わせ、目標の位置との差だけ速度を調整する（逃げ馬のペースが隊列のペースになる）
        const lead = i === leader ? paceRef : Math.max(vPrev[leader], paceRef * 0.95);
        target = lead + clamp((gap - gapTarget) * 0.06, -0.15, 0.6);
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
        if (p.reluctantLead && i === leader) target = paceRef * 0.985;
        if (kakariActive) target += 0.35;
        target = Math.min(target, vMax * 0.99);
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
      } else if (!spurting[i] && lanePrev[i] > 0.8 && isFree(i, lanePrev[i] - 0.9, 2.2, 2.2)) {
        laneTarget[i] = Math.max(0.6, lanePrev[i] - 0.9); // 内ラチ沿いへ寄せる
      }

      // 坂：上りは減速（パワーと坂適性で軽減）、下りはわずかに加速
      target *= 1 - 1.8 * Math.max(0, grade) * p.hill + 0.9 * Math.max(0, -grade);
      // コーナー：小回り適性の低い馬は、きついコーナーで速度を落とす
      if (Math.abs(curvatureAt(course, uNow)) > 1 / 1500) target *= p.cornerFactor;

      // 加減速
      if (v[i] < target) {
        const a = v[i] < 0.95 * paceRef ? p.aStart : p.aRun;
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
      lane[i] += clamp(laneTarget[i] - lane[i], -0.8 * dt, 0.8 * dt);
      // コーナーで外を回るほど進みが減る（曲率 κ のとき 1/(1+κ·レーン)）
      const progress = (vEff * dt) / (1 + curvatureAt(course, uNow) * lane[i]);
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

  // ペース判定：スタート直後とラスト3Fを除いた区間の、先頭の平均速度と基準ペースの比
  const midEnd = Math.max(3, laps - 3);
  const midSpeed = ((midEnd - 1) * 200) / (crossT[midEnd] - crossT[1]);
  const paceRatio = midSpeed / paceRef;
  // しきい値は多数のレースでの分布（おおよそ上位25% / 下位25%）から決めている
  const pace: Pace = paceRatio >= 1.0126 ? 'high' : paceRatio <= 1.0014 ? 'slow' : 'middle';

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
