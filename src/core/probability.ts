/**
 * モンテカルロ法による的中確率の推定。
 *
 * 公開シード `mc:<i>` でシミュレーションを繰り返すため、結果決定用の秘密 seed は一切使わない。
 * つまりオッズから実際の結果が漏れることはない（docs/02-architecture.md §4.3）。
 *
 * 単勝・複勝は、繰り返しの中で起きた回数から求める。
 * 2頭・3頭の組合せ（枠連・馬連・ワイド・馬単・3連複・3連単）は、組合せの数が多く（18頭の3連単で 4,896通り）、
 * 数百回の繰り返しでは回数を数えられないので、単勝の確率から順位の確率を作る（第11段階。推定）：
 *   1着 i・2着 j・3着 k の確率 = p_i × q_j/(1−q_i) × r_k/(1−r_i−r_j)
 *   q は p の 0.88乗、r は p の 0.8乗を合計1にしたもの。2着・3着は1着より実力どおりに決まりにくい、
 *   という競馬の統計でよく知られた傾向（ハービルの式の補正）を、指数で表す。指数の値は推定
 */
import { BET_TYPES, BET_TYPE_BY_ID, type BetTypeId, allKeys, betKey, frameOf, isSold, placeCount } from './bettypes';
import { type RaceCard, runRace } from './meeting';

export interface Probabilities {
  trials: number;
  /** 券種ごと・キーごとの的中確率（スムージング済み、合計は的中キー数におおよそ一致） */
  byType: Record<BetTypeId, Record<string, number>>;
}

/** 単勝の確率（馬番 → 確率）から、組合せの券種の確率を作る */
export function comboProbabilities(win: Record<string, number>, numbers: number[]): Pick<Probabilities['byType'], 'bracket' | 'quinella' | 'wide' | 'exacta' | 'trio' | 'trifecta'> {
  const n = numbers.length;
  const p = numbers.map((x) => win[String(x)] ?? 0);
  const norm = (xs: number[]) => {
    const s = xs.reduce((a, b) => a + b, 0) || 1;
    return xs.map((x) => x / s);
  };
  const q = norm(p.map((x) => x ** 0.88));
  const r = norm(p.map((x) => x ** 0.8));
  const out = { bracket: {}, quinella: {}, wide: {}, exacta: {}, trio: {}, trifecta: {} } as ReturnType<typeof comboProbabilities>;
  const add = (o: Record<string, number>, k: string, v: number) => (o[k] = (o[k] ?? 0) + v);
  const T = BET_TYPE_BY_ID;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pij = (p[i] * q[j]) / (1 - q[i]);
      const a = numbers[i];
      const b = numbers[j];
      add(out.exacta, betKey(T.exacta, [a, b]), pij);
      add(out.quinella, betKey(T.quinella, [a, b]), pij);
      if (isSold(T.bracket, n)) add(out.bracket, betKey(T.bracket, [frameOf(n, a), frameOf(n, b)]), pij);
      if (n < 3) continue;
      const rest = 1 - r[i] - r[j];
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pijk = (pij * r[k]) / rest;
        const c = numbers[k];
        add(out.trifecta, betKey(T.trifecta, [a, b, c]), pijk);
        add(out.trio, betKey(T.trio, [a, b, c]), pijk);
        // ワイド：3着以内の2頭の組（1通りの着順につき3組）
        add(out.wide, betKey(T.wide, [a, b]), pijk);
        add(out.wide, betKey(T.wide, [a, c]), pijk);
        add(out.wide, betKey(T.wide, [b, c]), pijk);
      }
    }
  }
  return out;
}

export function estimateProbabilities(
  card: Pick<RaceCard, 'id' | 'conditions' | 'entries'>,
  trials = 300,
): Probabilities {
  const numbers = card.entries.map((e) => e.number);
  const n = numbers.length;
  const win: Record<string, number> = {};
  const place: Record<string, number> = {};
  const places = placeCount(n);
  for (let i = 0; i < trials; i++) {
    const res = runRace(card, `mc:${i}`, { record: false, dt: 0.2 });
    const order = res.order.map((idx) => card.entries[idx].number);
    win[order[0]] = (win[order[0]] ?? 0) + 1;
    for (const x of order.slice(0, places)) place[x] = (place[x] ?? 0) + 1;
  }
  // 一度も起きなかった馬にも小さな確率を残す（加法スムージング）
  const alpha = 0.5;
  const smooth = (counts: Record<string, number>, hits: number) =>
    Object.fromEntries(numbers.map((x) => [String(x), (((counts[x] ?? 0) + alpha) / (trials * hits + alpha * n)) * hits]));
  const winP = smooth(win, 1);
  const combos = comboProbabilities(winP, numbers);
  const byType = { win: winP, place: smooth(place, places), ...combos } as Probabilities['byType'];
  // 発売しない券種は空にし、キーの並びを allKeys にそろえる
  for (const t of BET_TYPES) {
    if (!isSold(t, n)) byType[t.id] = {};
    else byType[t.id] = Object.fromEntries(allKeys(t, numbers).map((k) => [k, byType[t.id][k] ?? 0]));
  }
  return { trials, byType };
}
