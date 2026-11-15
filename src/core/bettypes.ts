/**
 * 券種の定義（第11段階：JRA の8つの投票法）。
 *
 * 出典：JRA「馬券のルール」 https://www.jra.go.jp/kouza/baken/ （2026年11月に確認）
 * - 払戻率（平成26年6月7日以降）：単勝・複勝 80%、枠連・馬連・ワイド 77.5%、馬単・3連複 75%、3連単 72.5%
 * - 発売する投票法は、発売開始時の出走頭数で決まる（MIN_FIELD）。複勝は 5〜7頭なら2着まで、8頭以上なら3着まで
 * - 同着：1着同着は「いずれか1頭を1着、いずれか1頭を2着、いずれか1頭を3着」とみなす（2着・3着の同着も同じ考え方）。
 *   ワイドの3着どうし、3連複・3連単の3着どうしを含む組合せは的中にならない
 * - 返還：出走取消・競走除外の馬番を含む組合せは返還。枠連は、同じ枠に他の馬が残るかどうかで扱いが変わる
 */

export type BetTypeId = 'win' | 'place' | 'bracket' | 'quinella' | 'wide' | 'exacta' | 'trio' | 'trifecta';

/**
 * standard: 的中キーがふつう1つ（同着のときだけ複数）
 * place:    的中キーがふつう複数（複勝・ワイド）。確定まで払戻は幅で表示する
 */
export type PoolKind = 'standard' | 'place';

export interface BetType {
  id: BetTypeId;
  label: string;
  /** 選ぶ数（馬番。枠連は枠番） */
  picks: number;
  /** 着順どおりに当てる必要があるか */
  ordered: boolean;
  /** 選ぶのが枠番か（枠連） */
  frames?: boolean;
  /** 控除率 = 1 − 払戻率（JRA 公式） */
  takeout: number;
  poolKind: PoolKind;
  /** 発売する最小の出走頭数（JRA 公式の表） */
  minField: number;
  /** 他の利用者の投票を模した市場プールの最終規模（デモコイン。券種ごとの売上の割合は推定） */
  marketSize: number;
  description: string;
}

export const BET_TYPES: BetType[] = [
  { id: 'win', label: '単勝', picks: 1, ordered: false, takeout: 0.2, poolKind: 'standard', minField: 2, marketSize: 2_000_000, description: '1着になる馬を当てます。' },
  { id: 'place', label: '複勝', picks: 1, ordered: false, takeout: 0.2, poolKind: 'place', minField: 5, marketSize: 2_500_000, description: '3着以内に入る馬を当てます（出走7頭以下は2着以内）。払戻は確定まで幅で表示されます。' },
  { id: 'bracket', label: '枠連', picks: 2, ordered: false, frames: true, takeout: 0.225, poolKind: 'standard', minField: 9, marketSize: 1_000_000, description: '1着・2着になる馬の枠番の組合せを当てます（9頭以上で発売）。同じ枠の2頭で決まる組合せも選べます。' },
  { id: 'quinella', label: '馬連', picks: 2, ordered: false, takeout: 0.225, poolKind: 'standard', minField: 3, marketSize: 4_500_000, description: '1着・2着になる2頭を、着順を問わずに当てます。' },
  { id: 'wide', label: 'ワイド', picks: 2, ordered: false, takeout: 0.225, poolKind: 'place', minField: 4, marketSize: 2_500_000, description: '3着以内に入る2頭の組合せを当てます。的中は3通りあり、払戻は確定まで幅で表示されます。' },
  { id: 'exacta', label: '馬単', picks: 2, ordered: true, takeout: 0.25, poolKind: 'standard', minField: 3, marketSize: 2_000_000, description: '1着・2着になる2頭を、着順どおりに当てます。' },
  { id: 'trio', label: '3連複', picks: 3, ordered: false, takeout: 0.25, poolKind: 'standard', minField: 4, marketSize: 6_000_000, description: '1着・2着・3着になる3頭を、着順を問わずに当てます。' },
  { id: 'trifecta', label: '3連単', picks: 3, ordered: true, takeout: 0.275, poolKind: 'standard', minField: 4, marketSize: 10_000_000, description: '1着・2着・3着になる3頭を、着順どおりに当てます。' },
];

