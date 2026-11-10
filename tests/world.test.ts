import { describe, expect, it } from 'vitest';
import { createMeeting, runRace, verifyRace } from '../src/core/meeting';
import { finishRace, closeRace, openMeeting, resultForWorld, runUnwatchedMeeting } from '../src/core/raceflow';
import { estimateProbabilities } from '../src/core/probability';
import { createInitialState } from '../src/core/state';
import { loadState, memoryKV, migrate, saveState } from '../src/core/storage';
import { HORSES } from '../src/data/roster';
import { MIN_REST_WEEKS, addWeeks, advanceWeek, ageOf, createWorld, eligibleHorses, recordRace, weeksBetween } from '../src/core/world';

const T0 = new Date(2026, 9, 13, 12, 0, 0).getTime();

describe('競馬界（ワールド）', () => {
  const w = createWorld();
  it('既存の36頭を引き継ぎ、架空の馬を加える。名前とIDは一意で、同じ条件からは同じ競馬界になる', () => {
    expect(w.horses.length).toBeGreaterThan(300);
    for (const h of HORSES) expect(w.horses.find((x) => x.id === h.id)?.name).toBe(h.name);
    expect(new Set(w.horses.map((h) => h.id)).size).toBe(w.horses.length);
    expect(new Set(w.horses.map((h) => h.name)).size).toBe(w.horses.length);
    expect(createWorld()).toEqual(w);
  });
  it('暦：週を進めると年が変わり、馬齢は1月に一斉に1つ増える', () => {
    expect(addWeeks({ year: 2026, week: 52 }, 1)).toEqual({ year: 2027, week: 1 });
    expect(weeksBetween({ year: 2026, week: 50 }, { year: 2027, week: 2 })).toBe(4);
    const h = w.horses[0];
    expect(ageOf(h, { year: 2027, week: 1 })).toBe(ageOf(h, { year: 2026, week: 52 }) + 1);
  });
});

describe('開催と戦績', () => {
  it('競馬界から出走馬を選び、同じ開催日に2度は走らせず、出走時点の能力を出走表に写す', async () => {
    const w = advanceWeek(createWorld());
    const cards = await createMeeting('W1', () => 'seed', w);
    const ids = cards.flatMap((c) => c.entries.map((e) => e.horseId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cards) for (const e of c.entries) expect(e.horse?.id).toBe(e.horseId);
  });

  it('既存の36頭にない（生成した）馬のレースも、公開 seed で再計算・検証できる', async () => {
    const w = advanceWeek(createWorld());
    const cards = await createMeeting('W2', () => 'seed-x', w);
    const card = cards.find((c) => c.entries.some((e) => e.horseId.startsWith('g')))!;
    const v = await verifyRace(card, 'seed-x');
    expect(v.hashOk).toBe(true);
    expect(v.order).toEqual(runRace(card, 'seed-x', { record: false }).order.map((i) => card.entries[i].number));
  });

  it('確定したレースは各馬の戦績（直近の走）に記録され、前走から間隔が空くまで出走しない', async () => {
    let s = await createInitialState(T0);
    s = { ...s, world: advanceWeek(s.world) };
    const cards = await createMeeting('W3', () => 'seed', s.world);
    s = await openMeeting(s, 'W3', cards, T0);
    const card = cards[0];
    s = await closeRace(s, card.id, estimateProbabilities(card, 20), T0 + 1000);
    s = await finishRace(s, card.id, s.meeting!.runtime[card.id].endsAt!);
    for (const e of card.entries) {
      const h = s.world.horses.find((x) => x.id === e.horseId)!;
      expect(h.history[0].r).toBe(card.id);
      expect(h.career.starts).toBe(1);
      expect(h.history[0].pop).toBeGreaterThanOrEqual(1);
    }
    const winner = card.entries[runRace(card, card.seed, { record: false }).order[0]];
    expect(s.world.horses.find((x) => x.id === winner.horseId)!.career.wins).toBe(1);
    // 次の週・その次の週は出走できず、MIN_REST_WEEKS 週後には出走できる
    let w = s.world;
    const ran = (ww: typeof w) => eligibleHorses(ww).some((h) => h.id === card.entries[0].horseId);
    for (let i = 1; i < MIN_REST_WEEKS; i++) {
      w = advanceWeek(w);
      expect(ran(w)).toBe(false);
    }
    w = advanceWeek(w);
    expect(ran(w)).toBe(true);
  });

  it('同じレースを二重に記録しない', async () => {
    const w = advanceWeek(createWorld());
    const [card] = await createMeeting('W4', () => 'seed', w);
    const r = resultForWorld(card, runRace(card, card.seed, { record: false }));
    const once = recordRace(w, r);
    expect(recordRace(once, r)).toEqual(once);
  });

  it('観戦しなかった開催日も、結果だけ計算して競馬界を1週進める', async () => {
    const w0 = createWorld();
    const w1 = await runUnwatchedMeeting(w0, 'U1');
    expect(weeksBetween(w0.date, w1.date)).toBe(1);
    expect(w1.horses.filter((h) => h.history.length === 1).length).toBeGreaterThan(50);
  });
});

describe('保存データの移行', () => {
  it('v1 の保存データは、残高・台帳・購入履歴を引き継いで v2（競馬界つき）になる', async () => {
    const s = await createInitialState(T0);
    const { world: _w, ...rest } = s;
    const v1 = { ...rest, version: 1, balance: 7777 };
    const m = migrate(JSON.parse(JSON.stringify(v1)))!;
    expect(m.version).toBe(2);
    expect(m.balance).toBe(7777);
    expect(m.ledger).toEqual(s.ledger);
    expect(m.world.horses.length).toBeGreaterThan(300);
  });
  it('未来の形式・壊れたデータは読み込まない', () => {
    expect(migrate({ version: 99 })).toBeNull();
    expect(migrate('x')).toBeNull();
  });
  it('競馬界を含む状態を保存して読み戻せ、保存容量は数MB以内', async () => {
    const kv = memoryKV();
    let s = await createInitialState(T0);
    let w = s.world;
    for (let i = 0; i < 12; i++) w = await runUnwatchedMeeting(w, `U${i}`);
    s = { ...s, world: w };
    expect(saveState(kv, s)).toBe(true);
    expect(loadState(kv)).toEqual(s);
    const size = (kv.getItem('virtual-turf:v1') ?? '').length;
    expect(size).toBeLessThan(2_500_000);
  });
});
