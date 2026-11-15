/**
 * レースの進行管理：発売 → 締切（オッズ確定）→ 発走 → 確定（seed の公開・払戻）。
 *
 * 時刻はすべて引数で受け取るため、テストでは任意の時刻を与えられる。
 * 利用者が画面を開いていない間に締切を過ぎたレースも、次に開いたときに同じ結果で確定する。
 */
import { appendAudit } from './audit';
import { BET_TYPE_BY_ID, type BetTypeId } from './bettypes';
import { type RaceCard, createMeeting, entryHorse, runRace } from './meeting';
import { type Pools, buildOddsBook, marketPools, poolTotal, settle, standardOdds, withStakes, withoutRefunded } from './pool';
import { Rng } from './rng';
import { GOING_INDEX, GOING_LABEL, type SimResult, courseShort } from './sim';
import { type RaceResultForWorld, type World, advanceWeek, recordRace } from './world';
import type { Probabilities } from './probability';
import { type AppState, refundScratched, settleRace } from './state';

/** デモ用の発売時間：最初のレースは開催開始の5分後、以降4分間隔 */
export const FIRST_CLOSE_MS = 5 * 60 * 1000;
export const CLOSE_INTERVAL_MS = 4 * 60 * 1000;
/** 締切から発走までの演出時間 */
export const GATE_LOADING_MS = 6000;
/** オッズが更新される間隔 */
export const ODDS_TICK_MS = 10_000;

export type RaceStatus = 'open' | 'closed' | 'running' | 'finished';

export const STATUS_LABEL: Record<RaceStatus, string> = {
  open: '発売中',
  closed: '締切',
  running: '発走',
  finished: '確定',
};

export interface RaceRuntime {
  openedAt: number;
  closesAt: number;
  closedAt?: number;
  /** 締切時点で確定したプール */
  finalPools?: Pools;
  startsAt?: number;
  endsAt?: number;
  /** 確定着順（馬番） */
  order?: number[];
  payoutOdds?: Record<BetTypeId, Record<string, number>>;
  finishedAt?: number;
  /** 発売開始後に出走取消・競走除外になった馬番（第11段階から。締切のときに決まる） */
  scratched?: number[];
  /** 同着があるときの着順（order と同じ並び。例：1,1,3） */
  ranks?: number[];
  /** 特払い（的中者がいなかった券種 → 払戻の率） */
  special?: Partial<Record<BetTypeId, number>>;
}

/**
 * 同着とみなすゴールの時間差（秒）。約 5mm に当たる（推定。JRA は写真判定で見分けられないときに同着とする）。
 * 3着以内の同着は 1,000レースに数回の頻度になる。
 */
export const DEAD_HEAT_EPS = 0.0003;

/** 着順（同着は同じ数）。order は着順どおりの出走馬の番号（entries の位置）、times は entries の位置ごとの走破時計 */
export function ranksOf(order: number[], times: number[]): number[] {
  const ranks: number[] = [];
  order.forEach((i, k) => {
    ranks.push(k > 0 && times[i] - times[order[k - 1]] < DEAD_HEAT_EPS ? ranks[k - 1] : k + 1);
  });
  return ranks;
}

/** 発売開始後の出走取消・競走除外の起こりやすさ（1頭あたり。推定） */
export const SCRATCH_RATE = 0.003;

/**
 * 発売開始後の出走取消・競走除外（締切のときに決まる。1レースに1頭まで、6頭以上のレースだけ。簡略化）。
 * 結果決定用の seed から決めるので、締切の前には分からない。
 */
export function scratchOf(card: Pick<RaceCard, 'id' | 'seed' | 'entries'>): number[] {
  const n = card.entries.length;
  if (n < 6) return [];
  const rng = new Rng(`scratch:${card.id}:${card.seed}`);
  return rng.chance(n * SCRATCH_RATE) ? [card.entries[rng.int(0, n - 1)].number] : [];
}

/** 出走取消・競走除外の馬を除いた出走表（レースの計算に使う。馬番・枠番は変わらない） */
export function activeCard<T extends Pick<RaceCard, 'entries'>>(card: T, scratched?: number[]): T {
  return scratched?.length ? { ...card, entries: card.entries.filter((e) => !scratched.includes(e.number)) } : card;
}

export interface MeetingState {
  id: string;
  createdAt: number;
  cards: RaceCard[];
  runtime: Record<string, RaceRuntime>;
}

export function raceStatus(rt: RaceRuntime, now: number): RaceStatus {
  if (rt.finishedAt !== undefined) return 'finished';
  if (rt.closedAt === undefined) return now < rt.closesAt ? 'open' : 'closed';
  if (rt.startsAt !== undefined && now >= rt.startsAt) return 'running';
  return 'closed';
}

export function cardOf(meeting: MeetingState, raceId: string): RaceCard {
  const c = meeting.cards.find((k) => k.id === raceId);
  if (!c) throw new Error(`unknown race ${raceId}`);
  return c;
}

