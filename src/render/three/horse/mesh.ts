/**
 * 馬体・騎手のメッシュデータの生成（Worker でも本体でも動く純粋な計算）。
 * 体型・画質ごとに1回だけ作り、全馬で共有する（毛色や模様は頂点色で馬ごとに付ける）。
 */
import { anatomy, boneDefs, type BuildType } from './anatomy';
import { jockeyAnatomy, JOCKEY_BONES, type JPart } from './jockeyShape';
import { Shape, polygonize, primDist, skinWeights } from './sdf';

export type Detail = 'low' | 'medium' | 'high';

/** 格子の間隔 (m)。細かいほど脚先や顔の形が正確 */
export const GRID: Record<Detail, number> = { low: 0.026, medium: 0.017, high: 0.012 };

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  occlusion: Float32Array;
  indices: Uint32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** 騎手のみ：頂点ごとの部位番号 */
  part?: Uint8Array;
}

export function buildHorseMesh(build: BuildType, detail: Detail): MeshData {
  const shape = new Shape(anatomy(build));
  const g = polygonize(shape, GRID[detail]);
  const w = skinWeights(shape, g.positions, boneDefs().length);
  return { ...g, skinIndex: w.index, skinWeight: w.weight };
}

export const JPARTS: JPart[] = ['silk', 'sleeve', 'breeches', 'boots', 'skin', 'glove'];

export function buildJockeyMesh(detail: Detail): MeshData {
  const { prims, parts } = jockeyAnatomy();
  const shape = new Shape(prims);
  const g = polygonize(shape, Math.max(0.011, GRID[detail] * 0.8), 2);
  const w = skinWeights(shape, g.positions, JOCKEY_BONES.length, 0.02);
  // 頂点ごとに最も近い部品の部位を塗り分けに使う
  const n = g.positions.length / 3;
  const part = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    let best = 0;
    let bd = Infinity;
    prims.forEach((p, i) => {
      const d = primDist(p, g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    part[v] = JPARTS.indexOf(parts[best]);
  }
  return { ...g, skinIndex: w.index, skinWeight: w.weight, part };
}

export function transferables(d: MeshData): ArrayBuffer[] {
  const list: ArrayBufferView[] = [d.positions, d.normals, d.occlusion, d.indices, d.skinIndex, d.skinWeight];
  if (d.part) list.push(d.part);
  return list.map((a) => a.buffer as ArrayBuffer);
}
