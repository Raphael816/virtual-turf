/**
 * 天候と馬場（第7段階）。
 *
 * - 天候：競馬場の近くの気象官署の平年値（気象庁。src/data/climate.ts）から、その月の「1mm以上の日数」「1日あたりの降水量」「気温」「日照時間」に
 *   合うように1日ずつ決める（決定論的）。寒い日の降水は雪
 * - 含水率：芝（路盤砂）とダート（クッション砂）の含水率を競馬場ごとに持ち、雨で上がり、気温と日照で乾く。週をまたいで続く
 * - 馬場状態：JRA 公式の「馬場状態と含水率の関係性」の表（芝は競馬場ごと、ダートは全場共通）から決める
 *   （https://www.jra.go.jp/keiba/baba/moist/ 。実際は馬場担当者が踏査して総合的に判断するが、ゲームでは表の境目で決める）
 * - クッション値：芝の草種（野芝・洋芝）・季節・含水率・踏み固め（開催日数）から推定。基準は JRA 公式（https://www.jra.go.jp/keiba/baba/cushion/）
 * - 開催日数と使用コース（A〜D）：同じ場で続けて開催すると内側の芝が傷む（内外の差）。4日ごとにコースを替えると内側が回復する
 *
 * 雨による含水率の上がり方・乾き方などの係数は推定（docs/12-going-weather.md）。
 */
import { CLIMATE } from '../data/climate';
import { VENUES, type VenueId, VENUE_IDS } from '../data/venues';
import { Rng } from './rng';
import type { Going, Weather } from './sim';

export type Surface2 = 'turf' | 'dirt';

/** 競馬場ごとの馬場の状態（ワールドに保存） */
export interface TrackState {
  /** 含水率 (%) */
  turf: number;
  dirt: number;
  /** 続いている開催の何日目か（0 = 開催していない） */
  day: number;
  /** 使用コース（0 = A、1 = B …） */
  rail: number;
  /** 今のコースになってから何日目か */
  railDay: number;
  /** 最後に開催した週（年×52＋週） */
  lastWeek?: number;
}
export type TrackStates = Record<VenueId, TrackState>;

/**
 * 芝コースの馬場状態と含水率の関係（JRA 公式の表。単位 %）。[良の上限, 稍重の範囲, 重の範囲, 不良の下限]
 * 範囲が重なる部分は真ん中を境目にする（例：札幌 良 15以下・稍重 14〜18 → 14.5% を境に良／稍重）
 */
const TURF_TABLE: Record<VenueId, [number, [number, number], [number, number], number]> = {
  sapporo: [15, [14, 18], [17, 21], 20],
  hakodate: [15, [14, 18], [17, 21], 20],
  fukushima: [15, [13, 17], [15, 19], 17],
  niigata: [15, [13, 17], [15, 19], 17],
  nakayama: [13, [11, 15], [14, 18], 17],
  tokyo: [19, [17, 21], [18, 23], 20],
  chukyo: [14, [12, 16], [14, 17], 16],
  kyoto: [13, [11, 14], [13, 16], 14],
  hanshin: [14, [12, 16], [14, 18], 16],
  kokura: [10, [8, 12], [10, 14], 12],
};
/** ダートコース（全場共通。公式）：良 9以下、稍重 7〜13、重 11〜16、不良 14以上 */
const DIRT_TABLE: [number, [number, number], [number, number], number] = [9, [7, 13], [11, 16], 14];

function bounds(t: [number, [number, number], [number, number], number]): [number, number, number] {
  return [(t[0] + t[1][0]) / 2, (t[1][1] + t[2][0]) / 2, (t[2][1] + t[3]) / 2];
}
const GOINGS: Going[] = ['good', 'yielding', 'soft', 'heavy'];

/** 含水率から馬場状態 */
export function goingOf(surface: Surface2, venue: VenueId, moisture: number): Going {
  const b = bounds(surface === 'turf' ? TURF_TABLE[venue] : DIRT_TABLE);
  return GOINGS[moisture < b[0] ? 0 : moisture < b[1] ? 1 : moisture < b[2] ? 2 : 3];
}

/** 乾いた状態の含水率（推定：芝は良の境目の 3% 下、ダートは 3%。JRA は乾燥時に散水するので、これより下がらない） */
export function dryMoisture(surface: Surface2, venue: VenueId): number {
  return surface === 'turf' ? bounds(TURF_TABLE[venue])[0] - 3 : 3;
}
/** これ以上は上がらない含水率（推定：不良の境目の 3% 上） */
function wetMoisture(surface: Surface2, venue: VenueId): number {
  return (surface === 'turf' ? bounds(TURF_TABLE[venue])[2] : bounds(DIRT_TABLE)[2]) + 3;
}

export function initialTracks(): TrackStates {
  return Object.fromEntries(
    VENUE_IDS.map((v) => [v, { turf: dryMoisture('turf', v), dirt: dryMoisture('dirt', v), day: 0, rail: 0, railDay: 0 }]),
  ) as TrackStates;
}