export async function openMeeting(state: AppState, meetingId: string, cards: RaceCard[], now: number): Promise<AppState> {
  const runtime: Record<string, RaceRuntime> = {};
  let audit = state.audit;
  for (const c of cards) {
    runtime[c.id] = { openedAt: now, closesAt: now + FIRST_CLOSE_MS + (c.no - 1) * CLOSE_INTERVAL_MS };
    audit = await appendAudit(audit, 'race_open', { race: c.id, commit: c.commit, engine: c.engineVersion }, now);
  }
  const raceNames = { ...state.raceNames };
  for (const c of cards) raceNames[c.id] = `${c.no}R ${c.name}`;
  return { ...state, audit, raceNames, meeting: { id: meetingId, createdAt: now, cards, runtime } };
}

/** 発売の進み具合（0.25 で始まり、締切で 1） */
export function marketProgress(rt: RaceRuntime, now: number): number {
  const span = Math.max(1, rt.closesAt - rt.openedAt);
  return Math.min(1, 0.25 + (0.75 * Math.max(0, now - rt.openedAt)) / span);
}

export function oddsTick(rt: RaceRuntime, now: number): number {
  return Math.floor(Math.max(0, Math.min(now, rt.closesAt) - rt.openedAt) / ODDS_TICK_MS);
}

/** 現在のプール（締切後は確定プール） */
export function currentPools(state: AppState, card: RaceCard, probs: Probabilities, now: number): Pools {
  const rt = state.meeting!.runtime[card.id];
  if (rt.finalPools) return rt.finalPools;
  const numbers = card.entries.map((e) => e.number);
  const market = marketPools(card.id, numbers, probs, marketProgress(rt, now), oddsTick(rt, now));
  return withStakes(market, state.tickets.filter((t) => t.raceId === card.id));
}

export function currentOddsBook(state: AppState, card: RaceCard, probs: Probabilities, now: number) {
  return buildOddsBook(
    currentPools(state, card, probs, now),
    card.entries.map((e) => e.number),
  );
}

function patchRuntime(state: AppState, raceId: string, patch: Partial<RaceRuntime>): AppState {
  const m = state.meeting!;
  return { ...state, meeting: { ...m, runtime: { ...m.runtime, [raceId]: { ...m.runtime[raceId], ...patch } } } };
}

/** 締切：プールを確定し、発走時刻と終了時刻を決める（デモでは締切を早めることもできる） */
export async function closeRace(state: AppState, raceId: string, probs: Probabilities, now: number): Promise<AppState> {
  const m = state.meeting!;
  const rt = m.runtime[raceId];
  if (rt.closedAt !== undefined) return state;
  const card = cardOf(m, raceId);
  const closedAt = Math.min(now, rt.closesAt);
  const numbers = card.entries.map((e) => e.number);
  const scratched = scratchOf(card);
  // 出走取消・競走除外の馬番を含む組合せは返還し、プールから除く
  const finalPools = withoutRefunded(
    withStakes(marketPools(card.id, numbers, probs, 1, oddsTick(rt, closedAt)), state.tickets.filter((t) => t.raceId === raceId)),
    scratched,
    numbers.length,
  );
  const duration = Math.max(...runRace(activeCard(card, scratched), card.seed, { record: false }).finishTimes) + 3;
  const startsAt = closedAt + GATE_LOADING_MS;
  const endsAt = startsAt + duration * 1000;
  const totals = Object.fromEntries(Object.keys(finalPools).map((t) => [t, poolTotal(finalPools, t as BetTypeId)]));
  let next = patchRuntime(state, raceId, { closedAt, closesAt: closedAt, finalPools, startsAt, endsAt, ...(scratched.length ? { scratched } : {}) });
  next = { ...next, audit: await appendAudit(next.audit, 'race_close', { race: raceId, totals, ...(scratched.length ? { scratched } : {}) }, closedAt) };
  return refundScratched(next, raceId, scratched, numbers.length, closedAt);
}

