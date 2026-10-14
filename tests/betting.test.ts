import { beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAudit } from '../src/core/audit';
import { BET_TYPE_BY_ID, allKeys, betKey, validateSelection, winningKeys } from '../src/core/bettypes';
import { type RaceCard, createMeeting, runRace } from '../src/core/meeting';
import {
  type Pools,
  buildOddsBook,
  emptyPools,
  floorOdds,
  marketPools,
  placeOddsFor,
  placeOddsRange,
  poolTotal,
  settleOdds,
  standardOdds,
  withStakes,
} from '../src/core/pool';
import { type Probabilities, estimateProbabilities } from '../src/core/probability';
import {
  advance,
  closeRace,
  currentOddsBook,
  openMeeting,
  raceStatus,
} from '../src/core/raceflow';
import {
  BET_LIMITS_ENABLED,
  SELF_EXCLUSION_ENABLED,
  DAY,
  HOUR,
  LIMIT_INCREASE_DELAY_MS,
  changeLimits,
  checkBet,
  effectiveLimits,
  selfExclude,
  startBreak,
} from '../src/core/responsible';
import {
  type AppState,
  INITIAL_GRANT,
  REFILL_AMOUNT,
  canRefill,
  createInitialState,
  placeBet,
  quoteBet,
  raceSummaries,
  refill,
  settleRace,
} from '../src/core/state';
import { loadState, memoryKV, saveState } from '../src/core/storage';

const T0 = new Date(2026, 9, 13, 12, 0, 0).getTime();
const W = BET_TYPE_BY_ID.win;
const P = BET_TYPE_BY_ID.place;
const Q = BET_TYPE_BY_ID.quinella;
const E = BET_TYPE_BY_ID.exacta;

function pools(partial: Partial<Pools>): Pools {
  return { ...emptyPools(), ...partial };
}

let cards: RaceCard[];
let card: RaceCard;
let probs: Probabilities;
const probsCache = new Map<string, Probabilities>();
const getProbs = (c: RaceCard) => {
  if (!probsCache.has(c.id)) probsCache.set(c.id, estimateProbabilities(c, 40));
  return probsCache.get(c.id)!;
};

beforeAll(async () => {
  let i = 0;
  cards = await createMeeting('bet-test', () => `s${i++}`);
  card = cards[0];
  probs = getProbs(card);
});

describe('券種（登録の仕組み）', () => {
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('組み合わせ数', () => {
    expect(allKeys(W, nums)).toHaveLength(10);
    expect(allKeys(Q, nums)).toHaveLength(45);
    expect(allKeys(E, nums)).toHaveLength(90);
  });
  it('馬連は順不同、馬単は順序どおりのキー', () => {
    expect(betKey(Q, [7, 3])).toBe('3-7');
    expect(betKey(E, [7, 3])).toBe('7>3');
  });
  it('的中キー', () => {
    const order = [5, 2, 9, 1];
    expect(winningKeys(W, order, 10)).toEqual(['5']);
    expect(winningKeys(P, order, 10)).toEqual(['5', '2', '9']);
    expect(winningKeys(P, order, 7)).toEqual(['5', '2']);
    expect(winningKeys(Q, order, 10)).toEqual(['2-5']);
    expect(winningKeys(E, order, 10)).toEqual(['5>2']);
  });
  it('選択の検証', () => {
    expect(validateSelection(Q, [1], nums)).toMatch('2頭');
    expect(validateSelection(Q, [1, 1], nums)).toMatch('重複');
    expect(validateSelection(W, [99], nums)).toMatch('出走していない');
    expect(validateSelection(E, [1, 2], nums)).toBeNull();
  });
});

