/**
 * 開催（1日8レース）の生成と、結果決定用 seed のコミット・リビール。
 *
 * - 出走表・条件は開催ID から決定論的に生成する（公開情報）
 * - 結果決定用 seed は暗号論的乱数で生成し、ハッシュだけを事前に公開する
 */
import { type Grade, type Horse, HORSE_BY_ID, HORSES, JOCKEYS } from '../data/roster';
import { type World, type WorldHorse, ageOf, eligibleHorses, monthOf, snapshot, weeksBetween } from './world';
import {
  type ClassId,
  type RaceTerms,
  type WeightRule,
  CLASS_RANK,
  ageEligible,
  allowanceExtra,
  baseWeight,
  basePrize,
  classEligible,
  classOfEarnings,
  handicapRating,
  handicapWeights,
  isGraded,
  isOpenClass,
  termsLabel,
} from './raceclass';
import { type ProgramAlt, SLOTS, SPECIAL_NAMES, altsFor, stakesOfWeek } from './program';
import { Rng, secureSeed, sha256Hex } from './rng';
import {
  ENGINE_VERSION,
  type Going,
  type RaceConditions,
  type SimOptions,
  type SimResult,
  type TimeOfDay,
  type Weather,
  simulateRace,
} from './sim';
import type { Surface } from './track';

export interface RaceEntry {
  horseId: string;
  /** 馬番 */
  number: number;
  /** 枠番 */
  frame: number;
  jockey: string;
  /** 負担重量 (kg)。第5段階から（古い出走表にはない） */
  weight?: number;
  /**
   * 出走時点の能力の写し。馬の能力は年月とともに変わるため、レースの計算・検証はこの値で行う。
   * 古い保存データ（写しがない出走表）は既存の36頭のデータを使う。
   */
  horse?: Horse;
}

/** 出走表の馬の、レース計算に使う能力 */
export function entryHorse(e: RaceEntry): Horse {
  const h = e.horse ?? HORSE_BY_ID.get(e.horseId);
  if (!h) throw new Error(`unknown horse ${e.horseId}`);
  return h;
}

export interface RaceCard {
  id: string;
  meetingId: string;
  no: number;
  name: string;
  conditions: RaceConditions;
  /** クラス・出走条件・負担重量の決め方・賞金。第5段階から（古い出走表・競馬界のない開催にはない） */
  terms?: RaceTerms;
  entries: RaceEntry[];
  /** 結果決定用 seed（本番ではサーバーのみが保持し、確定後に公開） */
  seed: string;
  /** SHA-256(commitInput) — 発売開始時に公開 */
  commit: string;
  engineVersion: string;
}

interface RacePlan {
  name: string;
  surface: Surface;
  layout?: 'inner' | 'outer';
  distances: number[];
  timeOfDay: TimeOfDay;
  field: [number, number];
}

/** 中山を参考にしたコースで一般的な距離（芝外回り 1200/1600/2200、芝内回り 2000/2500、ダート 1200/1800） */
const PLAN: RacePlan[] = [
  { name: '暁雲特別', surface: 'dirt', distances: [1200], timeOfDay: 'day', field: [9, 12] },
  { name: '翠嶺特別', surface: 'turf', layout: 'outer', distances: [1600], timeOfDay: 'day', field: [9, 12] },
  { name: '湖月ステークス', surface: 'dirt', distances: [1800], timeOfDay: 'day', field: [10, 13] },
  { name: '星見坂賞', surface: 'turf', layout: 'inner', distances: [2000], timeOfDay: 'day', field: [10, 14] },
  { name: '灯台岬ステークス', surface: 'turf', layout: 'outer', distances: [1200], timeOfDay: 'day', field: [10, 14] },
  { name: '銀砂ステークス', surface: 'dirt', distances: [1800], timeOfDay: 'dusk', field: [11, 14] },
  { name: '宵灯特別', surface: 'turf', layout: 'outer', distances: [2200], timeOfDay: 'dusk', field: [11, 14] },
  { name: '翠ヶ原記念', surface: 'turf', layout: 'inner', distances: [2500], timeOfDay: 'night', field: [12, 14] },
];

const WEATHERS: Weather[] = ['sunny', 'cloudy', 'drizzle', 'rain'];
const GOINGS: Going[] = ['good', 'yielding', 'soft', 'heavy'];
const MOISTURE: Record<Weather, number> = { sunny: 0, cloudy: 0.4, drizzle: 1.4, rain: 2.4 };
const GRADE_WEIGHT: Record<Grade, number> = { A: 4, B: 3, C: 1.2, D: 0.12 };

