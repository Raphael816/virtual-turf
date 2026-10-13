/**
 * レースシミュレーター（決定論的・0.1秒刻みのエージェントモデル）。
 *
 * 同じ (条件, 出走馬, seed) からは常に同じ結果を返す。映像はこの走行ログを再生するだけで、
 * 描画が結果に影響することはない。モデルの全体像は docs/02-architecture.md §4.2 を参照。
 */
import type { Grade, Horse, RunningStyle } from '../data/roster';
import { Rng } from './rng';
import { COURSES, type Surface, cornersOnRoute, isOnTurn, raceU } from './track';

export const ENGINE_VERSION = 'sim-1.0.0';

export type Weather = 'sunny' | 'cloudy' | 'drizzle' | 'rain';
export type Going = 'good' | 'yielding' | 'soft' | 'heavy';
export type TimeOfDay = 'day' | 'dusk' | 'night';

export const WEATHER_LABEL: Record<Weather, string> = { sunny: '晴', cloudy: '曇', drizzle: '小雨', rain: '雨' };
export const GOING_LABEL: Record<Going, string> = { good: '良', yielding: '稍重', soft: '重', heavy: '不良' };
export const TIME_LABEL: Record<TimeOfDay, string> = { day: 'デイ', dusk: '薄暮', night: 'ナイター' };
export const SURFACE_LABEL: Record<Surface, string> = { turf: '芝', dirt: 'ダート' };

export interface RaceConditions {
  surface: Surface;
  distance: number;
  weather: Weather;
  going: Going;
  timeOfDay: TimeOfDay;
}

