/**
 * パリミュチュエル方式（投票プール方式）のオッズと払戻の計算（第11段階で JRA の決まりに合わせた）。
 *
 * 出典：JRA「馬券のルール」払戻金の計算方法【競馬法施行規則】 https://www.jra.go.jp/kouza/baken/
 *   的中した組合せごとの払戻対象総額 = (W + D/P) × R
 *     W：その組合せへの投票額、D：的中しなかった組合せへの投票額の合計（返還分は含めない）、
 *     P：的中した組合せの数、R：払戻率
 *   オッズ = 払戻対象総額 ÷ W。100コインあたり10コイン未満は切り捨て（0.1倍単位）、最低1.0倍（元返し）。
 *   的中が1つなら「プール総額 × R ÷ W」と同じ。発売中のオッズは的中が1つと想定した概算で、同着のときは違う率になる。
 * - 的中者がいないとき（特払い）：その券種に投票した全員に、払戻率 80% の券種は 100 につき 80、70%台の券種は 70 を払い戻す
 * - 出走取消・競走除外：その馬番を含む組合せは返還し、プールから除く（bettypes.ts の isRefunded）
 * JRAプラス10（元返しになるときの上乗せ）は扱わない。
 *
 * デモでは他の利用者の投票を「市場プール」として模擬する。市場の配分は推定確率に
 * 偏り（人気の偏り）と時間で変わるゆらぎを加えたもので、締切時点で固定される。
 */
import { BET_TYPES, type BetType, type BetTypeId, allKeys, hitCount, isRefunded, isSold, parseKey, placeCount, winningKeys } from './bettypes';
import type { Probabilities } from './probability';
import { Rng } from './rng';

export type Pools = Record<BetTypeId, Record<string, number>>;

export interface StakeLike {
  betType: BetTypeId;
  key: string;
  stake: number;
}

/**
 * 市場（他の利用者）の見立てのずれ（対数の標準偏差。推定）。組合せごとに決まり、発売中は変わらない。
 * 人気は実力（推定確率）におおむね沿うが、過大・過小に評価される馬がいる。
 */
export const MARKET_BIAS_SD = 0.3;

export const floorOdds = (x: number): number => Math.max(1, Math.floor(x * 10 + 1e-9) / 10);

export function emptyPools(): Pools {
  return Object.fromEntries(BET_TYPES.map((t) => [t.id, {}])) as unknown as Pools;
}

/**
 * 発売の進み具合 progress(0〜1) と時間の刻み tick における市場プール。
 * 乱数は raceId と tick から決まる公開情報で、結果決定用 seed とは無関係。
 */
