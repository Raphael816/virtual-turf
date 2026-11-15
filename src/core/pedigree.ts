/**
 * 血統と繁殖（第12段階）。
 *
 * - 種牡馬（父）・母・母父と、父の系統（血統背景）を、すべての馬に持たせる。名前・系統はすべて架空
 * - 遺伝するもの：スピード・スタミナ・瞬発力・パワー・気性・距離適性・芝ダート適性・成長型
 * - 繁殖：両親の平均をそのまま子に渡さない。親が子に伝える値（遺伝的な値）は、親自身の能力を平均へ半分戻したもの。
 *   子の能力 = 世代の平均 ＋ 両親の遺伝的な値の中間 ＋ 個体差（きょうだいでも違う分と、育ちの分）
 *   個体差のほうがずっと大きいので、血統だけでは能力は決まらない（docs/17-pedigree.md に割合を記載）
 * - 世代の平均は一定に保つ（よい種牡馬に産駒が集まっても、世代全体の能力が年々上がらないようにする。較正のための簡略化）
 *
 * 数値はすべて推定。競走能力の遺伝率は研究によって 0.1〜0.4 程度とされる（筆者の知識による目安）。
 */
import type { Grade, Horse } from '../data/roster';
import type { GrowthType } from './ability';
import { Rng } from './rng';

export type LineId = 'solaris' | 'granvert' | 'tempest' | 'iron' | 'mistral' | 'aurora';

/** 遺伝的な値（能力は能力値の目盛り、距離は m、芝ダートは −1 芝〜＋1 ダート、成長は −1 早熟〜＋1 晩成） */
export interface Genes {
  speed: number;
  stamina: number;
  accel: number;
  power: number;
  temper: number;
  distance: number;
  surface: number;
  growth: number;
}
export const GENE_KEYS = ['speed', 'stamina', 'accel', 'power', 'temper', 'distance', 'surface', 'growth'] as const;
export type GeneKey = (typeof GENE_KEYS)[number];

/** 世代の平均（world.ts の馬の生成の中心。芝ダートは「ダート向き 35%」に当たる値を 0 とする） */
export const GENE_MEAN: Genes = { speed: 74, stamina: 72, accel: 73, power: 67, temper: 68, distance: 1750, surface: 0, growth: 0 };
/** 個体差の標準偏差（world.ts の馬の生成と同じ） */
export const GENE_SD: Genes = { speed: 5, stamina: 6, accel: 6, power: 9, temper: 10, distance: 380, surface: 0.6, growth: 0.6 };
/** 親自身の値を、平均へどれだけ戻して子に伝えるか（1 = そのまま、0 = 伝わらない）。距離・芝ダートは能力より伝わりやすい */
export const TRANSMIT: Genes = { speed: 0.5, stamina: 0.5, accel: 0.5, power: 0.5, temper: 0.5, distance: 0.6, surface: 0.7, growth: 0.6 };

export interface LineSpec {
  name: string;
  /** 血統背景（画面の説明） */
  background: string;
  /** 平均からのずれ */
  bias: Partial<Genes>;
}

export const LINES: Record<LineId, LineSpec> = {
  solaris: { name: 'ソラリス系', background: '切れ味（瞬発力）が持ち味。芝の中距離で、直線の決め手を生かす産駒が多い。', bias: { accel: 5, speed: 2, distance: 2000, surface: -0.6 } },
  granvert: { name: 'グランヴェール系', background: 'スタミナ豊富で、距離が延びて良さが出る。完成は遅めで、古馬になって力をつける産駒が多い。', bias: { stamina: 6, speed: -2, distance: 2600, surface: -0.5, growth: 0.5 } },
  tempest: { name: 'テンペスト系', background: 'スピードに優れ、仕上がりが早い。短距離で2歳から走る産駒が多いが、距離が延びると苦しい。', bias: { speed: 5, accel: 1, stamina: -5, distance: 1300, surface: -0.1, growth: -0.5 } },
  iron: { name: 'アイアンクレスト系', background: '力強い走りでダートに向く。パワーがあり、時計のかかる馬場や坂にも強い。', bias: { power: 10, stamina: 1, accel: -2, distance: 1700, surface: 0.8, growth: 0.1 } },
  mistral: { name: 'ミストラル系', background: '長くいい脚を使う。芝のマイルから中距離で、早めに動いて押し切る産駒が多い。', bias: { speed: 2, stamina: 2, distance: 1700, surface: -0.4 } },
  aurora: { name: 'オーロラ系', background: '気性が素直で乗りやすい。芝もダートもこなし、条件を問わず堅実に走る産駒が多い。', bias: { temper: 8, speed: 1, accel: 1, distance: 1900, surface: 0.1, growth: 0.2 } },
};

