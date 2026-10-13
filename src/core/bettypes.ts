/**
 * 券種の定義（登録の仕組み）。
 * 新しい券種（ワイド・3連複など）は BetType を1つ追加すれば、
 * 勝率推定・オッズ計算・払戻・画面に自動で反映される。
 */

export type BetTypeId = 'win' | 'place' | 'quinella' | 'exacta';

/**
 * standard: 的中キーが1つで、プール全体をその的中者で分ける
 * place:    的中キーが複数（複勝）。利益分を的中キーの数で等分してから各キーの的中者で分ける
 */
export type PoolKind = 'standard' | 'place';

export interface BetType {
  id: BetTypeId;
  label: string;
  /** 選ぶ馬の数 */
  picks: number;
  /** 着順どおりに当てる必要があるか */
  ordered: boolean;
  /** 控除率（デモ設定） */
  takeout: number;
  poolKind: PoolKind;
  /** 他の利用者の投票を模した市場プールの最終規模（デモコイン） */
  marketSize: number;
  description: string;
}

export const BET_TYPES: BetType[] = [
  {
    id: 'win',
    label: '単勝',
    picks: 1,
    ordered: false,
    takeout: 0.2,
    poolKind: 'standard',
    marketSize: 3_000_000,
    description: '1着になる馬を当てます。',
  },
  {
    id: 'place',
    label: '複勝',
    picks: 1,
    ordered: false,
    takeout: 0.2,
    poolKind: 'place',
    marketSize: 2_000_000,
    description: '3着以内に入る馬を当てます（出走7頭以下は2着以内）。払戻は確定まで幅で表示されます。',
  },
  {
    id: 'quinella',
    label: '馬連',
    picks: 2,
    ordered: false,
    takeout: 0.225,
    poolKind: 'standard',
    marketSize: 4_000_000,
    description: '1着・2着になる2頭を、着順を問わずに当てます。',
  },
  {
    id: 'exacta',
    label: '馬単',
    picks: 2,
    ordered: true,
    takeout: 0.25,
    poolKind: 'standard',
    marketSize: 3_000_000,
    description: '1着・2着になる2頭を、着順どおりに当てます。',
  },
];

export const BET_TYPE_BY_ID = Object.fromEntries(BET_TYPES.map((b) => [b.id, b])) as Record<BetTypeId, BetType>;

/** 選択した馬番の並びからプールのキーを作る */
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

/** 確定着順（馬番の並び）に対する的中キー */
export function winningKeys(type: BetType, order: number[], fieldSize: number): string[] {
  if (type.poolKind === 'place') {
    return order.slice(0, placeCount(fieldSize)).map((n) => String(n));
  }
  return [betKey(type, order.slice(0, type.picks))];
}

/** 出走馬の馬番から、その券種のすべての組み合わせキーを列挙する */
export function allKeys(type: BetType, numbers: number[]): string[] {
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
  rec([], [...numbers].sort((a, b) => a - b));
  return res;
}

export function validateSelection(type: BetType, selection: number[], numbers: number[]): string | null {
  if (selection.length !== type.picks) return `${type.label}は${type.picks}頭を選んでください。`;
  if (new Set(selection).size !== selection.length) return '同じ馬を重複して選ぶことはできません。';
  if (selection.some((n) => !numbers.includes(n))) return '出走していない馬番が含まれています。';
  return null;
}