export const BET_TYPE_BY_ID = Object.fromEntries(BET_TYPES.map((b) => [b.id, b])) as Record<BetTypeId, BetType>;

/**
 * 馬番から枠番を求める（JRA の枠の決まり）。
 * 8頭以下は1枠1頭。9〜16頭は外の枠から2頭ずつ。17頭は8枠が3頭、18頭は7枠・8枠が3頭ずつ。
 */
export function frameOf(fieldSize: number, number: number): number {
  if (fieldSize <= 8) return number;
  if (fieldSize <= 16) {
    const singles = 16 - fieldSize;
    return number <= singles ? number : singles + Math.ceil((number - singles) / 2);
  }
  // 17頭：1〜7枠が2頭、8枠が3頭。18頭：1〜6枠が2頭、7・8枠が3頭
  const pairs = fieldSize === 17 ? 7 : 6;
  if (number <= pairs * 2) return Math.ceil(number / 2);
  return Math.min(8, pairs + Math.ceil((number - pairs * 2) / 3));
}

/** その頭数で発売するか（JRA 公式の表。発売開始時の頭数で決まり、あとで頭数が減っても変わらない） */
export function isSold(type: BetType, fieldSize: number): boolean {
  return fieldSize >= type.minField;
}

/** 選択した馬番（枠連は枠番）の並びからプールのキーを作る */
export function betKey(type: BetType, selection: number[]): string {
  const sel = type.ordered ? selection : [...selection].sort((a, b) => a - b);
  return sel.join(type.ordered ? '>' : '-');
}

export function parseKey(key: string): number[] {
  return key.split(/[->]/).map(Number);
}

/** 複勝の対象となる着順の数 */
export function placeCount(fieldSize: number): number {
  return fieldSize <= 7 ? 2 : 3;
}

/** ふつう（同着なし）の的中キーの数 */
export function hitCount(type: BetType, fieldSize: number): number {
  return type.id === 'place' ? placeCount(fieldSize) : type.id === 'wide' ? 3 : 1;
}

/**
 * 同着を「いずれか1頭を上の着順とみなす」ことで起こりうる、上位 depth 頭の並びをすべて挙げる。
 * ranks は order と同じ並びの着順（同着は同じ数。例：1,1,3）。ないときは同着なし。
 */
export function resolvedTops(order: number[], ranks: number[] | undefined, depth: number): number[][] {
  if (!ranks) return [order.slice(0, depth)];
  const out: number[][] = [];
  const rec = (prefix: number[], from: number) => {
    if (prefix.length >= depth || from >= order.length) {
      out.push(prefix.slice(0, depth));
      return;
    }
    // 同じ着順の馬のかたまり
    let to = from;
    while (to < order.length && ranks[to] === ranks[from]) to++;
    const group = order.slice(from, to);
    const need = Math.min(group.length, depth - prefix.length);
    const perm = (cur: number[], rest: number[]) => {
      if (cur.length === need) {
        rec([...prefix, ...cur], to);
        return;
      }
      rest.forEach((n, i) => perm([...cur, n], rest.filter((_, j) => j !== i)));
    };
    perm([], group);
  };
  rec([], 0);
  return out;
}

