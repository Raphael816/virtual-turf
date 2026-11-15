import { beforeAll, describe, expect, it } from 'vitest';
import { BET_TYPES, BET_TYPE_BY_ID as T, allKeys, frameOf, isRefunded, isSold, resolvedTops, validateSelection, winningKeys } from '../src/core/bettypes';
import { type RaceCard, createMeeting, runRace } from '../src/core/meeting';
import { type Pools, buildOddsBook, emptyPools, marketPools, payout, payoutOddsFor, poolTotal, rangeOf, settle, specialRate, withoutRefunded } from '../src/core/pool';
import { type Probabilities, comboProbabilities, estimateProbabilities } from '../src/core/probability';
import { DEAD_HEAT_EPS, activeCard, advance, closeRace, openMeeting, ranksOf, scratchOf } from '../src/core/raceflow';
import { createInitialState, placeBet, refundScratched, settleRace } from '../src/core/state';
import { verifyAudit } from '../src/core/audit';
import { createWorld } from '../src/core/world';

const T0 = new Date(2026, 9, 13, 12, 0, 0).getTime();
const pools = (partial: Partial<Pools>): Pools => ({ ...emptyPools(), ...partial });
const sorted = (xs: string[]) => [...xs].sort();

let cards: RaceCard[];
let card: RaceCard;
let probs: Probabilities;
beforeAll(async () => {
  let i = 0;
  cards = await createMeeting('jra-bet', () => `s${i++}`, createWorld());
  card = cards.find((c) => c.entries.length >= 12)!;
  probs = estimateProbabilities(card, 60);
}, 120000);

describe('JRA の8つの投票法', () => {
  it('払戻率は JRA と同じ（単複 80%、枠連・馬連・ワイド 77.5%、馬単・3連複 75%、3連単 72.5%）', () => {
    const rate = Object.fromEntries(BET_TYPES.map((t) => [t.id, Math.round((1 - t.takeout) * 1000) / 10]));
    expect(rate).toEqual({ win: 80, place: 80, bracket: 77.5, quinella: 77.5, wide: 77.5, exacta: 75, trio: 75, trifecta: 72.5 });
  });
  it('発売する券種は出走頭数で決まる（JRA の表）', () => {
    const sold = (n: number) => BET_TYPES.filter((t) => isSold(t, n)).map((t) => t.id);
    expect(sold(2)).toEqual(['win']);
    expect(sold(3)).toEqual(['win', 'quinella', 'exacta']);
    expect(sold(4)).toEqual(['win', 'quinella', 'wide', 'exacta', 'trio', 'trifecta']);
    expect(sold(5)).toEqual(['win', 'place', 'quinella', 'wide', 'exacta', 'trio', 'trifecta']);
    expect(sold(8)).toEqual(sold(5));
    expect(sold(9)).toHaveLength(8);
  });
  it('組合せの数', () => {
    const nums = Array.from({ length: 18 }, (_, i) => i + 1);
    expect(allKeys(T.wide, nums)).toHaveLength(153);
    expect(allKeys(T.trio, nums)).toHaveLength(816);
    expect(allKeys(T.trifecta, nums)).toHaveLength(4896);
    // 18頭：8枠すべてに2頭以上 → 28組 + 同じ枠どうし 8組
    expect(allKeys(T.bracket, nums)).toHaveLength(36);
    // 10頭：1〜6枠は1頭、7・8枠は2頭 → 28組 + 2組
    const ten = nums.slice(0, 10);
    expect(allKeys(T.bracket, ten)).toHaveLength(30);
    expect(allKeys(T.bracket, ten)).toContain('7-7');
    expect(allKeys(T.bracket, ten)).not.toContain('1-1');
  });
  it('枠連：選択は枠番。1頭しかいない枠どうしは選べない', () => {
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(validateSelection(T.bracket, [8, 8], ten)).toBeNull();
    expect(validateSelection(T.bracket, [3, 8], ten)).toBeNull();
    expect(validateSelection(T.bracket, [1, 1], ten)).toMatch('1頭しか');
    expect(validateSelection(T.bracket, [1], ten)).toMatch('枠');
    expect(validateSelection(T.bracket, [1, 2], [1, 2, 3, 4, 5, 6, 7, 8])).toMatch('9頭以上');
    expect(validateSelection(T.trifecta, [1, 2, 3], ten)).toBeNull();
    expect(validateSelection(T.trio, [1, 2], ten)).toMatch('3頭');
  });
  it('的中（同着なし）', () => {
    const order = [5, 2, 9, 1, 3, 4, 6, 7, 8, 10];
    expect(winningKeys(T.wide, order, 10)).toEqual(['2-5', '5-9', '2-9']);
    expect(winningKeys(T.trio, order, 10)).toEqual(['2-5-9']);
    expect(winningKeys(T.trifecta, order, 10)).toEqual(['5>2>9']);
    // 10頭：5番は5枠、2番は2枠
    expect(winningKeys(T.bracket, order, 10)).toEqual(['2-5']);
    // 9番・10番は同じ8枠
    expect(frameOf(10, 9)).toBe(8);
    expect(winningKeys(T.bracket, [9, 10, 1], 10)).toEqual(['8-8']);
  });
});