/** 馬番から枠番を求める（頭数が8を超えると外枠から2頭ずつ入る） */
export function frameOf(fieldSize: number, number: number): number {
  if (fieldSize <= 8) return number;
  const singles = Math.max(0, 16 - fieldSize);
  if (number <= singles) return number;
  return singles + Math.ceil((number - singles) / 2);
}

export function commitInput(raceId: string, seed: string, engineVersion = ENGINE_VERSION): string {
  return `${raceId}|${seed}|${engineVersion}`;
}

function pickWeighted<T>(rng: Rng, items: T[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return items.length - 1;
}

/**
 * 開催を生成する。`seedFn` はテスト用に差し替えられる（既定は暗号論的乱数）。
 * 競馬界があるときは番組（program.ts）に沿ってクラス・条件別のレースを組み、ないとき（36頭だけ）は以前の8レース。
 */
export async function createMeeting(meetingId: string, seedFn: () => string = secureSeed, world?: World): Promise<RaceCard[]> {
  const drafts = world ? draftProgram(meetingId, world) : draftLegacy(meetingId);
  const cards: RaceCard[] = [];
  for (let r = 0; r < drafts.length; r++) {
    const d = drafts[r];
    const id = `${meetingId}-R${r + 1}`;
    const seed = seedFn();
    cards.push({
      id,
      meetingId,
      no: r + 1,
      name: d.name,
      conditions: d.conditions,
      ...(d.terms ? { terms: d.terms } : {}),
      entries: d.entries,
      seed,
      commit: await sha256Hex(commitInput(id, seed)),
      engineVersion: ENGINE_VERSION,
    });
  }
  return cards;
}

interface Draft {
  name: string;
  conditions: RaceConditions;
  terms?: RaceTerms;
  entries: RaceEntry[];
}

/** 天気・馬場の移り変わり（1日の中で少しずつ変わる） */
function weatherSequence(rng: Rng, n: number): { weather: Weather; going: Going }[] {
  let weatherIdx = pickWeighted(rng, WEATHERS, [50, 30, 12, 8]);
  const out: { weather: Weather; going: Going }[] = [];
  for (let r = 0; r < n; r++) {
    if (r > 0 && rng.chance(0.15)) weatherIdx = Math.max(0, Math.min(3, weatherIdx + (rng.chance(0.5) ? 1 : -1)));
    const weather = WEATHERS[weatherIdx];
    const goingIdx = Math.max(0, Math.min(3, Math.round(MOISTURE[weather] + rng.normal(0, 0.4))));
    out.push({ weather, going: GOINGS[goingIdx] });
  }
  return out;
}

/** コース・距離の向き不向きと疲労による、出走の選ばれやすさ */
function fitWeight(h: Horse, surface: 'turf' | 'dirt', distance: number): number {
  const grade = surface === 'turf' ? h.turf : h.dirt;
  const fit = Math.exp(-(((distance - h.bestDistance) / 500) ** 2)) + 0.1;
  // 疲労の残っている馬は出走を見送られやすい
  const fresh = 1 - (h.form?.fatigue ?? 0) / 100;
  return GRADE_WEIGHT[grade] * fit * fresh;
}

/** 以前の8レース（競馬界がないとき：36頭から選ぶ。クラス・負担重量なし） */
function draftLegacy(meetingId: string): Draft[] {
  const rng = new Rng(`meeting:${meetingId}`);
  const sky = weatherSequence(rng, PLAN.length);
  const usage = new Map<string, number>();
  return PLAN.map((plan, r) => {
    const distance = rng.pick(plan.distances);
    const conditions: RaceConditions = { surface: plan.surface, ...(plan.layout ? { layout: plan.layout } : {}), distance, ...sky[r], timeOfDay: plan.timeOfDay };
    const pool = [...HORSES];
    const size = Math.min(pool.length, rng.int(plan.field[0], plan.field[1]));
    const weights = pool.map((h) => fitWeight(h, plan.surface, distance) / (1 + 2 * (usage.get(h.id) ?? 0)));
    const chosen = pickMany(rng, pool, weights, size);
    chosen.forEach((h) => usage.set(h.id, (usage.get(h.id) ?? 0) + 1));
    return { name: plan.name, conditions, entries: toEntries(rng, chosen, () => undefined, false) };
  });
}

function pickMany<T>(rng: Rng, pool: T[], weights: number[], size: number): T[] {
  const p = [...pool];
  const w = [...weights];
  const chosen: T[] = [];
  while (chosen.length < size && p.length > 0) {
    const idx = pickWeighted(rng, p, w);
    chosen.push(p[idx]);
    p.splice(idx, 1);
    w.splice(idx, 1);
  }
  return chosen;
}

function toEntries(rng: Rng, chosen: Horse[], weightOf: (h: Horse, i: number) => number | undefined, keepSnapshot: boolean): RaceEntry[] {
  const order = rng.shuffle(chosen.map((h, i) => ({ h, i })));
  const jockeys = rng.shuffle([...JOCKEYS]);
  return order.map(({ h, i }, k) => {
    const weight = weightOf(h, i);
    return {
      horseId: h.id,
      number: k + 1,
      frame: frameOf(order.length, k + 1),
      jockey: jockeys[k % jockeys.length],
      ...(weight !== undefined ? { weight } : {}),
      ...(keepSnapshot ? { horse: h } : {}),
    };
  });
}

/** 出走できる馬が少なすぎるレースは組まない */
const MIN_FIELD = 6;

/**
 * 出走の選ばれやすさのうち、クラスによる部分：
 * - 自分のクラスのレース：1
 * - 格上挑戦（自分より上のクラス）：1段ごとに 0.06 倍（2歳・3歳限定のオープン・重賞は 0.5 倍。若い馬は格上挑戦が多い）
 * - オープン以上のレースでは、収得賞金の多い馬ほど優先される（JRA の出走の優先順位。GI ほど強く効く）
 */
function classFactor(cls: ClassId, age: string, h: WorldHorse): number {
  const hr = CLASS_RANK[classOfEarnings(h.earnings)];
  const rr = Math.min(4, CLASS_RANK[cls]);
  const d = rr - hr;
  let f = d <= 0 ? 1 : (isOpenClass(cls) && (age === '2' || age === '3') ? 0.5 : 0.06) ** d;
  if (isOpenClass(cls)) f *= (1 + h.earnings / 2000) ** (cls === 'g1' ? 1.5 : isGraded(cls) ? 1 : 0.5);
  return f;
}

function ruleFor(rng: Rng, cls: ClassId, age: string, special: boolean): WeightRule {
  // 2歳・3歳限定：条件戦は馬齢、オープン特別・リステッドは別定
  if (age === '2' || age === '3') return isOpenClass(cls) ? 'allowance' : 'age';
  if (isOpenClass(cls)) return rng.chance(0.25) ? 'handicap' : 'allowance';
  if (special && (cls === 'win2' || cls === 'win3') && rng.chance(0.3)) return 'handicap';
  return 'wfa';
}

/** 番組に沿って8レースを組む */
function draftProgram(meetingId: string, world: World): Draft[] {
  const rng = new Rng(`meeting:${meetingId}`);
  const date = world.date;
  const month = monthOf(date);
  const sky = weatherSequence(rng, SLOTS.length);
  const used = new Set<string>();
  const names = rng.shuffle([...SPECIAL_NAMES]);
  const avail = eligibleHorses(world);
  const drafts: Draft[] = [];

  // メインレース（重賞）を先に組む（有力馬を先に確保するため）。出走表の順番は 1R〜8R のまま
  const order = [SLOTS.length - 1, ...SLOTS.map((_, i) => i).slice(0, -1)];
  const bySlot = new Map<number, Draft>();
  for (const r of order) {
    const slot = SLOTS[r];
    const stakes = r === SLOTS.length - 1 ? stakesOfWeek(date.week) : undefined;
    const elig = (alt: Pick<ProgramAlt, 'cls' | 'age'>, filly: boolean) =>
      avail.filter(
        (h) =>
          !used.has(h.id) &&
          ageEligible(alt.age, ageOf(h, date)) &&
          classEligible(alt.cls, { earnings: h.earnings, starts: h.career.starts }) &&
          (!filly || h.sex === '牝'),
      );
    let alt: Pick<ProgramAlt, 'cls' | 'age'> | undefined;
    let filly = false;
    let pool: WorldHorse[] = [];
    let surface = slot.surface;
    let layout = slot.layout;
    let distance = rng.pick(slot.distances);
    let name = '';
    let rule: WeightRule | undefined;
    let prize: number | undefined;
    let timeOfDay = slot.timeOfDay;
    if (stakes) {
      const p = elig(stakes, !!stakes.filly);
      if (p.length >= MIN_FIELD) {
        alt = stakes;
        filly = !!stakes.filly;
        pool = p;
        surface = stakes.surface;
        layout = stakes.layout;
        distance = stakes.distance;
        name = stakes.name;
        rule = stakes.rule;
        prize = stakes.prize;
        timeOfDay = stakes.timeOfDay ?? slot.timeOfDay;
      }
    }
    if (!alt) {
      // 候補のうち、出走できる馬が足りるものから選ぶ（自分のクラスの馬が多いレースほど選ばれやすい）
      const cands = altsFor(slot, date.week)
        .map((a) => {
          const fl = slot.special && rng.chance(0.12);
          let p = elig(a, fl);
          let f = fl;
          if (fl && p.length < MIN_FIELD) {
            p = elig(a, false);
            f = false;
          }
          const own = p.filter((h) => (a.cls === 'newcomer' ? true : CLASS_RANK[classOfEarnings(h.earnings)] >= Math.min(4, CLASS_RANK[a.cls]))).length;
          return { a, p, f, score: a.w * Math.min(own, 40) };
        })
        .filter((c) => c.p.length >= MIN_FIELD && c.score > 0);
      if (cands.length === 0) continue;
      const c = cands[pickWeighted(rng, cands, cands.map((x) => x.score))];
      alt = c.a;
      pool = c.p;
      filly = c.f;
    }
    const cls = alt.cls;
    rule ??= ruleFor(rng, cls, alt.age, slot.special);
    prize ??= basePrize(cls, alt.age, slot.special, month, surface, distance, filly);
    const terms: RaceTerms = { cls, age: alt.age, ...(filly ? { filly: true } : {}), rule, special: slot.special || !!stakes, prize };
    if (!name) name = slot.special ? `${names.pop() ?? '翠ヶ原'}${CLASS_RANK[cls] >= 3 ? 'ステークス' : '特別'}` : termsLabel(terms);

    const size = Math.min(pool.length, rng.int(slot.field[0], slot.field[1]));
    const weights = pool.map((h) => fitWeight(snapshotLite(h), surface, distance) * classFactor(cls, alt!.age, h));
    const chosen = pickMany(rng, pool, weights, size);
    chosen.forEach((h) => used.add(h.id));
    const weightOf = entryWeights(terms, chosen, world, distance);
    const snaps = chosen.map((h) => snapshot(h, date));
    const conditions: RaceConditions = { surface, ...(surface === 'turf' && layout ? { layout } : {}), distance, ...sky[r], timeOfDay, month };
    bySlot.set(r, { name, conditions, terms, entries: toEntries(rng, snaps, (_h, i) => weightOf[i], true) });
  }
  for (let r = 0; r < SLOTS.length; r++) {
    const d = bySlot.get(r);
    if (d) drafts.push(d);
  }
  return drafts;
}

/** 出走の選ばれやすさの計算に使う、能力の写し（疲労だけ当日の値） */
function snapshotLite(h: WorldHorse): Horse {
  return { ...h, form: { condition: 0, fatigue: Math.round(h.life.fatigue), mental: 0 } };
}

/** 負担重量（raceclass.ts の決め方で、出走馬ごとに） */
export function entryWeights(terms: RaceTerms, horses: WorldHorse[], world: World, distance: number): number[] {
  const month = monthOf(world.date);
  const base = horses.map((h) => baseWeight(terms, ageOf(h, world.date), h.sex, month, distance));
  if (terms.rule === 'handicap') return handicapWeights(horses.map((h) => handicapRating(h.history, h.earnings)));
  if (terms.rule === 'allowance') {
    return horses.map((h, i) => {
      const recent = h.history.filter((x) => weeksBetween({ year: x.y, week: x.w }, world.date) <= 52 && x.rk === 1);
      const cnt = (k: ClassId) => recent.filter((x) => x.k === k).length;
      return base[i] + allowanceExtra(terms.cls, { earnings: h.earnings, g1Wins: cnt('g1'), g2Wins: cnt('g2'), g3Wins: cnt('g3') });
    });
  }
  return base;
}

/** 出走表と seed からレースを実行する（結果決定用・モンテカルロ用で共通） */
export function runRace(card: Pick<RaceCard, 'id' | 'conditions' | 'entries'>, seed: string, opts?: SimOptions): SimResult {
  const runners = card.entries.map((e) => ({ horse: entryHorse(e), number: e.number, ...(e.weight !== undefined ? { weight: e.weight } : {}) }));
  return simulateRace(card.conditions, runners, `${card.id}|${seed}`, opts);
}

export interface VerifyResult {
  hashOk: boolean;
  recomputedHash: string;
  /** 馬番での着順 */
  order: number[];
}

/** 公開された seed を使って、コミットとの一致と着順を再計算する */
export async function verifyRace(card: RaceCard, revealedSeed: string): Promise<VerifyResult> {
  const recomputedHash = await sha256Hex(commitInput(card.id, revealedSeed, card.engineVersion));
  const res = runRace(card, revealedSeed, { record: false });
  return {
    hashOk: recomputedHash === card.commit,
    recomputedHash,
    order: res.order.map((i) => card.entries[i].number),
  };
}
