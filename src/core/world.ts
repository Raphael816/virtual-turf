/**
 * 競馬界の状態（ワールド）：ゲーム内の暦・全競走馬・各馬の戦績。
 *
 * - 暦は「年・週」。1開催日をゲーム内の1週とし、開催が確定するごとに1週進む（現実の時刻で進行）
 * - 馬齢は JRA と同じく1月1日に一斉に加算する（年齢 = 現在の年 − 生年）
 * - 既存の36頭に、手続き的に生成した架空の馬を加えて出走頭数をまかなう（同じ開催日の連闘はしない）
 * - 戦績は直近 HISTORY_LIMIT 走だけを端末に保存する（保存容量のため）
 *
 * レースの計算に使う能力は、出走時点の値を出走表に写して保存する（meeting.ts の RaceEntry.horse）。
 * 後から能力が変わっても、過去のレースは同じ結果で再計算・検証できる。
 */
import { COATS, type Grade, type Horse, HORSES, type RunningStyle, TRAINERS } from '../data/roster';
import { Rng } from './rng';

export const WEEKS_PER_YEAR = 52;
/** 次の出走までに空ける最低の週数（連闘・中1週を避ける簡略化。疲労のモデルは後の段階で置き換える） */
export const MIN_REST_WEEKS = 3;
export const HISTORY_LIMIT = 10;
/** ゲームの開始年（架空の暦） */
export const START_YEAR = 2026;

export interface GameDate {
  year: number;
  /** 1〜52 */
  week: number;
}

export function addWeeks(d: GameDate, n: number): GameDate {
  const total = (d.year * WEEKS_PER_YEAR + (d.week - 1)) + n;
  return { year: Math.floor(total / WEEKS_PER_YEAR), week: (total % WEEKS_PER_YEAR) + 1 };
}

export function weeksBetween(a: GameDate, b: GameDate): number {
  return (b.year - a.year) * WEEKS_PER_YEAR + (b.week - a.week);
}

/** 第n週をおおよその月に換算（表示用） */
export function monthOf(d: GameDate): number {
  return Math.min(12, Math.floor(((d.week - 1) * 12) / WEEKS_PER_YEAR) + 1);
}

export function dateLabel(d: GameDate): string {
  return `${d.year}年${monthOf(d)}月 第${d.week}週`;
}

/** 1走の記録（保存容量を抑えるため短いキー） */
export interface RunRecord {
  /** レースID */
  r: string;
  y: number;
  w: number;
  /** レース名 */
  n: string;
  /** コース表記（芝外1600m など） */
  c: string;
  /** 馬場（良・稍重・重・不良） */
  g: string;
  /** 頭数・馬番・着順 */
  f: number;
  no: number;
  rk: number;
  /** 走破タイム（秒）・着差・上がり3F（秒） */
  t: number;
  m: string;
  l3: number;
  /** 通過順（例 "3-3-2-1"） */
  p: string;
  /** 騎手 */
  j: string;
  /** 確定単勝オッズ・人気 */
  o?: number;
  pop?: number;
}

export interface Career {
  starts: number;
  wins: number;
  seconds: number;
  thirds: number;
}

export interface WorldHorse extends Horse {
  birthYear: number;
  owner: 'npc' | 'player';
  status: 'active' | 'retired';
  career: Career;
  /** 新しい順 */
  history: RunRecord[];
  /** 前走の日付 */
  lastRun?: GameDate;
}

export interface World {
  schema: 1;
  date: GameDate;
  /** これまでに開いた開催日の数 */
  meetings: number;
  horses: WorldHorse[];
}

export function ageOf(h: Pick<WorldHorse, 'birthYear'>, date: GameDate): number {
  return date.year - h.birthYear;
}

// ---------------------------------------------------------------- 生成

/** 馬名の部品（一般的なカタカナ語の組み合わせ。実在の競走馬との重複は避けきれないため、表示で架空である旨を明示する） */
const NAME_A = ['アカツキ', 'シラナミ', 'ハヤテ', 'ミナト', 'ソラノ', 'ユメノ', 'ホムラ', 'カゲロウ', 'ツバメ', 'ミズキ', 'コガネ', 'シノノメ', 'アオバ', 'ヨゾラ', 'カスミ', 'サクヤ', 'トキワ', 'ナギサ', 'ヒバリ', 'ムラサメ', 'イブキ', 'カリン', 'スバル', 'チトセ'];
const NAME_B = ['ライト', 'ノート', 'ステップ', 'ウェーブ', 'クレスト', 'リーフ', 'ブリーズ', 'ロンド', 'ソング', 'ゲート', 'アロー', 'ベル', 'スター', 'フレア', 'ミスト', 'ラン', 'ダンス', 'ルーチェ', 'コード', 'シーク', 'ピーク', 'マーチ', 'オーラ', 'セイル'];

const GRADES: Grade[] = ['A', 'B', 'C', 'D'];
const clampi = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