export interface SimRunner {
  horse: Horse;
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

const GRADE_SURFACE: Record<Grade, number> = { A: 0.1, B: 0, C: -0.2, D: -0.45 };
const GRADE_HEAVY: Record<Grade, number> = { A: 0.1, B: 0, C: -0.12, D: -0.25 };
export const GOING_INDEX: Record<Going, number> = { good: 0, yielding: 1, soft: 2, heavy: 3 };
const SPURT_DIST: Record<RunningStyle, number> = { nige: 480, senko: 540, sashi: 600, oikomi: 650 };
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

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function simulateRace(cond: RaceConditions, runners: SimRunner[], seed: string, opts: SimOptions = {}): SimResult {
  const dt = opts.dt ?? 0.1;
  const record = opts.record ?? true;
  const rng = new Rng(`${seed}|${ENGINE_VERSION}`);
  const course = COURSES[cond.surface];
  const n = runners.length;
  const D = cond.distance;
  const g = GOING_INDEX[cond.going];
  const cruiseFrac = 0.955 - (0.035 * (D - 1200)) / 1200;
  const goingDrain = cond.surface === 'turf' ? 1 + 0.06 * g : 1 + 0.02 * g;

  // ---- 馬ごとのパラメータ（乱数の消費順は固定） ----
  const P = runners.map((r) => {
    const h = r.horse;
    const surfGrade = cond.surface === 'turf' ? h.turf : h.dirt;
    let aptitude = GRADE_SURFACE[surfGrade];
    if (g >= 2) aptitude += (GRADE_HEAVY[h.heavy] * (g - 1)) / 2;
    aptitude += cond.surface === 'dirt' ? (h.power - 70) * 0.005 : ((h.power - 70) * 0.004 * g) / 3;
    const distDiff = (D - h.bestDistance) / 400;
    let staminaAdj = 1;
    if (distDiff > 0) {
      staminaAdj -= 0.09 * distDiff;
      aptitude -= 0.02 * distDiff;
    } else {
      aptitude += 0.07 * distDiff; // 距離不足：スピードの絶対値が足りない
    }
    const condition = rng.normal(0, 0.06);
    const base = cond.surface === 'turf' ? 17.9 - 0.12 * g : 17.3 + 0.07 * g;
    const vTop = base + (h.speed - 75) * 0.018 + aptitude + condition;
    const staminaFactor = (0.75 + h.stamina / 200) * Math.max(0.55, staminaAdj);
    const kakari = rng.chance(Math.pow((100 - h.temper) / 100, 1.5) * 0.35);
    const kakariStart = rng.range(4, 12);
    const kakariDur = rng.range(10, 28);
    let startDelay = 0.1 + ((100 - h.start) / 100) * 0.3 + Math.abs(rng.normal(0, 0.06));
    const lateStart = rng.chance(0.03 + ((100 - h.start) / 100) * 0.07);
    if (lateStart) startDelay += rng.range(0.5, 1.0);
    const spurtDist = SPURT_DIST[h.style] * clamp(D / 1600, 0.85, 1.2) + rng.normal(0, 40);
    const gapFrac = GAP_FRAC[h.style] + rng.normal(0, 0.05);
    const kick = rng.normal(0, 0.004);
    return {
      style: h.style,
      vTop,
      aptitude,
      condition,
      staminaFactor,
      kakari,
      kakariStart,
      kakariEnd: kakariStart + (kakari ? kakariDur : 0),
      startDelay,
      lateStart,
      spurtDist,
      gapFrac,
      kick,
      aStart: 4.5 + (h.accel / 100) * 1.5,
      aRun: 0.3 + (h.accel / 100) * 0.5,
    };
  });

  const paceRef = (P.reduce((s, p) => s + p.vTop, 0) / n) * cruiseFrac;
  const spread = n * 1.5;
  const expectedTime = D / paceRef;
  const spurtFrac = Math.min(0.5, 600 / D);
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
      const fatigue = S[i] >= 0.3 ? 1 : 0.87 + 0.433 * S[i];
      const vMax = p.vTop * fatigue;
      const kakariActive = p.kakari && t >= p.kakariStart && t < p.kakariEnd;
      if (p.kakari && Math.abs(t - p.kakariStart) < dt / 2) events.push({ t, type: 'kakari', runner: i });

      if (!spurting[i] && rem <= p.spurtDist * clamp(0.7 + S[i] * 0.6, 0.75, 1.25)) {
        spurting[i] = true;
        events.push({ t, type: 'spurt', runner: i });
      }

      let target: number;
      if (spurting[i]) {
        // 脚を溜めた馬ほど末脚が伸びる
        target = vMax * (1 + p.kick + 0.035 * clamp(S[i] - 0.3, -0.3, 0.4));
      } else {
        const gapTarget = (gaveUp[i] ? 0.2 : p.gapFrac) * spread;
        const gap = leaderX - xPrev[i];
        target = paceRef + clamp((gap - gapTarget) * 0.06, -0.15, 0.6);
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
              target = paceRef * 0.99; // 単騎逃げ：マイペース
            }
          } else if (gap < 2.5) {
            target += 0.4;
            duelT[i] += dt;
          }
          if (i !== leader && duelT[i] > 22) gaveUp[i] = true;
        }
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
          draft = 0.86;
          break;
        }
      }
      const ratio = vEff / p.vTop;
      S[i] = Math.max(0, S[i] - (drainK * ratio ** 4 * goingDrain * draft * (kakariActive ? 1.4 : 1) * dt) / p.staminaFactor);
      if (!flags.fade[i] && S[i] < 0.05 && rem > 200) {
        flags.fade[i] = true;
        events.push({ t, type: 'fade', runner: i });
      }

      // 横移動と前進（コーナーで外を回るほど進みが減る）
      lane[i] += clamp(laneTarget[i] - lane[i], -0.8 * dt, 0.8 * dt);
      const onTurn = isOnTurn(course, raceU(course, D, xPrev[i]));
      const progress = vEff * dt * (onTurn ? course.radius / (course.radius + lane[i]) : 1);
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
  const pace: Pace = paceRatio >= 1.0 ? 'high' : paceRatio <= 0.99 ? 'slow' : 'middle';

  const lastCorner = corners.filter((c) => c.order.length).at(-1);
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