describe('確率推定（モンテカルロ法）', () => {
  it('確率の合計が的中キーの数と一致する', () => {
    const sum = (t: keyof Probabilities['byType']) => Object.values(probs.byType[t]).reduce((a, b) => a + b, 0);
    expect(sum('win')).toBeCloseTo(1, 5);
    expect(sum('quinella')).toBeCloseTo(1, 5);
    expect(sum('exacta')).toBeCloseTo(1, 5);
    expect(sum('place')).toBeCloseTo(3, 5);
  });
  it('一度も起きなかった組み合わせにも正の確率が残る', () => {
    Object.values(probs.byType.exacta).forEach((p) => expect(p).toBeGreaterThan(0));
  });
  it('結果決定用 seed を使わない（seed を変えても推定値は同じ）', () => {
    const a = estimateProbabilities({ ...card }, 20);
    const b = estimateProbabilities({ ...card, ...{ seed: 'other' } } as RaceCard, 20);
    expect(a).toEqual(b);
  });
});

describe('パリミュチュエル方式のオッズ', () => {
  it('オッズは0.1倍単位で切り捨て、最低1.0倍', () => {
    expect(floorOdds(1.3333)).toBe(1.3);
    expect(floorOdds(2.6999)).toBe(2.6);
    expect(floorOdds(0.8)).toBe(1);
  });
  it('単勝オッズ = 総額 × (1 − 控除率) ÷ その馬への投票額', () => {
    const p = pools({ win: { '1': 600, '2': 300, '3': 100 } });
    expect(standardOdds(W, p, '1')).toBe(1.3);
    expect(standardOdds(W, p, '2')).toBe(2.6);
    expect(standardOdds(W, p, '3')).toBe(8);
    expect(standardOdds(W, p, '4')).toBeNull();
  });
  it('複勝：利益を的中馬の数で等分してから分配する', () => {
    const p = pools({ place: { '1': 100, '2': 100, '3': 100, '4': 700 } });
    expect(placeOddsFor(P, p, ['1', '2', '3'])).toEqual({ '1': 2.6, '2': 2.6, '3': 2.6 });
  });
  it('複勝：払戻が投票額を下回る場合は1.0倍（元返し）', () => {
    const p = pools({ place: { '1': 500, '2': 300, '3': 100, '4': 100 } });
    expect(placeOddsFor(P, p, ['1', '2', '3'])).toEqual({ '1': 1, '2': 1, '3': 1 });
  });
  it('複勝の想定オッズ幅は 下限 ≤ 上限', () => {
    const numbers = card.entries.map((e) => e.number);
    const p = marketPools(card.id, numbers, probs, 1, 0);
    for (const n of numbers) {
      const r = placeOddsRange(P, p, String(n), numbers.length)!;
      expect(r[0]).toBeLessThanOrEqual(r[1]);
    }
  });
  it('市場プールは決定論的で、規模は発売の進み具合に比例する', () => {
    const numbers = card.entries.map((e) => e.number);
    const a = marketPools(card.id, numbers, probs, 0.5, 3);
    expect(a).toEqual(marketPools(card.id, numbers, probs, 0.5, 3));
    expect(poolTotal(a, 'win')).toBeCloseTo(W.marketSize * 0.5, -2);
  });
  it('発売中はオッズが変動する', () => {
    const numbers = card.entries.map((e) => e.number);
    const b1 = buildOddsBook(marketPools(card.id, numbers, probs, 0.4, 1), numbers);
    const b2 = buildOddsBook(marketPools(card.id, numbers, probs, 0.6, 5), numbers);
    expect(b1.odds.win).not.toEqual(b2.odds.win);
  });
  it('人気（低オッズ）は推定勝率の高い馬におおむね一致する', () => {
    const numbers = card.entries.map((e) => e.number);
    const book = buildOddsBook(marketPools(card.id, numbers, probs, 1, 0), numbers);
    const bestProb = Object.entries(probs.byType.win).sort((a, b) => b[1] - a[1])[0][0];
    const fav = Object.entries(book.odds.win).sort((a, b) => (a[1] ?? 999) - (b[1] ?? 999)).slice(0, 3).map(([k]) => k);
    expect(fav).toContain(bestProb);
  });
  it('払戻還元率：的中者全体への払戻 ≒ プール総額 × (1 − 控除率)', () => {
    const numbers = card.entries.map((e) => e.number);
    const p = marketPools(card.id, numbers, probs, 1, 0);
    const order = runRace(card, 'x', { record: false }).order.map((i) => card.entries[i].number);
    const res = settleOdds(p, order, numbers.length);
    const [k] = Object.keys(res.win);
    const paid = p.win[k] * res.win[k];
    const net = poolTotal(p, 'win') * (1 - W.takeout);
    expect(paid).toBeLessThanOrEqual(net + 1);
    expect(paid).toBeGreaterThan(net * 0.9);
  });
});