/** 確定：公式シミュレーションの着順で払戻を計算し、seed を公開する */
export async function finishRace(state: AppState, raceId: string, now: number): Promise<AppState> {
  const m = state.meeting!;
  const rt = m.runtime[raceId];
  if (rt.finishedAt !== undefined || !rt.finalPools || rt.endsAt === undefined) return state;
  const card = cardOf(m, raceId);
  const run = activeCard(card, rt.scratched);
  const res = runRace(run, card.seed, { record: false });
  const order = res.order.map((i) => run.entries[i].number);
  const ranks = ranksOf(res.order, res.finishTimes);
  const tie = ranks.some((r, k) => r !== k + 1);
  // 発売する券種・複勝の対象・枠番は、発売開始時の頭数で決まる（JRA 公式）
  const st = settle(rt.finalPools, order, card.entries.length, tie ? ranks : undefined);
  const payoutOdds = st.odds;
  const finishedAt = Math.max(now, rt.endsAt);
  // 確定後は、組合せの多い券種（3連複・3連単）のプールを保存しない（保存容量のため。払戻は payoutOdds に残る）
  const kept = { ...rt.finalPools, trio: {}, trifecta: {} };
  let next = patchRuntime(state, raceId, { order, payoutOdds, finishedAt, finalPools: kept, ...(tie ? { ranks } : {}), ...(Object.keys(st.special).length ? { special: st.special } : {}) });
  next = {
    ...next,
    audit: await appendAudit(next.audit, 'race_result', { race: raceId, order, seed: card.seed, commit: card.commit }, finishedAt),
    // 各馬の戦績に記録する
    world: next.world ? recordRace(next.world, resultForWorld(run, res, rt.finalPools, tie ? ranks : undefined)) : next.world,
  };
  return settleRace(next, raceId, payoutOdds, finishedAt, st.special);
}

/** レース結果を、各馬の戦績に記録する形にまとめる（確定オッズ・人気はプールがあれば付ける） */
export function resultForWorld(card: RaceCard, res: SimResult, pools?: Pools, ranks?: number[]): RaceResultForWorld {
  const win = BET_TYPE_BY_ID.win;
  const odds = card.entries.map((e) => (pools ? standardOdds(win, pools, String(e.number)) : null));
  const popOrder = card.entries.map((_, i) => i).filter((i) => odds[i] !== null).sort((a, b) => odds[a]! - odds[b]!);
  return {
    raceId: card.id,
    raceName: card.name,
    course: courseShort(card.conditions),
    going: GOING_LABEL[card.conditions.going],
    fieldSize: card.entries.length,
    distance: card.conditions.distance,
    goingIndex: GOING_INDEX[card.conditions.going],
    ...(card.terms ? { terms: card.terms } : {}),
    pace: { high: 'H', middle: 'M', slow: 'S' }[res.pace],
    first: entryHorse(card.entries[res.order[0]]).name,
    ...(res.order.length > 1 ? { second: entryHorse(card.entries[res.order[1]]).name } : {}),
    runners: card.entries.map((e, i) => ({
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      ...(e.body !== undefined ? { body: e.body } : {}),
      ...(e.bodyDiff !== undefined ? { bodyDiff: e.bodyDiff } : {}),
      kakari: res.factors[i].kakari,
      horseId: e.horseId,
      number: e.number,
      rank: ranks ? ranks[res.order.indexOf(i)] : res.order.indexOf(i) + 1,
      time: res.finishTimes[i],
      margin: res.margins[i],
      last3F: res.last3F[i],
      passing: res.cornerOrders.map((c) => c.order.indexOf(i) + 1).join('-'),
      jockey: e.jockey,
      ...(e.ride ? { jockeyId: e.ride.id } : {}),
      ...(odds[i] !== null ? { odds: odds[i]!, popularity: popOrder.indexOf(i) + 1 } : {}),
    })),
  };
}

/**
 * 観戦しなかった開催日（画面を閉じていた間など）を、結果だけ計算して競馬界を進める。
 * 投票はないので、オッズ・払戻は計算しない。
 */
export async function runUnwatchedMeeting(world: World, meetingId: string): Promise<World> {
  let w = advanceWeek(world);
  const cards = await createMeeting(meetingId, undefined, w);
  for (const card of cards) {
    const res = runRace(card, card.seed, { record: false });
    w = recordRace(w, resultForWorld(card, res));
  }
  return w;
}

/** 開催日1日にかかる現実の時間の目安（最終レースの締切＋発走〜確定の時間） */
export const MEETING_SPAN_MS = FIRST_CLOSE_MS + 7 * CLOSE_INTERVAL_MS + 3 * 60 * 1000;
/** すべて確定してから次の開催日を自動で始めるまでの時間 */
export const NEXT_MEETING_DELAY_MS = 60 * 1000;
/** 画面を閉じていた間に進める開催日の上限 */
export const MAX_CATCH_UP = 12;

/**
 * 時刻 now までに締切・確定すべきレースを処理する。
 * getProbs はオッズ推定用の確率（重い計算なので呼び出し側でキャッシュする）。
 */
export async function advance(state: AppState, now: number, getProbs: (card: RaceCard) => Probabilities): Promise<AppState> {
  if (!state.meeting) return state;
  let s = state;
  for (const card of [...s.meeting!.cards].sort((a, b) => a.no - b.no)) {
    let rt = s.meeting!.runtime[card.id];
    if (rt.closedAt === undefined && now >= rt.closesAt) {
      s = await closeRace(s, card.id, getProbs(card), rt.closesAt);
      rt = s.meeting!.runtime[card.id];
    }
    if (rt.finishedAt === undefined && rt.endsAt !== undefined && now >= rt.endsAt) {
      s = await finishRace(s, card.id, rt.endsAt);
    }
  }
  return s;
}