// ---------------------------------------------------------------- 天候

export interface DayWeather {
  kind: Weather;
  /** 降水量 (mm) */
  mm: number;
  /** 気温 (℃) */
  temp: number;
  /** 日照の割合（0〜1） */
  sun: number;
}

/** 第 week 週の d 日目（1〜7。7日目が開催日）の月 */
function monthOf(week: number, d: number): number {
  const dayOfYear = (week - 1) * 7 + d;
  return Math.min(12, Math.max(1, Math.floor((dayOfYear - 1) / 30.42) + 1));
}

/**
 * 1日の天候（決定論的）：
 * - 降水の有無：その月の「降水量1mm以上の日数 ÷ 月の日数」の確率
 * - 降水量：1mm ＋ 指数分布（平均は「月の降水量 ÷ 1mm以上の日数」に合わせる）
 * - 気温：月平均 ± 3℃。降水があって気温が 1.5℃ 未満なら雪（5mm 以上は「雪」、未満は「小雪」）
 * - 降水のない日：日照時間の割合が高いほど晴れ（それ以外は曇）
 */
export function dayWeather(venue: VenueId, year: number, week: number, d: number): DayWeather {
  const c = CLIMATE[venue][monthOf(week, d) - 1];
  const rng = new Rng(`wx:${venue}:${year}:${week}:${d}`);
  const days = 30.42;
  const rain = rng.chance(c.d1 / days);
  const meanMm = c.d1 > 0 ? c.prec / c.d1 : 5;
  const mm = rain ? 1 + -Math.log(1 - rng.next() * 0.999) * Math.max(1, meanMm - 1) : 0;
  const temp = c.temp + rng.normal(0, 3);
  // 日照の割合：月の日照時間 ÷（日の出から日の入りまでの時間 約12時間 × 日数）
  const sunFrac = Math.max(0.15, Math.min(0.9, c.sun / (12 * days)));
  let kind: Weather;
  if (rain) {
    if (temp < 1.5) kind = mm >= 5 ? 'snow' : 'lightsnow';
    else kind = mm >= 5 ? 'rain' : 'drizzle';
  } else kind = rng.chance(Math.min(0.95, sunFrac * 1.3)) ? 'sunny' : 'cloudy';
  const sun = rain ? 0.05 : kind === 'sunny' ? sunFrac * 1.2 : sunFrac * 0.4;
  return { kind, mm: Math.round(mm * 10) / 10, temp: Math.round(temp * 10) / 10, sun: Math.min(1, sun) };
}

// ---------------------------------------------------------------- 含水率

/**
 * 1日の含水率の変化（推定）：
 * - 雨：1mm につき 芝 +0.3%、ダート +0.8%（上限に近いほど上がりにくい）。表層の砂を測るダートは、路盤を測る芝より雨にすぐ反応する
 * - 乾燥：乾いた状態との差が1日に e^(−r) 倍になる。r は 芝 0.20＋0.015×気温＋0.35×日照、ダート 0.20＋0.012×気温＋0.25×日照
 * 係数は、2年分の自動シミュレーションで馬場状態の割合が JRA の一般的な傾向（芝は良が約8割、ダートは良が6割強）に近くなるよう決めた
 */
const K_TURF = 0.3;
const K_DIRT = 0.8;
const R_TURF = [0.2, 0.015, 0.35];
const R_DIRT = [0.2, 0.012, 0.25];

export function stepMoisture(m: number, surface: Surface2, venue: VenueId, w: Pick<DayWeather, 'mm' | 'temp' | 'sun'>, fraction = 1): number {
  const dry = dryMoisture(surface, venue);
  const wet = wetMoisture(surface, venue);
  const k = surface === 'turf' ? K_TURF : K_DIRT;
  let x = m + k * w.mm * Math.max(0, 1 - (m - dry) / (wet - dry));
  const t = Math.max(0, w.temp);
  const r = surface === 'turf' ? R_TURF[0] + R_TURF[1] * t + R_TURF[2] * w.sun : R_DIRT[0] + R_DIRT[1] * t + R_DIRT[2] * w.sun;
  x = dry + (x - dry) * Math.exp(-r * fraction);
  return Math.max(dry, Math.min(wet, x));
}

/** 1日分を全場に適用する */
export function stepDay(states: TrackStates, year: number, week: number, d: number): TrackStates {
  const out = { ...states };
  for (const v of VENUE_IDS) {
    const w = dayWeather(v, year, week, d);
    const s = states[v];
    out[v] = { ...s, turf: stepMoisture(s.turf, 'turf', v, w), dirt: stepMoisture(s.dirt, 'dirt', v, w) };
  }
  return out;
}

/**
 * 週を進める：前の週の7日目（開催日）と、新しい週の1〜6日目の天候を全場に適用し、開催日の朝の状態にする。
 * 開催する場は、開催日数と使用コースを進める（5週より長く空いたら新しい開催：A コースの1日目）
 */