function generateHorse(rng: Rng, id: string, name: string): Horse {
  const sexR = rng.next();
  const sex: Horse['sex'] = sexR < 0.55 ? '牡' : sexR < 0.9 ? '牝' : 'セ';
  const age = rng.int(2, 7);
  const best = clampi(rng.normal(1750, 380), 1000, 3200);
  const longer = (best - 1750) / 380;
  const style: RunningStyle = rng.pick(['nige', 'senko', 'senko', 'sashi', 'sashi', 'oikomi'] as RunningStyle[]);
  const coat = rng.pick(COATS);
  const dirtType = rng.chance(0.35);
  const grade = (bias: number): Grade => GRADES[Math.max(0, Math.min(3, Math.round(1.4 + bias + rng.normal(0, 0.8))))];
  return {
    id,
    name,
    sex,
    age,
    color: coat.color,
    coat: coat.name,
    trainer: rng.pick(TRAINERS),
    // 能力の分布は既存の36頭よりやや低め（36頭は各世代の上位馬という位置づけ）
    speed: clampi(rng.normal(74 - longer * 2, 5), 58, 90),
    stamina: clampi(rng.normal(72 + longer * 5, 6), 50, 92),
    accel: clampi(rng.normal(73, 6), 52, 92),
    start: clampi(rng.normal(70, 8), 45, 92),
    temper: clampi(rng.normal(68, 10), 40, 95),
    power: clampi(rng.normal(dirtType ? 76 : 62, 9), 40, 95),
    style,
    bestDistance: Math.round(best / 100) * 100,
    turf: grade(dirtType ? 1.2 : -0.9),
    dirt: grade(dirtType ? -1.0 : 1.0),
    heavy: grade(0),
    note: '',
  };
}

/**
 * 初期の競馬界を作る（決定論的）。既存の36頭はそのまま引き継ぎ、架空の馬を加える。
 * @param extra 追加で生成する頭数
 */
export function createWorld(extra = 324): World {
  const rng = new Rng('world:v1');
  const date: GameDate = { year: START_YEAR, week: 1 };
  const used = new Set(HORSES.map((h) => h.name));
  const fresh = (h: Horse): WorldHorse => ({
    ...h,
    birthYear: START_YEAR - h.age,
    owner: 'npc',
    status: 'active',
    career: { starts: 0, wins: 0, seconds: 0, thirds: 0 },
    history: [],
  });
  const horses: WorldHorse[] = HORSES.map(fresh);
  let k = 0;
  while (horses.length < HORSES.length + extra && k < 10000) {
    k++;
    const name = rng.pick(NAME_A) + rng.pick(NAME_B);
    if (name.length > 9 || used.has(name)) continue;
    used.add(name);
    horses.push(fresh(generateHorse(rng, `g${String(horses.length).padStart(4, '0')}`, name)));
  }
  return { schema: 1, date, meetings: 0, horses };
}

// ---------------------------------------------------------------- 進行

/** 出走できる馬（現役で、前走から MIN_REST_WEEKS 週以上空いている） */
export function eligibleHorses(world: World): WorldHorse[] {
  return world.horses.filter((h) => h.status === 'active' && (!h.lastRun || weeksBetween(h.lastRun, world.date) >= MIN_REST_WEEKS));
}

/** 出走時点の能力の写し（レース計算に使う形）。年齢は現在の暦で数える */
export function snapshot(h: WorldHorse, date: GameDate): Horse {
  return {
    id: h.id,
    name: h.name,
    sex: h.sex,
    age: ageOf(h, date),
    color: h.color,
    coat: h.coat,
    trainer: h.trainer,
    speed: h.speed,
    stamina: h.stamina,
    accel: h.accel,
    start: h.start,
    temper: h.temper,
    power: h.power,
    style: h.style,
    bestDistance: h.bestDistance,
    turf: h.turf,
    dirt: h.dirt,
    heavy: h.heavy,
    note: h.note,
  };
}

/** 1週進める（開催日を開くとき） */
export function advanceWeek(world: World): World {
  return { ...world, date: addWeeks(world.date, 1), meetings: world.meetings + 1 };
}

export interface RaceResultForWorld {
  raceId: string;
  raceName: string;
  course: string;
  going: string;
  fieldSize: number;
  /** 出走馬ごと（馬番順でなくてよい） */
  runners: { horseId: string; number: number; rank: number; time: number; margin: string; last3F: number; passing: string; jockey: string; odds?: number; popularity?: number }[];
}

/** レース結果を各馬の戦績に記録する */
export function recordRace(world: World, res: RaceResultForWorld): World {
  const byId = new Map(res.runners.map((r) => [r.horseId, r]));
  const horses = world.horses.map((h) => {
    const r = byId.get(h.id);
    if (!r) return h;
    // 同じレースを二重に記録しない
    if (h.history.some((x) => x.r === res.raceId)) return h;
    const rec: RunRecord = {
      r: res.raceId,
      y: world.date.year,
      w: world.date.week,
      n: res.raceName,
      c: res.course,
      g: res.going,
      f: res.fieldSize,
      no: r.number,
      rk: r.rank,
      t: Math.round(r.time * 10) / 10,
      m: r.margin,
      l3: Math.round(r.last3F * 10) / 10,
      p: r.passing,
      j: r.jockey,
      ...(r.odds !== undefined ? { o: r.odds } : {}),
      ...(r.popularity !== undefined ? { pop: r.popularity } : {}),
    };
    return {
      ...h,
      lastRun: { ...world.date },
      career: {
        starts: h.career.starts + 1,
        wins: h.career.wins + (r.rank === 1 ? 1 : 0),
        seconds: h.career.seconds + (r.rank === 2 ? 1 : 0),
        thirds: h.career.thirds + (r.rank === 3 ? 1 : 0),
      },
      history: [rec, ...h.history].slice(0, HISTORY_LIMIT),
    };
  });
  return { ...world, horses };
}

export function findHorse(world: World | undefined, id: string): WorldHorse | undefined {
  return world?.horses.find((h) => h.id === id);
}