describe('責任ある利用', () => {
  let s: AppState;
  beforeAll(async () => {
    s = await createInitialState(T0);
  });

  it('100コイン単位・残高・1レース上限・1日上限をチェックする', () => {
    expect(checkBet(s, 'r1', 150, T0, true)).toMatchObject({ ok: false, code: 'min_unit' });
    expect(checkBet(s, 'r1', 100, T0, false)).toMatchObject({ ok: false, code: 'race_closed' });
    expect(checkBet(s, 'r1', s.limits.perRace + 100, T0, true, true)).toMatchObject({ ok: false, code: 'per_race' });
    expect(checkBet({ ...s, balance: 50 }, 'r1', 100, T0, true)).toMatchObject({ ok: false, code: 'balance' });
    expect(checkBet(s, 'r1', 1000, T0, true)).toEqual({ ok: true });
  });

  it('デモ設定では投票上限を適用しない（残高・100コイン単位・締切・休止は適用する）', () => {
    expect(BET_LIMITS_ENABLED).toBe(false);
    expect(checkBet(s, 'r1', s.limits.perRace + 100, T0, true)).toEqual({ ok: true });
    expect(checkBet(s, 'r1', s.balance, T0, true)).toEqual({ ok: true });
    expect(checkBet(s, 'r1', s.balance + 100, T0, true)).toMatchObject({ ok: false, code: 'balance' });
    expect(checkBet(s, 'r1', 150, T0, true)).toMatchObject({ ok: false, code: 'min_unit' });
  });

  it('デモ設定では休止・自己排除を適用しない（保存済みの期限があっても投票できる）', () => {
    expect(SELF_EXCLUSION_ENABLED).toBe(false);
    expect(checkBet(startBreak(s, 168, T0), 'r1', 100, T0, true)).toEqual({ ok: true });
    expect(checkBet(selfExclude(s, 180, T0), 'r1', 100, T0, true)).toEqual({ ok: true });
    expect(canRefill({ ...startBreak(s, 24, T0), balance: 0 }, T0)).toBe(true);
  });

  it('未確定の投票も損失見込みに含めて、損失上限で止める（上限を有効にした場合）', async () => {
    let st = s;
    const numbers = card.entries.map((e) => e.number);
    const book = currentOddsBook(await openMeeting(st, 'm', cards, T0), card, probs, T0);
    for (const race of ['a', 'b']) {
      const r = await placeBet(st, { raceId: race, betType: 'win', selection: [numbers[0]], stake: 2500 }, numbers, book, T0, true);
      expect(r.ok).toBe(true);
      if (r.ok) st = r.state;
    }
    expect(checkBet(st, 'c', 100, T0, true, true)).toMatchObject({ ok: false, code: 'daily_loss' });
  });

  it('上限の引き下げは即時、引き上げは24時間後に反映', () => {
    const lower = changeLimits(s, { ...s.limits, perRace: 1000 }, T0);
    expect(lower.change.applied).toBe('now');
    expect(effectiveLimits(lower.state, T0).perRace).toBe(1000);

    const raise = changeLimits(lower.state, { ...lower.state.limits, perRace: 9000 }, T0);
    expect(raise.change.applied).toBe('later');
    expect(effectiveLimits(raise.state, T0 + HOUR).perRace).toBe(1000);
    expect(effectiveLimits(raise.state, T0 + LIMIT_INCREASE_DELAY_MS).perRace).toBe(9000);
  });

  it('引き上げと引き下げを同時に行うと、引き下げ分だけ即時に反映', () => {
    const r = changeLimits(s, { ...s.limits, perRace: 9000, daily: 2000 }, T0);
    expect(r.change.applied).toBe('later');
    expect(effectiveLimits(r.state, T0).daily).toBe(2000);
    expect(effectiveLimits(r.state, T0).perRace).toBe(s.limits.perRace);
  });

  it('休止・自己排除を有効にした場合は投票できず、期間を短くすることもできない', () => {
    const b = startBreak(s, 24, T0);
    expect(checkBet(b, 'r', 100, T0 + HOUR, true, false, true)).toMatchObject({ ok: false, code: 'on_break' });
    expect(checkBet(b, 'r', 100, T0 + 25 * HOUR, true, false, true)).toEqual({ ok: true });
    expect(startBreak(b, 1, T0).breakUntil).toBe(b.breakUntil);

    const x = selfExclude(s, 30, T0);
    expect(checkBet(x, 'r', 100, T0 + 29 * DAY, true, false, true)).toMatchObject({ ok: false, code: 'self_excluded' });
    expect(() => selfExclude(s, 7, T0)).toThrow();
  });
});

