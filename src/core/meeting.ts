/**
 * 開催（1日8レース）の生成と、結果決定用 seed のコミット・リビール。
 *
 * - 出走表・条件は開催ID から決定論的に生成する（公開情報）
 * - 結果決定用 seed は暗号論的乱数で生成し、ハッシュだけを事前に公開する
 */
import { type Grade, HORSE_BY_ID, HORSES, JOCKEYS } from '../data/roster';
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
}

export interface RaceCard {
  id: string;
  meetingId: string;
  no: number;
  name: string;
  conditions: RaceConditions;
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
  distances: number[];
  timeOfDay: TimeOfDay;
  field: [number, number];
}

const PLAN: RacePlan[] = [
  { name: '暁雲特別', surface: 'dirt', distances: [1200, 1400], timeOfDay: 'day', field: [9, 12] },
  { name: '翠嶺特別', surface: 'turf', distances: [1400, 1600], timeOfDay: 'day', field: [9, 12] },
  { name: '湖月ステークス', surface: 'dirt', distances: [1800], timeOfDay: 'day', field: [10, 13] },
  { name: '星見坂賞', surface: 'turf', distances: [1600, 1800], timeOfDay: 'day', field: [10, 14] },
  { name: '灯台岬ステークス', surface: 'turf', distances: [2000, 2200], timeOfDay: 'day', field: [10, 14] },
  { name: '銀砂ダートマイル', surface: 'dirt', distances: [1600], timeOfDay: 'dusk', field: [11, 14] },
  { name: '宵灯スプリント', surface: 'turf', distances: [1200], timeOfDay: 'dusk', field: [11, 14] },
  { name: '翠ヶ原記念', surface: 'turf', distances: [2400], timeOfDay: 'night', field: [12, 14] },
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
 */
export async function createMeeting(meetingId: string, seedFn: () => string = secureSeed): Promise<RaceCard[]> {
  const rng = new Rng(`meeting:${meetingId}`);
  let weatherIdx = pickWeighted(rng, WEATHERS, [50, 30, 12, 8]);
  const usage = new Map<string, number>();
  const cards: RaceCard[] = [];

  for (let r = 0; r < PLAN.length; r++) {
    const plan = PLAN[r];
    if (r > 0 && rng.chance(0.15)) weatherIdx = Math.max(0, Math.min(3, weatherIdx + (rng.chance(0.5) ? 1 : -1)));
    const weather = WEATHERS[weatherIdx];
    const goingIdx = Math.max(0, Math.min(3, Math.round(MOISTURE[weather] + rng.normal(0, 0.4))));
    const distance = rng.pick(plan.distances);
    const conditions: RaceConditions = {
      surface: plan.surface,
      distance,
      weather,
      going: GOINGS[goingIdx],
      timeOfDay: plan.timeOfDay,
    };

    // 出走馬の選定：コース適性と距離適性で重み付け。同じ開催での連闘は出にくくする
    const size = rng.int(plan.field[0], plan.field[1]);
    const pool = [...HORSES];
    const weights = pool.map((h) => {
      const grade = plan.surface === 'turf' ? h.turf : h.dirt;
      const fit = Math.exp(-(((distance - h.bestDistance) / 500) ** 2)) + 0.1;
      return (GRADE_WEIGHT[grade] * fit) / (1 + 2 * (usage.get(h.id) ?? 0));
    });
    const chosen: string[] = [];
    while (chosen.length < size) {
      const idx = pickWeighted(rng, pool, weights);
      chosen.push(pool[idx].id);
      pool.splice(idx, 1);
      weights.splice(idx, 1);
    }
    chosen.forEach((id) => usage.set(id, (usage.get(id) ?? 0) + 1));
    rng.shuffle(chosen);
    const jockeys = rng.shuffle([...JOCKEYS]);
    const entries: RaceEntry[] = chosen.map((horseId, i) => ({
      horseId,
      number: i + 1,
      frame: frameOf(size, i + 1),
      jockey: jockeys[i],
    }));

    const id = `${meetingId}-R${r + 1}`;
    const seed = seedFn();
    cards.push({
      id,
      meetingId,
      no: r + 1,
      name: plan.name,
      conditions,
      entries,
      seed,
      commit: await sha256Hex(commitInput(id, seed)),
      engineVersion: ENGINE_VERSION,
    });
  }
  return cards;
}

/** 出走表と seed からレースを実行する（結果決定用・モンテカルロ用で共通） */
export function runRace(card: Pick<RaceCard, 'id' | 'conditions' | 'entries'>, seed: string, opts?: SimOptions): SimResult {
  const runners = card.entries.map((e) => {
    const horse = HORSE_BY_ID.get(e.horseId);
    if (!horse) throw new Error(`unknown horse ${e.horseId}`);
    return { horse, number: e.number };
  });
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
