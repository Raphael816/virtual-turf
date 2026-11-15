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
import { generateExtended } from './ability';
import { GROWTH_KEYS, type Life, type RaceForm, afterRace, bioAge, conditionOf, currentAbilities, initLife, retireProbability, weeklyRecovery } from './lifecycle';
import { npcPlan, train } from './training';
import { Rng } from './rng';

export const WEEKS_PER_YEAR = 52;
/** 次の出走までに空ける最低の週数（連闘はしない。中1週以上は疲労の残り具合で判断する） */
export const MIN_REST_WEEKS = 2;
/** これ以上疲労が残っている馬は、調教師が出走を見送る */
export const FATIGUE_LIMIT = 30;
/** 2歳馬のデビューが始まる週（JRAの2歳新馬戦は6月から） */
export const DEBUT_WEEK = 22;
/** 現役の頭数の目安（毎年の新しい世代の数をここから決める） */
export const TARGET_ACTIVE = 700;
/** 引退した馬を記録として残す頭数（古い順に消す） */
export const RETIRED_KEEP = 300;
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
  /** 生涯の状態（成長・疲労・調子・故障）。第3段階 */
  life: Life;
  retiredAt?: GameDate;
  retireReason?: string;
}

export interface World {
  /** 2：生涯の状態（life）を追加 */
  schema: 2;
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
const NAME_A = ['アカツキ', 'シラナミ', 'ハヤテ', 'ミナト', 'ソラノ', 'ユメノ', 'ホムラ', 'カゲロウ', 'ツバメ', 'ミズキ', 'コガネ', 'シノノメ', 'アオバ', 'ヨゾラ', 'カスミ', 'サクヤ', 'トキワ', 'ナギサ', 'ヒバリ', 'ムラサメ', 'イブキ', 'カリン', 'スバル', 'チトセ', 'アサギリ', 'ユキミ', 'ハナミ', 'ツキヨ', 'カザハナ', 'ミヤビ', 'シズカ', 'ホタル', 'アマネ', 'サザナミ', 'コハル', 'ナツメ', 'モミジ', 'ツユクサ', 'ハルカ', 'アオイ'];
const NAME_C = ['ミラクル', 'サンライズ', 'ゴールデン', 'シルバー', 'ブルー', 'ノーブル', 'ワイルド', 'グランド', 'スイート', 'クイーン', 'キング', 'ロイヤル', 'ハッピー', 'ラッキー', 'マジック', 'エンジェル', 'ダイヤ', 'ルビー', 'サファイア', 'オパール'];
const NAME_B = ['ライト', 'ノート', 'ステップ', 'ウェーブ', 'クレスト', 'リーフ', 'ブリーズ', 'ロンド', 'ソング', 'ゲート', 'アロー', 'ベル', 'スター', 'フレア', 'ミスト', 'ラン', 'ダンス', 'ルーチェ', 'コード', 'シーク', 'ピーク', 'マーチ', 'オーラ', 'セイル', 'ウィング', 'ハート', 'ドリーム', 'ソウル', 'ブレイブ', 'ロード', 'ワルツ', 'リズム', 'カノン', 'ポエム', 'メロディ', 'ハーバー', 'リバー', 'フォレスト', 'ムーン', 'サン', 'クラウン', 'ジュエル', 'キャンドル', 'ランプ', 'ボルト', 'ストーム', 'フラッシュ', 'ジェット', 'ロケット', 'コメット', 'ノヴァ', 'ギア', 'ブレード', 'シールド', 'エンブレム', 'メダル', 'トロフィー', 'パレード', 'フェスタ'];

const GRADES: Grade[] = ['A', 'B', 'C', 'D'];
const clampi = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

function generateHorse(rng: Rng, id: string, name: string, forcedAge?: number): Horse {
  const sexR = rng.next();
  const sex: Horse['sex'] = forcedAge === 2 ? (sexR < 0.52 ? '牡' : '牝') : sexR < 0.55 ? '牡' : sexR < 0.9 ? '牝' : 'セ';
  const age = forcedAge ?? rng.int(2, 7);
  const best = clampi(rng.normal(1750, 380), 1000, 3200);
  const longer = (best - 1750) / 380;
  const style: RunningStyle = rng.pick(['nige', 'senko', 'senko', 'sashi', 'sashi', 'oikomi'] as RunningStyle[]);
  const coat = rng.pick(COATS);
  const dirtType = rng.chance(0.35);
  const grade = (bias: number): Grade => GRADES[Math.max(0, Math.min(3, Math.round(1.4 + bias + rng.normal(0, 0.8))))];
  const h: Horse = {
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
  return { ...h, ...generateExtended(h, id) };
}

/** 重ならない馬名を作る（既存の馬名と、記録に残っている馬名を避ける） */
function makeName(rng: Rng, used: Set<string>): string | null {
  for (let k = 0; k < 200; k++) {
    const head = rng.chance(0.6) ? rng.pick(NAME_A) : rng.pick(NAME_C);
    const name = head + rng.pick(NAME_B);
    if (name.length <= 9 && !used.has(name)) {
      used.add(name);
      return name;
    }
  }
  return null;
}

/**
 * 生成した馬を競馬界の馬にする。生成した能力は「ピーク時の能力（上限）」とし、現在の能力は成長曲線から求める
 * （若い馬は上限より低く、高齢の馬は衰えている）。既存の36頭は今の能力を現在の値とし、上限を逆算する。
 */
function toWorldHorse(h: Horse, date: GameDate, asPotential: boolean): WorldHorse {
  const birthYear = date.year - h.age;
  const age = bioAge(birthYear, date);
  let life: Life;
  if (asPotential) {
    life = initLife({ ...h }, age, h.id);
    life.pot = { speed: h.speed, stamina: h.stamina, accel: h.accel, sustain: h.sustain ?? Math.round((h.stamina + h.accel) / 2), power: h.power };
  } else life = initLife(h, age, h.id);
  const cur = currentAbilities(h, life, age);
  return { ...h, ...cur, birthYear, owner: 'npc', status: 'active', career: { starts: 0, wins: 0, seconds: 0, thirds: 0 }, history: [], life };
}

/**
 * 初期の競馬界を作る（決定論的）。既存の36頭はそのまま引き継ぎ、架空の馬を加える。
 * @param extra 追加で生成する頭数
 */
export function createWorld(extra = 664): World {
  const rng = new Rng('world:v1');
  const date: GameDate = { year: START_YEAR, week: 1 };
  const used = new Set(HORSES.map((h) => h.name));
  const horses: WorldHorse[] = HORSES.map((h) => toWorldHorse(h, date, false));
  while (horses.length < HORSES.length + extra) {
    const name = makeName(rng, used);
    if (!name) break;
    horses.push(toWorldHorse(generateHorse(rng, `g${String(horses.length).padStart(4, '0')}`, name), date, true));
  }
  return { schema: 2, date, meetings: 0, horses };
}

/** 生涯の状態がない古い競馬界（schema 1）を移行する（今の能力を現在の値とし、上限を逆算） */
export function upgradeWorld(w: World | (Omit<World, 'schema'> & { schema: number })): World {
  if (w.schema === 2) return w as World;
  const horses = (w.horses as (Omit<WorldHorse, 'life'> & { life?: Life })[]).map((h) =>
    h.life ? (h as WorldHorse) : { ...h, life: initLife(h, bioAge(h.birthYear, w.date), h.id) },
  );
  return { ...(w as World), schema: 2, horses };
}

// ---------------------------------------------------------------- 進行

/** 出走できる馬：現役・故障していない・疲労が残りすぎていない・前走から2週以上・2歳はデビューの時期以降 */
export function eligibleHorses(world: World): WorldHorse[] {
  return world.horses.filter(
    (h) =>
      h.status === 'active' &&
      !h.life.injury &&
      h.life.fatigue < FATIGUE_LIMIT &&
      (ageOf(h, world.date) > 2 || world.date.week >= DEBUT_WEEK) &&
      (!h.lastRun || weeksBetween(h.lastRun, world.date) >= MIN_REST_WEEKS),
  );
}

const weekIndex = (d: GameDate) => d.year * WEEKS_PER_YEAR + d.week;

/** 当日の状態（調子・疲労・精神的疲労） */
export function formOf(h: WorldHorse, date: GameDate): RaceForm {
  return { condition: Math.round(conditionOf(h.life, weekIndex(date)) * 100) / 100, fatigue: Math.round(h.life.fatigue), mental: Math.round(h.life.mental) };
}

/** 出走時点の能力・状態の写し（レース計算に使う形）。年齢は現在の暦で数える */
export function snapshot(h: WorldHorse, date: GameDate): Horse {
  const { birthYear: _b, owner: _o, status: _s, career: _c, history: _h, lastRun: _l, life: _life, retiredAt: _r, retireReason: _rr, ...horse } = h;
  return { ...horse, age: ageOf(h, date), form: formOf(h, date) };
}

/** 1週進める（開催日を開くとき）：成長・回復・治療。年明けには引退と新しい世代 */
export function advanceWeek(world: World): World {
  const date = addWeeks(world.date, 1);
  let horses = world.horses.map((h) => {
    if (h.status !== 'active') return h;
    const age = bioAge(h.birthYear, date);
    let life = weeklyRecovery(h.life, h.health ?? 65);
    // 調教（厩舎が状態を見てメニューを決める）
    const sinceRace = h.lastRun ? weeksBetween(h.lastRun, date) : 99;
    const cur0 = currentAbilities(h, life, age);
    const weakest = GROWTH_KEYS.reduce((a, k) => (cur0[k] / life.pot[k] < cur0[a] / life.pot[a] ? k : a), GROWTH_KEYS[0]);
    const seed = `${date.year}:${date.week}:${h.id}`;
    life = train(life, npcPlan(life, sinceRace, weakest, seed), { age, health: h.health ?? 65, seed, date }).life;
    const cur = currentAbilities(h, life, age);
    return { ...h, ...cur, life };
  });
  if (date.week === 1) horses = yearStart(horses, date);
  return { ...world, date, meetings: world.meetings + 1, horses };
}

/** 年明け：引退の判断と、2歳の新しい世代 */
function yearStart(horses: WorldHorse[], date: GameDate): WorldHorse[] {
  const out = horses.map((h) => {
    if (h.status !== 'active') return h;
    const age = ageOf(h, date);
    const recentWins = h.history.filter((r) => r.rk === 1).length;
    const p = retireProbability(h, age, h.life, recentWins, h.history.length);
    if (new Rng(`retire:${date.year}:${h.id}`).chance(p)) {
      const reason = age >= 8 ? '高齢' : h.life.injury?.severity === 'severe' ? '故障' : h.sex === '牝' && age >= 5 ? '繁殖入り' : '成績不振';
      return { ...h, status: 'retired' as const, retiredAt: { ...date }, retireReason: reason };
    }
    return h;
  });
  // 新しい世代：現役の頭数が目安に戻るように（少なくとも40頭）
  const active = out.filter((h) => h.status === 'active').length;
  const crop = Math.max(40, TARGET_ACTIVE - active);
  const rng = new Rng(`crop:${date.year}`);
  const used = new Set(out.map((h) => h.name));
  for (let i = 0; i < crop; i++) {
    const name = makeName(rng, used);
    if (!name) break;
    const id = `y${date.year}-${String(i).padStart(3, '0')}`;
    const foal = toWorldHorse(generateHorse(rng, id, name, 2), date, true);
    // 入厩したばかりの2歳馬は、まだ鍛えられていない（鍛え具合が低く、仕上がりも緩い）
    foal.life = { ...foal.life, dev: Object.fromEntries(GROWTH_KEYS.map((k) => [k, 0.35])) as Life['pot'], fitness: 30 };
    out.push({ ...foal, ...currentAbilities(foal, foal.life, bioAge(foal.birthYear, date)) });
  }
  // 引退馬の記録は直近 RETIRED_KEEP 頭まで、成績は直近5走だけ残す（保存容量のため）
  for (let i = 0; i < out.length; i++) if (out[i].status === 'retired' && out[i].history.length > 5) out[i] = { ...out[i], history: out[i].history.slice(0, 5) };
  const retired = out.filter((h) => h.status === 'retired');
  if (retired.length > RETIRED_KEEP) {
    const drop = new Set(
      retired
        .sort((a, b) => weeksBetween(b.retiredAt ?? date, a.retiredAt ?? date))
        .slice(0, retired.length - RETIRED_KEEP)
        .map((h) => h.id),
    );
    return out.filter((h) => !drop.has(h.id));
  }
  return out;
}

export interface RaceResultForWorld {
  raceId: string;
  raceName: string;
  course: string;
  going: string;
  fieldSize: number;
  distance: number;
  goingIndex: number;
  /** 出走馬ごと（馬番順でなくてよい） */
  runners: { horseId: string; number: number; rank: number; time: number; margin: string; last3F: number; passing: string; jockey: string; kakari?: boolean; odds?: number; popularity?: number }[];
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
    // レース後の疲労・故障（重度の故障は半数がそのまま引退）
    const age = ageOf(h, world.date);
    const life = afterRace(h.life, h.health ?? 65, age, { distance: res.distance, goingIndex: res.goingIndex, kakari: !!r.kakari, rank: r.rank, field: res.fieldSize }, `${res.raceId}:${h.id}`);
    const retire = life.injury?.severity === 'severe' && new Rng(`severe:${res.raceId}:${h.id}`).chance(0.5);
    return {
      ...h,
      life,
      ...(retire ? { status: 'retired' as const, retiredAt: { ...world.date }, retireReason: `故障（${life.injury!.name}）` } : {}),
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