describe('同着（JRA の決まり）', () => {
  const o = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  it('1着同着：どちらも単勝的中。馬連は1通り、馬単は2通り', () => {
    const r = [1, 1, 3, 4, 5, 6, 7, 8, 9];
    expect(sorted(winningKeys(T.win, o, 9, r))).toEqual(['1', '2']);
    expect(winningKeys(T.quinella, o, 9, r)).toEqual(['1-2']);
    expect(sorted(winningKeys(T.exacta, o, 9, r))).toEqual(['1>2', '2>1']);
    expect(winningKeys(T.trio, o, 9, r)).toEqual(['1-2-3']);
    expect(sorted(winningKeys(T.trifecta, o, 9, r))).toEqual(['1>2>3', '2>1>3']);
    expect(sorted(winningKeys(T.place, o, 9, r))).toEqual(['1', '2', '3']);
  });
  it('2着同着：馬連・馬単は2通り、3連単は2通り、3連複は1通り', () => {
    const r = [1, 2, 2, 4, 5, 6, 7, 8, 9];
    expect(winningKeys(T.win, o, 9, r)).toEqual(['1']);
    expect(sorted(winningKeys(T.quinella, o, 9, r))).toEqual(['1-2', '1-3']);
    expect(sorted(winningKeys(T.exacta, o, 9, r))).toEqual(['1>2', '1>3']);
    expect(winningKeys(T.trio, o, 9, r)).toEqual(['1-2-3']);
    expect(sorted(winningKeys(T.trifecta, o, 9, r))).toEqual(['1>2>3', '1>3>2']);
    expect(sorted(winningKeys(T.wide, o, 9, r))).toEqual(['1-2', '1-3', '2-3']);
  });
  it('3着同着：複勝は4頭が的中。ワイドの3着どうし、3連複・3連単の3着どうしを含む組合せは的中にならない', () => {
    const r = [1, 2, 3, 3, 5, 6, 7, 8, 9];
    expect(sorted(winningKeys(T.place, o, 9, r))).toEqual(['1', '2', '3', '4']);
    expect(sorted(winningKeys(T.wide, o, 9, r))).toEqual(['1-2', '1-3', '1-4', '2-3', '2-4']);
    expect(winningKeys(T.wide, o, 9, r)).not.toContain('3-4');
    expect(sorted(winningKeys(T.trio, o, 9, r))).toEqual(['1-2-3', '1-2-4']);
    expect(sorted(winningKeys(T.trifecta, o, 9, r))).toEqual(['1>2>3', '1>2>4']);
    expect(winningKeys(T.quinella, o, 9, r)).toEqual(['1-2']);
  });
  it('2着が3頭同着：2着・3着とみなす2頭の組もワイドの的中になる', () => {
    const r = [1, 2, 2, 2, 5, 6, 7, 8, 9];
    expect(sorted(winningKeys(T.wide, o, 9, r))).toEqual(['1-2', '1-3', '1-4', '2-3', '2-4', '3-4']);
    expect(resolvedTops(o, r, 3)).toHaveLength(6);
  });
  it('着順の判定：ゴールの時間差が判定の幅より小さければ同着', () => {
    expect(ranksOf([2, 0, 1], [100.2, 100.5, 100])).toEqual([1, 2, 3]);
    expect(ranksOf([2, 0, 1], [100 + DEAD_HEAT_EPS / 2, 100.5, 100])).toEqual([1, 1, 3]);
    expect(ranksOf([2, 0, 1], [100.4, 100.4 + DEAD_HEAT_EPS / 2, 100])).toEqual([1, 2, 2]);
  });
  it('同着の払戻：(W + D/P) × R ÷ W。的中が増える分、締切時点のオッズより小さくなる', () => {
    const p = pools({ win: { '1': 200, '2': 300, '3': 500 } });
    // 的中が1つ：1000 × 0.8 ÷ 200 = 4.0
    expect(payoutOddsFor(T.win, p, ['1'])).toEqual({ '1': 4 });
    // 1着同着（1番と2番）：D = 500、P = 2。1番 (200+250)×0.8÷200 = 1.8、2番 (300+250)×0.8÷300 = 1.46 → 1.4
    expect(payoutOddsFor(T.win, p, ['1', '2'])).toEqual({ '1': 1.8, '2': 1.4 });
    const st = settle(p, [1, 2, 3], 3, [1, 1, 3]);
    expect(st.odds.win).toEqual({ '1': 1.8, '2': 1.4 });
  });
});