export interface Stallion {
  id: string;
  name: string;
  line: LineId;
  /** 父の名前（分かるとき） */
  sire?: string;
  genes: Genes;
  /** 種牡馬になった年・引退する年 */
  from: number;
  until: number;
  /** 競走馬として走っていた馬の ID（このゲームで引退して種牡馬になった馬） */
  horseId?: string;
}

/** 馬に持たせる血統（保存容量のため短いキー）：父・母・母父の名前と、父の系統 */
export interface Pedigree {
  s: string;
  d: string;
  ds: string;
  l: LineId;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

const FOUNDER_NAMES: Record<LineId, string[]> = {
  solaris: ['ソラリスブレイズ', 'ルミナスアーク', 'デイブレイクソング', 'ソラリスクラウン'],
  granvert: ['グランヴェール', 'ヴェールモナーク', 'エバーグレイス', 'ロングホライズン'],
  tempest: ['テンペストラン', 'ブリッツフェザー', 'クイックシルエット', 'スパークリッジ'],
  iron: ['アイアンクレスト', 'サンドバイソン', 'ブロンズタイタン', 'ダストレイダー'],
  mistral: ['ミストラルロード', 'シーブリーズノート', 'アズールテイル', 'ウィンドグライド'],
  aurora: ['オーロラリリック', 'ホワイトミラージュ', 'スノーカリヨン', 'ポーラーハース'],
};

/** はじめからいる種牡馬（24頭。決定論的）。系統の特徴に個体差を加える。各系統の1頭目は系統の祖 */
export const FOUNDERS: Stallion[] = (Object.keys(FOUNDER_NAMES) as LineId[]).flatMap((line, li) =>
  FOUNDER_NAMES[line].map((name, i) => {
    const rng = new Rng(`founder:${name}`);
    const b = LINES[line].bias;
    const genes = {} as Genes;
    for (const k of GENE_KEYS) {
      const center = k === 'distance' ? (b.distance ?? GENE_MEAN.distance) : GENE_MEAN[k] + (b[k] ?? 0);
      // 種牡馬は選ばれた馬なので、能力は平均より少し上（遺伝的な値で +2）
      const up = k === 'speed' || k === 'stamina' || k === 'accel' ? 2 : 0;
      genes[k] = Math.round((center + up + rng.normal(0, GENE_SD[k] * 0.3)) * 100) / 100;
    }
    genes.surface = clamp(genes.surface, -1, 1);
    genes.growth = clamp(genes.growth, -1, 1);
    return { id: `f${li}${i}`, name, line, ...(i > 0 ? { sire: FOUNDER_NAMES[line][0] } : {}), genes, from: 2012 + ((li * 3 + i * 4) % 12), until: 2030 + ((li * 5 + i * 3) % 11) };
  }),
);

const GRADE_IDX: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };

/** 馬自身の値（表に出ている能力・適性。能力は上限＝ピーク時の値） */
export function phenotype(h: Pick<Horse, 'temper' | 'bestDistance' | 'turf' | 'dirt'> & { growthType?: GrowthType }, pot: { speed: number; stamina: number; accel: number; power: number }): Genes {
  return {
    speed: pot.speed,
    stamina: pot.stamina,
    accel: pot.accel,
    power: pot.power,
    temper: h.temper,
    distance: h.bestDistance,
    // 芝の評価がダートより低いほどダート向き
    surface: clamp((GRADE_IDX[h.turf] - GRADE_IDX[h.dirt]) / 3, -1, 1),
    growth: h.growthType === 'early' ? -0.7 : h.growthType === 'late' ? 0.7 : 0,
  };
}

/** 子に伝える値（遺伝的な値）：自身の値を平均へ戻したもの */
export function breedingValue(p: Genes): Genes {
  const g = {} as Genes;
  for (const k of GENE_KEYS) g[k] = GENE_MEAN[k] + TRANSMIT[k] * (p[k] - GENE_MEAN[k]);
  return g;
}

/** 両親の遺伝的な値の中間の、平均からのずれ */
export function midParent(sire: Genes, dam: Genes): Genes {
  const g = {} as Genes;
  for (const k of GENE_KEYS) g[k] = (sire[k] + dam[k]) / 2 - GENE_MEAN[k];
  return g;
}

