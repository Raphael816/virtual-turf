/**
 * 騎手の体（モンキー乗りの前傾姿勢）の骨格と部品。馬と同じく SDF の部品をなめらかにつないで作る。
 * 座標は馬の座標（鞍の上）。短いあぶみに立ち、背中を水平にして頭を上げ、手綱を首の上で持つ。
 */
import type { Prim, Vec3 } from './sdf';

export interface JBoneDef {
  name: string;
  parent: string | null;
  at: Vec3;
}

export const JOCKEY_BONES: JBoneDef[] = [
  { name: 'jroot', parent: null, at: [0.02, 1.9, 0] },
  { name: 'jchest', parent: 'jroot', at: [0.14, 1.97, 0] },
  { name: 'jhead', parent: 'jchest', at: [0.55, 2.1, 0] },
  { name: 'juarmL', parent: 'jchest', at: [0.43, 2.04, -0.17] },
  { name: 'jfarmL', parent: 'juarmL', at: [0.56, 1.9, -0.2] },
  { name: 'juarmR', parent: 'jchest', at: [0.43, 2.04, 0.17] },
  { name: 'jfarmR', parent: 'juarmR', at: [0.56, 1.9, 0.2] },
];

/** 手（手綱を持つ位置）の静止姿勢 */
export const HAND = { L: [0.79, 1.8, -0.07] as Vec3, R: [0.79, 1.8, 0.07] as Vec3 };

/** 部位（頂点色の塗り分けに使う） */
export type JPart = 'silk' | 'sleeve' | 'breeches' | 'boots' | 'skin' | 'glove';

export function jockeyAnatomy(): { prims: Prim[]; parts: JPart[] } {
  const B = (n: string) => JOCKEY_BONES.findIndex((b) => b.name === n);
  const prims: Prim[] = [];
  const parts: JPart[] = [];
  const add = (p: Prim, part: JPart) => {
    prims.push(p);
    parts.push(part);
  };
  const E = (bone: string, c: Vec3, r: Vec3, k: number, part: JPart, rotZ = 0) => add({ kind: 'ellipsoid', bone: B(bone), c, r, k, rotZ }, part);
  const C = (bone: string, a: Vec3, ra: number, b: Vec3, rb: number, k: number, part: JPart) => add({ kind: 'cone', bone: B(bone), a, b, ra, rb, k }, part);

  // 胴（背中はほぼ水平）・腰
  E('jchest', [0.24, 2.0, 0], [0.25, 0.115, 0.165], 0.07, 'silk', 0.12);
  E('jchest', [0.38, 2.04, 0], [0.12, 0.11, 0.19], 0.06, 'silk', 0.1);
  E('jroot', [0.0, 1.95, 0], [0.13, 0.11, 0.145], 0.07, 'breeches');
  // 首・頭（帽子は別のメッシュ）
  C('jhead', [0.47, 2.07, 0], 0.05, [0.58, 2.12, 0], 0.045, 0.03, 'skin');
  E('jhead', [0.63, 2.14, 0], [0.095, 0.1, 0.085], 0.03, 'skin');
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    // 太もも（前上へ）・すね（後ろ下へ）・ブーツ
    C('jroot', [0.02, 1.91, 0.1 * s], 0.08, [0.31, 1.73, 0.205 * s], 0.058, 0.05, 'breeches');
    C('jroot', [0.31, 1.73, 0.205 * s], 0.055, [0.13, 1.44, 0.205 * s], 0.042, 0.04, 'boots');
    E('jroot', [0.17, 1.41, 0.205 * s], [0.08, 0.032, 0.04], 0.03, 'boots', -0.2);
    // 腕（肩 → 肘 → 手）
    C(`juarm${side}`, [0.43, 2.04, 0.17 * s], 0.052, [0.56, 1.9, 0.2 * s], 0.042, 0.03, 'sleeve');
    C(`jfarm${side}`, [0.56, 1.9, 0.2 * s], 0.04, [0.77, 1.81, 0.08 * s], 0.032, 0.025, 'sleeve');
    E(`jfarm${side}`, [0.79, 1.8, 0.07 * s], [0.038, 0.032, 0.035], 0.02, 'glove');
  }
  return { prims, parts };
}