describe('返還（出走取消・競走除外）と特払い', () => {
  it('馬番で買う券種：出走しない馬番を含む組合せはすべて返還', () => {
    expect(isRefunded(T.win, '3', [3], 12)).toBe(true);
    expect(isRefunded(T.win, '4', [3], 12)).toBe(false);
    expect(isRefunded(T.wide, '3-9', [3], 12)).toBe(true);
    expect(isRefunded(T.trifecta, '1>2>3', [3], 12)).toBe(true);
    expect(isRefunded(T.trifecta, '1>2>4', [3], 12)).toBe(false);
  });
  it('枠連：同じ枠に他の馬がいない → その枠との組合せを返還。1頭いる → 同じ枠どうしだけ返還。2頭いる → 返還なし', () => {
    // 12頭：1〜4枠は1頭、5〜8枠は2頭（5枠 = 5・6番）
    expect(frameOf(12, 5)).toBe(5);
    expect(frameOf(12, 6)).toBe(5);
    // 例1：1枠は1番だけ
    expect(isRefunded(T.bracket, '1-5', [1], 12)).toBe(true);
    expect(isRefunded(T.bracket, '2-5', [1], 12)).toBe(false);
    // 例2：5枠の5番が出走しない（6番が残る）
    expect(isRefunded(T.bracket, '5-5', [5], 12)).toBe(true);
    expect(isRefunded(T.bracket, '1-5', [5], 12)).toBe(false);
    // 例3：18頭の8枠は3頭（16・17・18番）
    expect(frameOf(18, 16)).toBe(8);
    expect(isRefunded(T.bracket, '8-8', [16], 18)).toBe(false);
    expect(isRefunded(T.bracket, '1-8', [16], 18)).toBe(false);
  });
  it('返還分はプールから除く。券は全額を返還し、ほかの券はそのまま', async () => {
    const p = pools({ win: { '1': 100, '2': 200, '3': 300 }, quinella: { '1-2': 50, '1-3': 60, '2-3': 70 } });
    const w = withoutRefunded(p, [3], 12);
    expect(w.win).toEqual({ '1': 100, '2': 200 });
    expect(w.quinella).toEqual({ '1-2': 50 });
    let s = await createInitialState(T0);
    const numbers = Array.from({ length: 12 }, (_, i) => i + 1);
    const book = buildOddsBook(marketPools('r', numbers, probsFor(numbers), 1, 0), numbers);
    for (const [betType, selection] of [['win', [3]], ['win', [4]], ['trio', [1, 2, 3]], ['bracket', [3, 5]]] as const) {
      const r = await placeBet(s, { raceId: 'r', betType, selection: [...selection], stake: 200 }, numbers, book, T0, true);
      if (!r.ok) throw new Error(r.message);
      s = r.state;
    }
    const before = s.balance;
    s = await refundScratched(s, 'r', [3], 12, T0 + 1);
    expect(s.balance).toBe(before + 600);
    expect(s.tickets.map((t) => t.status)).toEqual(['refunded', 'open', 'refunded', 'refunded']);
    expect((await verifyAudit(s.audit)).ok).toBe(true);
  });
  it('特払い：的中者がいない券種は、単勝・複勝 80%、ほかは 70% を全員に払い戻す', async () => {
    expect(specialRate(T.win)).toBe(0.8);
    expect(specialRate(T.place)).toBe(0.8);
    expect(specialRate(T.quinella)).toBe(0.7);
    expect(specialRate(T.trifecta)).toBe(0.7);
    const p = pools({ win: { '1': 500, '2': 500 }, trifecta: { '1>2>3': 300, '2>1>3': 700 } });
    const st = settle(p, [3, 1, 2, 4], 4);
    expect(st.special).toEqual({ win: 0.8, trifecta: 0.7 });
    expect(st.odds.win).toEqual({});
    let s = await createInitialState(T0);
    const numbers = [1, 2, 3, 4];
    const book = buildOddsBook(p, numbers);
    const r = await placeBet(s, { raceId: 'r', betType: 'trifecta', selection: [1, 2, 3], stake: 300 }, numbers, book, T0, true);
    if (!r.ok) throw new Error(r.message);
    s = await settleRace(r.state, 'r', st.odds, T0 + 1, st.special);
    expect(s.tickets[0]).toMatchObject({ status: 'special', payout: 210 });
    expect(s.balance).toBe(r.state.balance + 210);
  });
});