describe('台帳・投票・払戻', () => {
  it('初期状態：10,000コインと監査ログ', async () => {
    const s = await createInitialState(T0);
    expect(s.balance).toBe(INITIAL_GRANT);
    expect(s.audit).toHaveLength(1);
  });

  it('購入前の確認で、オッズ・想定払戻・購入後残高が分かる', async () => {
    const s = await openMeeting(await createInitialState(T0), 'm', cards, T0);
    const numbers = card.entries.map((e) => e.number);
    const book = currentOddsBook(s, card, probs, T0);
    const q = quoteBet(s, { raceId: card.id, betType: 'win', selection: [numbers[0]], stake: 500 }, numbers, book, T0, true);
    expect(q.odds).toBeGreaterThanOrEqual(1);
    expect(q.estPayout![0]).toBe(Math.round(500 * q.odds!));
    expect(q.balanceAfter).toBe(INITIAL_GRANT - 500);
    const qp = quoteBet(s, { raceId: card.id, betType: 'place', selection: [numbers[0]], stake: 500 }, numbers, book, T0, true);
    expect(qp.range).not.toBeNull();
    expect(qp.estPayout![0]).toBeLessThanOrEqual(qp.estPayout![1]);
  });

  it('レース全体の流れ：発売 → 購入 → 締切 → 発走 → 確定・払戻', async () => {
    let s = await openMeeting(await createInitialState(T0), 'm', cards, T0);
    const rt0 = s.meeting!.runtime[card.id];
    expect(raceStatus(rt0, T0)).toBe('open');

    // 公式結果の1着・2着を知っている前提で、的中券と外れ券を買う（テストのみ）
    const official = runRace(card, card.seed, { record: false }).order.map((i) => card.entries[i].number);
    const numbers = card.entries.map((e) => e.number);
    const book = currentOddsBook(s, card, probs, T0 + 1000);
    const bets = [
      { betType: 'win' as const, selection: [official[0]], stake: 1000 },
      { betType: 'exacta' as const, selection: [official[0], official[1]], stake: 500 },
      { betType: 'win' as const, selection: [official.at(-1)!], stake: 300 },
    ];
    for (const b of bets) {
      const r = await placeBet(s, { raceId: card.id, ...b }, numbers, book, T0 + 1000, true);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(s.balance).toBe(INITIAL_GRANT - 1800);

    // 締切時刻を過ぎると自動で締切 → 発走 → 確定
    s = await advance(s, rt0.closesAt + 1, getProbs);
    const rt1 = s.meeting!.runtime[card.id];
    expect(rt1.finalPools).toBeDefined();
    expect(raceStatus(rt1, rt1.startsAt! + 1)).toBe('running');
    s = await advance(s, rt1.endsAt! + 1, getProbs);
    const rt2 = s.meeting!.runtime[card.id];
    expect(raceStatus(rt2, rt2.finishedAt!)).toBe('finished');
    expect(rt2.order).toEqual(official);

    const winT = s.tickets.find((t) => t.betType === 'win' && t.selection[0] === official[0])!;
    const exT = s.tickets.find((t) => t.betType === 'exacta')!;
    const lostT = s.tickets.find((t) => t.selection[0] === official.at(-1))!;
    expect(winT.status).toBe('won');
    expect(winT.payout).toBe(Math.round(1000 * rt2.payoutOdds!.win[String(official[0])]));
    expect(exT.status).toBe('won');
    expect(lostT.status).toBe('lost');
    expect(s.balance).toBe(INITIAL_GRANT - 1800 + winT.payout! + exT.payout!);

    // 台帳の合計と残高が一致する
    expect(s.ledger.reduce((a, l) => a + l.amount, 0)).toBe(s.balance);
    // レース別収支
    const [sum] = raceSummaries(s);
    expect(sum).toMatchObject({ raceId: card.id, stake: 1800, hits: 2, settled: true });
    // 締切後は購入できない
    const late = await placeBet(s, { raceId: card.id, betType: 'win', selection: [1], stake: 100 }, numbers, book, rt2.finishedAt!, false);
    expect(late.ok).toBe(false);
    // 監査ログは改ざんされていない
    expect((await verifyAudit(s.audit)).ok).toBe(true);
    expect(s.audit.map((a) => a.type)).toEqual(expect.arrayContaining(['race_open', 'bet', 'race_close', 'race_result', 'settle']));
  });

  it('締切を早めると、その時点でプールが確定する', async () => {
    let s = await openMeeting(await createInitialState(T0), 'm', cards, T0);
    s = await closeRace(s, card.id, probs, T0 + 30_000);
    const rt = s.meeting!.runtime[card.id];
    expect(rt.closedAt).toBe(T0 + 30_000);
    expect(currentOddsBook(s, card, probs, T0 + 60_000)).toEqual(currentOddsBook(s, card, probs, T0 + 90_000));
  });

  it('settleRace は同じレースを二重に払い戻さない', async () => {
    let s = await createInitialState(T0);
    const numbers = [1, 2, 3];
    const book = buildOddsBook(withStakes(emptyPools(), [{ betType: 'win', key: '1', stake: 1000 }]), numbers);
    const r = await placeBet(s, { raceId: 'r', betType: 'win', selection: [1], stake: 100 }, numbers, book, T0, true);
    if (!r.ok) throw new Error(r.message);
    s = await settleRace(r.state, 'r', { win: { '1': 2 }, place: {}, quinella: {}, exacta: {} }, T0);
    const once = s.balance;
    s = await settleRace(s, 'r', { win: { '1': 2 }, place: {}, quinella: {}, exacta: {} }, T0);
    expect(s.balance).toBe(once);
  });

  it('補充は残高が少ないときに1日1回だけ', async () => {
    const s = { ...(await createInitialState(T0)), balance: 500 };
    expect(canRefill(s, T0)).toBe(true);
    const r = await refill(s, T0);
    expect(r.balance).toBe(500 + REFILL_AMOUNT);
    expect(canRefill({ ...r, balance: 0 }, T0 + HOUR)).toBe(false);
  });
});

describe('監査ログ（ハッシュチェーン）', () => {
  it('改ざんを検出する', async () => {
    let log = await appendAudit([], 'race_open', { race: 'r1' }, T0);
    log = await appendAudit(log, 'bet', { stake: 100 }, T0 + 1);
    log = await appendAudit(log, 'bet', { stake: 200 }, T0 + 2);
    expect(await verifyAudit(log)).toEqual({ ok: true, count: 3 });
    const tampered = log.map((e) => (e.seq === 1 ? { ...e, data: { stake: 10000 } } : e));
    expect(await verifyAudit(tampered)).toMatchObject({ ok: false, brokenAt: 1 });
    expect(await verifyAudit(log.filter((e) => e.seq !== 1))).toMatchObject({ ok: false });
  });
});

describe('保存', () => {
  it('保存して読み戻せる', async () => {
    const kv = memoryKV();
    const s = await createInitialState(T0);
    expect(saveState(kv, s)).toBe(true);
    expect(loadState(kv)).toEqual(s);
  });
  it('壊れたデータは読み込まない', () => {
    const kv = memoryKV();
    kv.setItem('virtual-turf:v1', '{broken');
    expect(loadState(kv)).toBeNull();
  });
});