/** 確定着順（馬番の並び。ranks は同着のあるときの着順）に対する的中キー */
export function winningKeys(type: BetType, order: number[], fieldSize: number, ranks?: number[]): string[] {
  const keys = new Set<string>();
  const add = (sel: number[]) => {
    if (sel.length === type.picks) keys.add(betKey(type, sel));
  };
  if (type.id === 'place') {
    for (const top of resolvedTops(order, ranks, placeCount(fieldSize))) top.forEach((n) => add([n]));
  } else if (type.id === 'wide') {
    for (const [a, b, c] of resolvedTops(order, ranks, 3)) {
      if (b === undefined) continue;
      add([a, b]);
      if (c !== undefined) {
        add([a, c]);
        add([b, c]);
      }
    }
  } else if (type.frames) {
    for (const top of resolvedTops(order, ranks, 2)) add(top.map((n) => frameOf(fieldSize, n)));
  } else {
    for (const top of resolvedTops(order, ranks, type.picks)) add(top);
  }
  return [...keys];
}

/** 出走馬の馬番から、その券種のすべての組み合わせキーを列挙する（枠連は、2頭以上いる枠だけ同じ枠どうしを含む） */
export function allKeys(type: BetType, numbers: number[]): string[] {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (type.frames) {
    const count = new Map<number, number>();
    for (const n of sorted) {
      const f = frameOf(sorted.length, n);
      count.set(f, (count.get(f) ?? 0) + 1);
    }
    const frames = [...count.keys()].sort((a, b) => a - b);
    const res: string[] = [];
    frames.forEach((a, i) => {
      if (count.get(a)! >= 2) res.push(`${a}-${a}`);
      for (const b of frames.slice(i + 1)) res.push(`${a}-${b}`);
    });
    return res;
  }
  const res: string[] = [];
  const rec = (prefix: number[], rest: number[]) => {
    if (prefix.length === type.picks) {
      res.push(betKey(type, prefix));
      return;
    }
    rest.forEach((n, i) => {
      const next = type.ordered ? rest.filter((_, j) => j !== i) : rest.slice(i + 1);
      rec([...prefix, n], next);
    });
  };
  rec([], sorted);
  return res;
}

export function validateSelection(type: BetType, selection: number[], numbers: number[]): string | null {
  if (!isSold(type, numbers.length)) return `${type.label}は、出走${type.minField}頭以上のレースで発売します。`;
  if (type.frames) {
    if (selection.length !== type.picks) return `${type.label}は枠を${type.picks}つ選んでください（同じ枠の2頭なら、その枠を2回）。`;
    if (!allKeys(type, numbers).includes(betKey(type, selection))) {
      return selection[0] === selection[1] ? 'その枠には1頭しかいないため、同じ枠どうしの組合せは選べません。' : '出走していない枠番が含まれています。';
    }
    return null;
  }
  if (selection.length !== type.picks) return `${type.label}は${type.picks}頭を選んでください。`;
  if (new Set(selection).size !== selection.length) return '同じ馬を重複して選ぶことはできません。';
  if (selection.some((n) => !numbers.includes(n))) return '出走していない馬番が含まれています。';
  return null;
}

/**
 * 出走取消・競走除外になった馬番（scratched）があるとき、そのキーが返還になるか（JRA 公式の返還の決まり）。
 * - 馬番で買う券種：出走しない馬番を含む組合せはすべて返還
 * - 枠連：出走しない馬の枠に他の馬がいなければ、その枠との組合せは返還。他の馬が1頭なら同じ枠どうし（ゾロ目）だけ返還。2頭以上なら返還なし
 */
export function isRefunded(type: BetType, key: string, scratched: number[], fieldSize: number): boolean {
  if (!scratched.length) return false;
  const sel = parseKey(key);
  if (!type.frames) return sel.some((n) => scratched.includes(n));
  for (const f of new Set(scratched.map((n) => frameOf(fieldSize, n)))) {
    let left = 0;
    for (let n = 1; n <= fieldSize; n++) if (frameOf(fieldSize, n) === f && !scratched.includes(n)) left++;
    if (left === 0 && sel.includes(f)) return true;
    if (left === 1 && sel[0] === f && sel[1] === f) return true;
  }
  return false;
}