function probsFor(numbers: number[]): Probabilities {
  const win = Object.fromEntries(numbers.map((n) => [String(n), 1 / numbers.length]));
  const byType = { win, place: Object.fromEntries(numbers.map((n) => [String(n), 3 / numbers.length])), ...comboProbabilities(win, numbers) } as Probabilities['byType'];
  return { trials: 0, byType };
}

describe('確率とオッズ（8券種）', () => {
  it('確率の合計：ワイドは3、それ以外の組合せの券種は1', () => {
    const sum = (t: keyof Probabilities['byType']) => Object.values(probs.byType[t]).reduce((a, b) => a + b, 0);
    for (const t of ['win', 'bracket', 'quinella', 'exacta', 'trio', 'trifecta'] as const) expect(sum(t)).toBeCloseTo(1, 4);
    expect(sum('wide')).toBeCloseTo(3, 4);
    expect(sum('place')).toBeCloseTo(3, 4);
    for (const t of BET_TYPES) expect(Object.keys(probs.byType[t.id])).toEqual(allKeys(t, card.entries.map((e) => e.number)));
  });
  it('組合せの確率は、強い馬どうしの組ほど高い。2着・3着は1着ほど実力どおりにならない', () => {
    const win = { '1': 0.5, '2': 0.3, '3': 0.15, '4': 0.05 };
    const c = comboProbabilities(win, [1, 2, 3, 4]);
    expect(c.quinella['1-2']).toBeGreaterThan(c.quinella['1-3']);
    expect(c.quinella['1-3']).toBeGreaterThan(c.quinella['3-4']);
    expect(c.exacta['1>2']).toBeGreaterThan(c.exacta['2>1']);
    expect(c.trifecta['1>2>3']).toBeGreaterThan(c.trifecta['3>2>1']);
    // 補正のない式（ハービル）なら 1>2 は 0.5 × 0.3/0.5 = 0.30。補正により、人気薄が2着に来る分だけ小さい
    expect(c.exacta['1>2']).toBeLessThan(0.3);
    expect(c.exacta['1>4']).toBeGreaterThan(0.5 * (0.05 / 0.5));
  });
  it('すべての組合せにオッズが付き、ワイドは幅（下限 ≤ 上限）で表示する', () => {
    const numbers = card.entries.map((e) => e.number);
    const book = buildOddsBook(marketPools(card.id, numbers, probs, 1, 0), numbers);
    for (const t of BET_TYPES) {
      const keys = allKeys(t, numbers);
      expect(Object.keys(book.odds[t.id])).toHaveLength(keys.length);
      for (const k of keys) expect(book.odds[t.id][k]).toBeGreaterThanOrEqual(1);
    }
    for (const k of allKeys(T.wide, numbers)) {
      const r = rangeOf(book, 'wide', k)!;
      expect(r[0]).toBeLessThanOrEqual(r[1]);
    }
    expect(rangeOf(book, 'trio', '1-2-3')).toBeNull();
  });
  it('オッズは投票で変わる：ある組合せに投票が集まると、そのオッズが下がり、ほかは上がる', () => {
    const numbers = card.entries.map((e) => e.number);
    const base = marketPools(card.id, numbers, probs, 1, 0);
    const more = { ...base, trio: { ...base.trio, '1-2-3': base.trio['1-2-3'] * 3 } };
    const a = buildOddsBook(base, numbers).odds.trio;
    const b = buildOddsBook(more, numbers).odds.trio;
    expect(b['1-2-3']!).toBeLessThan(a['1-2-3']!);
    expect(b['4-5-6']!).toBeGreaterThanOrEqual(a['4-5-6']!);
  });
  it('払戻の合計は、どの券種でもプール総額 × 払戻率を超えず、ほぼ一致する', () => {
    const numbers = card.entries.map((e) => e.number);
    const p = marketPools(card.id, numbers, probs, 1, 0);
    for (const seed of ['a', 'b', 'c']) {
      const order = runRace(card, seed, { record: false }).order.map((i) => card.entries[i].number);
      const st = settle(p, order, numbers.length);
      for (const t of BET_TYPES) {
        const paid = Object.entries(st.odds[t.id]).reduce((a, [k, o]) => a + p[t.id][k] * o, 0);
        const net = poolTotal(p, t.id) * (1 - t.takeout);
        expect(paid).toBeLessThanOrEqual(net + 1);
        // 0.1倍単位の切り捨てと元返しの分だけ小さくなる
        expect(paid).toBeGreaterThan(net * 0.85);
      }
    }
  });
});