export function advanceTracks(states: TrackStates, prev: { year: number; week: number }, next: { year: number; week: number }, venue: VenueId): TrackStates {
  let s = stepDay(states, prev.year, prev.week, 7);
  for (let d = 1; d <= 6; d++) s = stepDay(s, next.year, next.week, d);
  const abs = next.year * 52 + next.week;
  const t = s[venue];
  const fresh = t.lastWeek === undefined || abs - t.lastWeek > 5;
  let rail = fresh ? 0 : t.rail;
  let railDay = fresh ? 1 : t.railDay + 1;
  // 4日ごとにコースを替える（その場のコースの数まで）
  if (!fresh && railDay > 4 && rail < VENUES[venue].railCourses - 1) {
    rail++;
    railDay = 1;
  }
  return { ...s, [venue]: { ...t, day: fresh ? 1 : t.day + 1, rail, railDay, lastWeek: abs } };
}

// ---------------------------------------------------------------- 開催日（レースごと）

export interface RaceSky {
  weather: Weather;
  turf: number;
  dirt: number;
  turfGoing: Going;
  dirtGoing: Going;
  cushion: number;
  temp: number;
}

/**
 * 芝のクッション値（推定）。JRA の基準：12以上 硬め、10〜12 やや硬め、8〜10 標準、7〜8 やや軟らかめ、7以下 軟らかめ。
 * 洋芝はマット層があり保水量も多いので、野芝より低く出る（公式の説明）。
 * 野芝 9.6・洋芝 8.4 を基準に、夏〜秋（7〜10月：野芝の生育期）+0.4、冬（12〜2月）−0.3、乾いた状態より含水率が 1% 高いごとに −0.4、
 * 開催日数で踏み固められて 1日 +0.05
 */
export function cushionOf(venue: VenueId, month: number, turfMoisture: number, day: number, noise: number): number {
  const v = VENUES[venue];
  let c = v.grass === '洋芝' ? 8.4 : 9.6;
  if (month >= 7 && month <= 10) c += 0.4;
  if (month === 12 || month <= 2) c -= 0.3;
  c -= 0.4 * (turfMoisture - dryMoisture('turf', venue));
  c += 0.05 * Math.max(0, day - 1);
  return Math.round(Math.max(5, Math.min(13, c + noise)) * 10) / 10;
}

/**
 * 開催日のレースごとの天候と馬場。その日の降水（dayWeather の7日目）を、朝（第1レースの前の3区間）〜最終レースまでの区間のどこかに
 * まとめて降らせる（降り始めと長さは乱数）。区間は各レースの前の約30分
 */
export function raceDaySky(state: TrackState, venue: VenueId, date: { year: number; week: number }, n: number, seed: string): RaceSky[] {
  const dw = dayWeather(venue, date.year, date.week, 7);
  const rng = new Rng(`sky:${seed}`);
  const slots = n + 3;
  const rainy = new Array<number>(slots).fill(0);
  if (dw.mm > 0) {
    const len = rng.int(2, slots);
    const start = rng.int(0, slots - len);
    for (let i = start; i < start + len; i++) rainy[i] = dw.mm / len;
  }
  const month = monthOf(date.week, 7);
  const noise = rng.normal(0, 0.25);
  let turf = state.turf;
  let dirt = state.dirt;
  const out: RaceSky[] = [];
  for (let i = 0; i < slots; i++) {
    // 1区間 ≒ 1/24 日分の乾き
    const w = { mm: rainy[i], temp: dw.temp, sun: rainy[i] > 0 ? 0.05 : dw.sun };
    turf = stepMoisture(turf, 'turf', venue, w, 1 / 24);
    dirt = stepMoisture(dirt, 'dirt', venue, w, 1 / 24);
    if (i < 3) continue;
    let weather: Weather;
    if (rainy[i] > 0) weather = dw.kind === 'rain' && rainy[i] < 1 ? 'drizzle' : dw.kind === 'snow' && rainy[i] < 1 ? 'lightsnow' : dw.kind;
    else weather = dw.mm > 0 ? 'cloudy' : dw.kind;
    const t = Math.round(turf * 10) / 10;
    const d = Math.round(dirt * 10) / 10;
    out.push({
      weather,
      turf: t,
      dirt: d,
      turfGoing: goingOf('turf', venue, t),
      dirtGoing: goingOf('dirt', venue, d),
      cushion: cushionOf(venue, month, t, state.day, noise),
      temp: dw.temp,
    });
  }
  return out;
}

/** 内外の差（0〜1）：今のコースになってから日数が経つほど内側の芝が傷む（推定：2日目から6日かけて最大） */
export function wearOf(state: Pick<TrackState, 'railDay'>): number {
  return Math.max(0, Math.min(1, (state.railDay - 1) / 6));
}

export const RAIL_LABEL = ['A', 'B', 'C', 'D'];