export function marketPools(raceId: string, numbers: number[], probs: Probabilities, progress: number, tick: number): Pools {
  const pools = emptyPools();
  const p = Math.max(0.05, Math.min(1, progress));
  for (const t of BET_TYPES) {
    if (!isSold(t, numbers.length)) continue;
    const keys = allKeys(t, numbers);
    const bias = new Rng(`${raceId}:bias:${t.id}`);
    const wobble = new Rng(`${raceId}:tick:${t.id}:${tick}`);
    const wobbleSd = 0.3 * (1 - p) + 0.06;
    // どの組み合わせにも一定の票が入る（記念買い・応援買い）。平均シェアの5%を下限として上乗せ
    const hits = hitCount(t, numbers.length);
    const floor = (0.05 * hits) / keys.length;
    const weights = keys.map((k) => {
      const prob = (probs.byType[t.id][k] ?? 0) + floor;
      // 大穴が実際の確率より買われやすい傾向を、指数 0.92 で表現
      return Math.pow(prob, 0.92) * Math.exp(bias.normal(0, MARKET_BIAS_SD) + wobble.normal(0, wobbleSd));
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const size = t.marketSize * p;
    keys.forEach((k, i) => {
      pools[t.id][k] = Math.round((size * weights[i]) / total);
    });
  }
  return pools;
}

/** 市場プールに利用者の投票を加える */
export function withStakes(base: Pools, stakes: StakeLike[]): Pools {
  const pools = Object.fromEntries(BET_TYPES.map((t) => [t.id, { ...base[t.id] }])) as unknown as Pools;
  for (const s of stakes) pools[s.betType][s.key] = (pools[s.betType][s.key] ?? 0) + s.stake;
  return pools;
}

export function poolTotal(pools: Pools, type: BetTypeId): number {
  return Object.values(pools[type]).reduce((a, b) => a + b, 0);
}

/** 的中が1つと想定したオッズ（発売中の概算。単勝・枠連・馬連・馬単・3連複・3連単） */
export function standardOdds(type: BetType, pools: Pools, key: string, total = poolTotal(pools, type.id)): number | null {
  const stake = pools[type.id][key] ?? 0;
  if (stake <= 0) return null;
  return floorOdds((total * (1 - type.takeout)) / stake);
}

/**
 * 的中した組合せ（winners）それぞれの払戻オッズ：(W + D/P) × R ÷ W。
 * 的中した組合せのうち、投票のないものは P に数えない（その分は他の的中者に回る。簡略化）。
 */
export function payoutOddsFor(type: BetType, pools: Pools, winners: string[]): Record<string, number> {
  const R = 1 - type.takeout;
  const hit = winners.filter((k) => (pools[type.id][k] ?? 0) > 0);
  const W = hit.map((k) => pools[type.id][k]);
  const D = poolTotal(pools, type.id) - W.reduce((a, b) => a + b, 0);
  const res: Record<string, number> = {};
  hit.forEach((k, i) => {
    res[k] = floorOdds(((W[i] + D / hit.length) * R) / W[i]);
  });
  return res;
}

/** 複勝（以前の名前。payoutOddsFor と同じ） */
export const placeOddsFor = payoutOddsFor;

/** 複勝の確定前の想定オッズ幅（一緒に入る他馬が人気馬なら下限、人気薄なら上限） */
export function placeOddsRange(type: BetType, pools: Pools, key: string, fieldSize: number): [number, number] | null {
  if (!(pools[type.id][key] > 0)) return null;
  const others = Object.entries(pools[type.id])
    .filter(([k]) => k !== key)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const m = placeCount(fieldSize) - 1;
  const low = payoutOddsFor(type, pools, [key, ...others.slice(0, m)])[key];
  const high = payoutOddsFor(type, pools, [key, ...others.slice(-m)])[key];
  return [low, high];
}

/** ワイドの確定前の想定オッズ幅：3着以内のもう1頭が、一緒に買われている馬なら下限、買われていない馬なら上限 */
export function wideOddsRange(type: BetType, pools: Pools, key: string, numbers: number[]): [number, number] | null {
  const pool = pools[type.id];
  if (!(pool[key] > 0)) return null;
  const [a, b] = parseKey(key);
  const k2 = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  let lowC = -1;
  let highC = -1;
  let most = -1;
  let least = Infinity;
  for (const c of numbers) {
    if (c === a || c === b) continue;
    const s = (pool[k2(a, c)] ?? 0) + (pool[k2(b, c)] ?? 0);
    if (s > most) [most, lowC] = [s, c];
    if (s < least) [least, highC] = [s, c];
  }
  if (lowC < 0) return null;
  const of = (c: number) => payoutOddsFor(type, pools, [key, k2(a, c), k2(b, c)])[key];
  return [of(lowC), of(highC)];
}

export interface OddsBook {
  /** 券種 → キー → オッズ（複勝・ワイドは下限） */
  odds: Record<BetTypeId, Record<string, number | null>>;
  /** 複勝の想定オッズ幅 */
  placeRange: Record<string, [number, number] | null>;
  /** ワイドの想定オッズ幅 */
  wideRange: Record<string, [number, number] | null>;
  totals: Record<BetTypeId, number>;
}

export function buildOddsBook(pools: Pools, numbers: number[]): OddsBook {
  const odds = {} as OddsBook['odds'];
  const totals = {} as OddsBook['totals'];
  const placeRange: OddsBook['placeRange'] = {};
  const wideRange: OddsBook['wideRange'] = {};
  for (const t of BET_TYPES) {
    totals[t.id] = poolTotal(pools, t.id);
    odds[t.id] = {};
    if (!isSold(t, numbers.length)) continue;
    for (const k of allKeys(t, numbers)) {
      if (t.id === 'place') {
        const r = placeOddsRange(t, pools, k, numbers.length);
        placeRange[k] = r;
        odds[t.id][k] = r ? r[0] : null;
      } else if (t.id === 'wide') {
        const r = wideOddsRange(t, pools, k, numbers);
        wideRange[k] = r;
        odds[t.id][k] = r ? r[0] : null;
      } else {
        odds[t.id][k] = standardOdds(t, pools, k, totals[t.id]);
      }
    }
  }
  return { odds, placeRange, wideRange, totals };
}

/** その券種・キーの想定オッズ幅（複勝・ワイド。ほかの券種は null） */
export function rangeOf(book: OddsBook, type: BetTypeId, key: string): [number, number] | null {
  return type === 'place' ? (book.placeRange[key] ?? null) : type === 'wide' ? (book.wideRange?.[key] ?? null) : null;
}

/** 出走取消・競走除外の馬番を含む組合せ（返還になる分）をプールから除く */
export function withoutRefunded(pools: Pools, scratched: number[], fieldSize: number): Pools {
  if (!scratched.length) return pools;
  const out = emptyPools();
  for (const t of BET_TYPES) {
    for (const [k, v] of Object.entries(pools[t.id] ?? {})) if (!isRefunded(t, k, scratched, fieldSize)) out[t.id][k] = v;
  }
  return out;
}

export interface Settlement {
  /** 券種 → 的中キー → 払戻オッズ */
  odds: Record<BetTypeId, Record<string, number>>;
  /** 特払い（的中者がいない券種 → 払戻の率 0.8 または 0.7） */
  special: Partial<Record<BetTypeId, number>>;
}

/** 特払いの率：払戻率 80% の券種は 0.8、70%台の券種は 0.7（JRA 公式） */
export const specialRate = (type: BetType): number => (type.takeout <= 0.2 + 1e-9 ? 0.8 : 0.7);

/**
 * 確定着順に対する、券種ごとの的中キーと払戻オッズ・特払い。
 * pools は返還分を除いたもの。fieldSize は発売開始時の頭数（発売する券種・複勝の対象・枠番はこれで決まる）。
 */
export function settle(pools: Pools, order: number[], fieldSize: number, ranks?: number[]): Settlement {
  const odds = {} as Settlement['odds'];
  const special: Settlement['special'] = {};
  for (const t of BET_TYPES) {
    odds[t.id] = {};
    if (!isSold(t, fieldSize) || poolTotal(pools, t.id) <= 0) continue;
    odds[t.id] = payoutOddsFor(t, pools, winningKeys(t, order, fieldSize, ranks));
    if (Object.keys(odds[t.id]).length === 0) special[t.id] = specialRate(t);
  }
  return { odds, special };
}

/** 確定着順に対する払戻オッズだけ（同着・特払いを考えない呼び出し用） */
export function settleOdds(pools: Pools, order: number[], fieldSize: number, ranks?: number[]): Record<BetTypeId, Record<string, number>> {
  return settle(pools, order, fieldSize, ranks).odds;
}

/** 払戻額 = 賭け金 × オッズ（賭け金は100単位なので結果は整数） */
export function payout(stake: number, odds: number): number {
  return Math.round(stake * odds);
}

/** 人気順（その券種でのオッズが低い順）。表示用 */
export function popularity(book: OddsBook, type: BetTypeId): string[] {
  return Object.entries(book.odds[type])
    .filter(([, o]) => o !== null)
    .sort((a, b) => (a[1] as number) - (b[1] as number))
    .map(([k]) => k);
}