describe('レースの流れ（出走取消・保存容量）', () => {
  it('出走取消は seed から決まり、起こるのはまれ。取消の馬を除いた出走表で走る', () => {
    let hit = 0;
    let found: { c: RaceCard; sc: number[] } | undefined;
    for (let i = 0; i < 2000; i++) {
      const c = { ...card, seed: `sc${i}` };
      const sc = scratchOf(c);
      expect(scratchOf(c)).toEqual(sc);
      if (sc.length) {
        hit++;
        found ??= { c, sc };
      }
    }
    // 1頭あたり 0.3% × 頭数
    const expected = 2000 * card.entries.length * 0.003;
    expect(hit).toBeGreaterThan(expected * 0.5);
    expect(hit).toBeLessThan(expected * 1.7);
    const run = activeCard(found!.c, found!.sc);
    expect(run.entries).toHaveLength(card.entries.length - 1);
    expect(run.entries.some((e) => e.number === found!.sc[0])).toBe(false);
    const res = runRace(run, found!.c.seed, { record: false });
    expect(res.order).toHaveLength(card.entries.length - 1);
    expect(activeCard(card, undefined)).toBe(card);
  });
  it('出走取消のあるレース：締切で返還し、確定で残りの券を精算する。戦績に取消の馬は記録されない', async () => {
    // 出走取消が起こる seed を探して、その開催を進める
    let k = 0;
    let found: RaceCard[] | undefined;
    for (let m = 0; m < 400 && !found; m++) {
      const cs = await createMeeting(`sc-meet-${m}`, () => `q${k++}`, createWorld());
      if (scratchOf(cs[0]).length) found = cs;
    }
    expect(found).toBeDefined();
    const c0 = found![0];
    const sc = scratchOf(c0)[0];
    const other = c0.entries.find((e) => e.number !== sc)!.number;
    let s = await createInitialState(T0);
    s = { ...s, world: createWorld() };
    s = await openMeeting(s, c0.meetingId, found!, T0);
    const numbers = c0.entries.map((e) => e.number);
    const p0 = estimateProbabilities(c0, 20);
    const book = buildOddsBook(marketPools(c0.id, numbers, p0, 1, 0), numbers);
    for (const sel of [[sc], [other]]) {
      const r = await placeBet(s, { raceId: c0.id, betType: 'win', selection: sel, stake: 500 }, numbers, book, T0 + 1000, true);
      if (!r.ok) throw new Error(r.message);
      s = r.state;
    }
    const afterBets = s.balance;
    s = await closeRace(s, c0.id, p0, T0 + 2000);
    const rt = s.meeting!.runtime[c0.id];
    expect(rt.scratched).toEqual([sc]);
    expect(rt.finalPools!.win[String(sc)]).toBeUndefined();
    expect(s.balance).toBe(afterBets + 500);
    expect(s.tickets.map((t) => t.status)).toEqual(['refunded', 'open']);
    s = await advance(s, rt.endsAt! + 1000, () => p0);
    const done = s.meeting!.runtime[c0.id];
    expect(done.order).toHaveLength(numbers.length - 1);
    expect(done.order).not.toContain(sc);
    expect(s.tickets[1].status).not.toBe('open');
    // 確定後は 3連複・3連単のプールを保存しない
    expect(Object.keys(done.finalPools!.trifecta)).toHaveLength(0);
    expect(Object.keys(done.finalPools!.win).length).toBeGreaterThan(0);
    expect(Object.keys(done.payoutOdds!.trifecta)).toHaveLength(1);
    const scratchedHorse = c0.entries.find((e) => e.number === sc)!.horseId;
    expect(s.world!.horses.find((h) => h.id === scratchedHorse)!.history.some((r) => r.r === c0.id)).toBe(false);
    expect((await verifyAudit(s.audit)).ok).toBe(true);
    expect(payout(100, done.payoutOdds!.win[String(done.order![0])])).toBeGreaterThanOrEqual(100);
  }, 120000);
});