/** 種牡馬としての評価（スピード・瞬発力・スタミナの遺伝的な値の平均） */
export const sireQuality = (s: Stallion) => (s.genes.speed + s.genes.accel + s.genes.stamina) / 3;

/** その年に種付けできる種牡馬 */
export function activeStud(stud: Stallion[], year: number): Stallion[] {
  const a = stud.filter((s) => s.from <= year && s.until >= year);
  return a.length ? a : stud;
}

/** 種牡馬の人気（評価の高い種牡馬に産駒が集まる。評価 1 につき約 1.3倍。推定） */
export function sireWeights(stud: Stallion[]): number[] {
  return stud.map((s) => Math.exp((sireQuality(s) - 75) / 4));
}

function pickWeighted<T>(rng: Rng, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const MARE_A = ['ハル', 'ユキ', 'ツキ', 'ホシ', 'ミオ', 'サヨ', 'リリー', 'ローズ', 'ベル', 'マリー', 'エマ', 'ノア', 'ルナ', 'ステラ', 'フローラ', 'アリア', 'セレナ', 'オリーブ', 'ミント', 'シエル'];
const MARE_B = ['ノウタ', 'ノユメ', 'ノハナ', 'ノカゼ', 'ノシラベ', 'ブーケ', 'リボン', 'ティアラ', 'パール', 'シフォン', 'カノン', 'プリズム', 'セレナーデ', 'ワルツ', 'ポエム', 'ヴェール', 'レース', 'グレイス'];

/** 牧場の繁殖牝馬（競走馬として登場しない母）：名前と、母父から受け継いだ遺伝的な値 */
export function virtualDam(rng: Rng, stud: Stallion[]): { name: string; sire: Stallion; genes: Genes } {
  const sire = rng.pick(stud);
  const genes = {} as Genes;
  // 母の遺伝的な値 = 平均 ＋ 母父のずれの半分 ＋ 個体差
  for (const k of GENE_KEYS) genes[k] = GENE_MEAN[k] + 0.5 * (sire.genes[k] - GENE_MEAN[k]) + rng.normal(0, GENE_SD[k] * TRANSMIT[k] * 0.85);
  genes.surface = clamp(genes.surface, -1, 1);
  genes.growth = clamp(genes.growth, -1, 1);
  return { name: rng.pick(MARE_A) + rng.pick(MARE_B), sire, genes };
}

/** 繁殖に上がった牝馬（このゲームで走って引退した馬） */
export interface Broodmare {
  name: string;
  /** その牝馬の父（子から見た母父）の名前 */
  sire?: string;
  genes: Genes;
  /** 選ばれやすさ（成績のよかった牝馬ほど多く子を出す） */
  weight: number;
}

export interface Mating {
  sire: Stallion;
  ped: Pedigree;
  /** 両親の遺伝的な値の中間の、平均からのずれ */
  mid: Genes;
}

/** 走っていた牝馬が母になる割合（残りは牧場の繁殖牝馬。推定） */
export const RACED_DAM_SHARE = 0.3;

/**
 * 1世代分の配合を決める。世代の平均が動かないよう、中間値のずれから世代の平均を引く。
 */
export function planCrop(rng: Rng, n: number, stud: Stallion[], mares: Broodmare[]): Mating[] {
  const weights = sireWeights(stud);
  const out: Mating[] = [];
  for (let i = 0; i < n; i++) {
    const sire = pickWeighted(rng, stud, weights);
    let dam: { name: string; ds: string; genes: Genes };
    if (mares.length && rng.chance(RACED_DAM_SHARE)) {
      const m = pickWeighted(rng, mares, mares.map((x) => x.weight));
      dam = { name: m.name, ds: m.sire ?? rng.pick(stud).name, genes: m.genes };
    } else {
      const v = virtualDam(rng, stud);
      dam = { name: v.name, ds: v.sire.name, genes: v.genes };
    }
    out.push({ sire, ped: { s: sire.name, d: dam.name, ds: dam.ds, l: sire.line }, mid: midParent(sire.genes, dam.genes) });
  }
  if (!out.length) return out;
  for (const k of GENE_KEYS) {
    const mean = out.reduce((a, m) => a + m.mid[k], 0) / out.length;
    for (const m of out) m.mid[k] -= mean;
  }
  return out;
}

/**
 * すでにいる馬（ゲーム開始時の馬・古い保存データの馬）に、あとから血統を付ける（決定論的）。
 * 能力は変えない。その馬の特徴に近い種牡馬ほど父に選ばれやすくして、「産駒は父に似る」傾向を作る。
 */
export function assignPedigree(h: Pick<Horse, 'id' | 'temper' | 'bestDistance' | 'turf' | 'dirt'> & { growthType?: GrowthType }, pot: { speed: number; stamina: number; accel: number; power: number }, stud: Stallion[] = FOUNDERS): Pedigree {
  const rng = new Rng(`ped:${h.id}`);
  const p = phenotype(h, pot);
  const like = (s: Stallion) => {
    let d = 0;
    for (const k of GENE_KEYS) d += ((p[k] - s.genes[k]) / GENE_SD[k]) ** 2;
    // 距離が遠いほど選ばれにくい。完全には決めない（似ていない父の産駒もいる）
    return Math.exp(-d / 5) + 0.01;
  };
  const sire = pickWeighted(rng, stud, stud.map(like));
  const others = stud.filter((s) => s.name !== sire.name);
  const ds = pickWeighted(rng, others, others.map((s) => like(s) + 0.3));
  return { s: sire.name, d: rng.pick(MARE_A) + rng.pick(MARE_B), ds: ds.name, l: sire.line };
}

/** 引退した牡馬を種牡馬にする（1年に最大 max 頭。オープン馬で、本賞金の多い順） */
export function promoteStallions<T extends Horse & { ped?: Pedigree; earnings: number; career: { prize?: number }; life: { pot: { speed: number; stamina: number; accel: number; power: number } } }>(
  retiring: T[],
  stud: Stallion[],
  year: number,
  max = 3,
): Stallion[] {
  const names = new Set(stud.map((s) => s.name));
  return retiring
    .filter((h) => h.sex === '牡' && h.earnings > 1600 && !names.has(h.name))
    .sort((a, b) => (b.career.prize ?? 0) + b.earnings - ((a.career.prize ?? 0) + a.earnings))
    .slice(0, max)
    .map((h) => ({
      id: `s-${h.id}`,
      name: h.name,
      line: h.ped?.l ?? 'aurora',
      ...(h.ped ? { sire: h.ped.s } : {}),
      genes: breedingValue(phenotype(h, h.life.pot)),
      from: year,
      until: year + 14,
      horseId: h.id,
    }));
}

/** 成長型：両親の傾向で、早熟・晩成の割合が変わる（g は −1 早熟〜＋1 晩成のずれ） */
export function inheritGrowth(rng: Rng, g: number): GrowthType {
  const early = clamp(0.4 - 0.45 * g, 0.03, 0.9);
  const late = clamp(0.1 + 0.45 * g, 0.02, 0.9);
  const r = rng.next();
  return r < early ? 'early' : r < 1 - late ? 'normal' : 'late';
}

/** 血統から見た傾向（画面の説明）：父と母父の遺伝的な値から */
export function pedigreeOutlook(ped: Pedigree, stud: Stallion[]): string[] {
  const s = stud.find((x) => x.name === ped.s);
  const ds = stud.find((x) => x.name === ped.ds);
  if (!s) return [];
  // 父を 2、母父を 1 の重みで見る（母父は母を通して半分だけ伝わる）
  const g = {} as Genes;
  for (const k of GENE_KEYS) g[k] = ds ? (2 * s.genes[k] + ds.genes[k]) / 3 : s.genes[k];
  const out: string[] = [];
  out.push(g.distance < 1500 ? '短距離向き' : g.distance < 1900 ? 'マイル前後向き' : g.distance < 2300 ? '中距離向き' : '長距離向き');
  out.push(g.surface > 0.3 ? 'ダート向き' : g.surface < -0.3 ? '芝向き' : '芝・ダート兼用');
  if (g.growth > 0.25) out.push('晩成傾向');
  else if (g.growth < -0.25) out.push('早熟傾向');
  const best = (['speed', 'stamina', 'accel', 'power', 'temper'] as const).map((k) => ({ k, z: (g[k] - GENE_MEAN[k]) / GENE_SD[k] })).sort((a, b) => b.z - a.z)[0];
  if (best.z > 0.25) out.push({ speed: 'スピード型', stamina: 'スタミナ型', accel: '瞬発力型', power: 'パワー型', temper: '気性が素直' }[best.k]);
  return out;
}
