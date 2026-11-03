/**
 * 基準の競走馬の骨格（関節の位置）と、骨ごとの筋肉・骨の塊（SDF の部品）。
 *
 * 寸法はサラブレッドの一般的な体格（体高約1.62m、体長約1.65m、胸の深さ約0.8m）から決めたオリジナル。
 * 筋肉は「肩の前後・上腕三頭筋・胸筋・前腕の伸筋・臀部・大腿二頭筋・半腱様筋・四頭筋・ガスキン」を
 * 別々の塊として置き、狭い幅でつなぐ。塊の境目に浅い溝ができ、陰影で筋肉の形が分かる。
 *
 * 座標：前方 +x、上 +y、右 +z、地面 y = 0。左右対称の部品は右側（z > 0）で定義して鏡写しにする。
 * すべての馬で同じ骨格・同じ部品の構成を使い、体型（細身・標準・筋肉質）は部品の太さだけを変える。
 */
import type { Prim, Vec3 } from './sdf';

export type BuildType = 'lean' | 'standard' | 'muscular';

export interface BoneDef {
  name: string;
  parent: string | null;
  /** 静止姿勢での関節の位置（馬の座標） */
  at: Vec3;
}

/** 前肢・後肢の関節（右側。z は左右で符号を変える） */
export const FORE = {
  withers: [0.4, 1.52, 0.14] as Vec3,
  shoulder: [0.71, 1.14, 0.14] as Vec3,
  elbow: [0.53, 0.98, 0.13] as Vec3,
  knee: [0.555, 0.51, 0.13] as Vec3,
  fetlock: [0.55, 0.181, 0.13] as Vec3,
  coronet: [0.626, 0.075, 0.13] as Vec3,
};
export const HIND = {
  hip: [-0.5, 1.21, 0.14] as Vec3,
  stifle: [-0.37, 0.97, 0.145] as Vec3,
  hock: [-0.6, 0.55, 0.14] as Vec3,
  fetlock: [-0.585, 0.181, 0.14] as Vec3,
  coronet: [-0.509, 0.075, 0.14] as Vec3,
};
export const HOOF_H = 0.075;
export const PASTERN_LEN = Math.hypot(FORE.coronet[0] - FORE.fetlock[0], FORE.coronet[1] - FORE.fetlock[1]);

/** 頭：項（うなじ）を原点に、顔の軸に沿った座標 (u: 鼻先へ, v: 額の側へ, z: 横) で部品を置く */
export const POLL: Vec3 = [1.24, 1.97, 0];
export const HEAD_TILT = (52 * Math.PI) / 180; // 水平から下向き
const HA = [Math.cos(HEAD_TILT), -Math.sin(HEAD_TILT)];
const HN = [Math.sin(HEAD_TILT), Math.cos(HEAD_TILT)];
export function H(u: number, v: number, z = 0): Vec3 {
  return [POLL[0] + u * HA[0] + v * HN[0], POLL[1] + u * HA[1] + v * HN[1], z];
}
/** 頭の目印（目・ハミ・鼻先・額・鼻革の位置など）。馬具や頂点色の塗り分けに使う */
export const HEAD = {
  eye: (s: number) => H(0.145, 0.035, 0.09 * s),
  bit: H(0.48, -0.095, 0),
  muzzle: H(0.56, -0.045, 0),
  forehead: H(0.13, 0.09, 0),
  faceA: H(0.1, 0.02, 0),
  faceB: H(0.5, -0.02, 0),
  noseband: H(0.36, -0.02, 0),
  brow: H(0.03, 0.04, 0),
  throat: H(0.02, -0.09, 0),
  crest: [[0.42, 1.62, 0] as Vec3, [1.21, 2.04, 0] as Vec3],
};

const mirror = (v: Vec3, s: number): Vec3 => [v[0], v[1], v[2] * s];

export function boneDefs(): BoneDef[] {
  const defs: BoneDef[] = [
    { name: 'thorax', parent: null, at: [0.05, 1.3, 0] },
    { name: 'pelvis', parent: 'thorax', at: [-0.25, 1.38, 0] },
    { name: 'neck1', parent: 'thorax', at: [0.58, 1.42, 0] },
    { name: 'neck2', parent: 'neck1', at: [0.95, 1.7, 0] },
    { name: 'head', parent: 'neck2', at: POLL },
    { name: 'earL', parent: 'head', at: [...H(-0.03, 0.06, -0.055)] as Vec3 },
    { name: 'earR', parent: 'head', at: [...H(-0.03, 0.06, 0.055)] as Vec3 },
  ];
  for (const [side, s] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    defs.push(
      { name: `scapula${side}`, parent: 'thorax', at: mirror(FORE.withers, s) },
      { name: `humerus${side}`, parent: `scapula${side}`, at: mirror(FORE.shoulder, s) },
      { name: `forearm${side}`, parent: `humerus${side}`, at: mirror(FORE.elbow, s) },
      { name: `fcannon${side}`, parent: `forearm${side}`, at: mirror(FORE.knee, s) },
      { name: `fpastern${side}`, parent: `fcannon${side}`, at: mirror(FORE.fetlock, s) },
      { name: `femur${side}`, parent: 'pelvis', at: mirror(HIND.hip, s) },
      { name: `tibia${side}`, parent: `femur${side}`, at: mirror(HIND.stifle, s) },
      { name: `hcannon${side}`, parent: `tibia${side}`, at: mirror(HIND.hock, s) },
      { name: `hpastern${side}`, parent: `hcannon${side}`, at: mirror(HIND.fetlock, s) },
    );
  }
  let prev = 'pelvis';
  for (let i = 0; i < 5; i++) {
    const name = `tail${i}`;
    defs.push({ name, parent: prev, at: [-0.92 - 0.17 * i, 1.48 - 0.07 * i, 0] });
    prev = name;
  }
  return defs;
}

/** 部品の一覧。bone は boneDefs() の名前 */
export function anatomy(build: BuildType): Prim[] {
  const defs = boneDefs();
  const B = (name: string) => defs.findIndex((d) => d.name === name);
  const m = build === 'lean' ? 0.93 : build === 'muscular' ? 1.07 : 1;
  const belly = build === 'lean' ? 0.95 : build === 'muscular' ? 1.03 : 1;
  const E = (bone: string, c: Vec3, r: Vec3, k: number, extra: Partial<Prim> = {}): Prim => ({ kind: 'ellipsoid', bone: B(bone), c, r, k, ...extra });
  const C = (bone: string, a: Vec3, ra: number, b: Vec3, rb: number, k: number, extra: Partial<Prim> = {}): Prim => ({ kind: 'cone', bone: B(bone), a, b, ra, rb, k, ...extra });
  const sc = (r: Vec3, s: number): Vec3 => [r[0] * s, r[1] * s, r[2] * s];
  const tilt = -HEAD_TILT;

  const prims: Prim[] = [
    // ---- 胸郭（前躯）：胸は深く、横幅は細め ----
    E('thorax', [0.14, 1.23, 0], [0.55, 0.37, 0.235 * belly], 0.1),
    E('thorax', [0.58, 1.2, 0], [0.25, 0.27, 0.205], 0.09),
    C('thorax', [0.12, 1.5, 0], 0.12, [0.48, 1.51, 0], 0.095, 0.1),
    C('thorax', [-0.28, 1.47, 0], 0.155, [0.2, 1.46, 0], 0.15, 0.1),
    E('thorax', [-0.02, 1.07, 0], [0.47, 0.19 * belly, 0.2 * belly], 0.12),
    // ---- 腰・トモ ----
    C('pelvis', [-0.55, 1.43, 0], 0.16, [-0.15, 1.45, 0], 0.16, 0.1),
    E('pelvis', [-0.58, 1.39, 0], sc([0.37, 0.21, 0.22], m), 0.1),
    E('pelvis', [-0.8, 1.25, 0], [0.13, 0.18, 0.17], 0.07),
    E('pelvis', [-0.36, 1.12, 0], [0.24, 0.19 * belly, 0.19], 0.12),
    C('tail0', [-0.85, 1.49, 0], 0.07, [-0.97, 1.45, 0], 0.05, 0.05),
    // ---- 首（き甲から項へ。縦に深く横に薄い） ----
    C('neck1', [0.5, 1.38, 0], 0.23 * m, [0.96, 1.7, 0], 0.16, 0.09, { sz: 1.35 }),
    C('neck1', [0.44, 1.58, 0], 0.08, [0.98, 1.86, 0], 0.06, 0.07),
    C('neck2', [0.94, 1.68, 0], 0.155, [1.18, 1.92, 0], 0.105, 0.07, { sz: 1.45 }),
    C('neck2', [0.97, 1.86, 0], 0.06, [1.21, 2.02, 0], 0.045, 0.05),
    C('neck2', [1.0, 1.56, 0], 0.085, [1.17, 1.79, 0], 0.07, 0.05),
    // ---- 頭（項 → 鼻先へ） ----
    E('head', H(0.06, -0.02), [0.13, 0.11, 0.096], 0.05, { rotZ: tilt }),
    C('head', H(0.12, 0.0), 0.088, H(0.46, -0.02), 0.058, 0.045, { sz: 1.12 }),
    E('head', H(0.54, -0.045), [0.08, 0.085, 0.072], 0.04, { rotZ: tilt }),
    C('head', H(0.2, -0.16), 0.045, H(0.5, -0.105), 0.04, 0.04),
    E('head', H(0.52, -0.125), [0.045, 0.035, 0.04], 0.03, { rotZ: tilt }),
    C('head', H(0.47, -0.088), 0.008, H(0.6, -0.082), 0.008, 0.012, { sub: true }),
  ];
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const z = (v: number) => v * s;
    prims.push(
      // 頬（下顎の張り）・頬骨の稜線・眉の張り・目のくぼみ・鼻孔
      E('head', H(0.1, -0.12, z(0.05)), [0.14, 0.11, 0.058], 0.05, { rotZ: tilt }),
      C('head', H(0.1, -0.02, z(0.072)), 0.016, H(0.28, -0.05, z(0.066)), 0.014, 0.02),
      E('head', H(0.13, 0.065, z(0.08)), [0.04, 0.02, 0.025], 0.03, { rotZ: tilt }),
      E('head', H(0.145, 0.035, z(0.098)), [0.026, 0.024, 0.024], 0.012, { sub: true }),
      E('head', H(0.6, -0.01, z(0.045)), [0.022, 0.033, 0.016], 0.015, { sub: true, rotZ: tilt + 0.9 }),
      // 首の横の筋（上腕頭筋）：首の付け根から下顎の後ろへの筋で、頸静脈の溝ができる
      C('neck1', [0.66, 1.26, z(0.1)], 0.07 * m, [1.08, 1.74, z(0.06)], 0.05, 0.03),
      // 胸筋（左右の2つの膨らみと、その間の溝）
      E('thorax', [0.75, 1.13, z(0.062)], sc([0.075, 0.12, 0.07], m), 0.05, { rotZ: 0.3 }),
      // 肩：肩甲骨の前（棘上筋）と後ろ（棘下筋）・肩端・上腕三頭筋
      C(`scapula${side}`, [0.42, 1.49, z(0.11)], 0.07 * m, [0.7, 1.19, z(0.13)], 0.085 * m, 0.035, { sz: 1.6 }),
      C(`scapula${side}`, [0.34, 1.46, z(0.11)], 0.08 * m, [0.61, 1.15, z(0.13)], 0.09 * m, 0.035, { sz: 1.6 }),
      E(`humerus${side}`, [0.71, 1.14, z(0.115)], [0.07, 0.075, 0.07], 0.045),
      E(`humerus${side}`, [0.53, 1.05, z(0.12)], sc([0.15, 0.12, 0.085], m), 0.035, { rotZ: 0.55 }),
      // 前腕・伸筋・膝・管・腱・球節・繋
      C(`forearm${side}`, [0.535, 0.98, z(0.125)], 0.068, [0.553, 0.57, z(0.128)], 0.042, 0.04),
      E(`forearm${side}`, [0.578, 0.83, z(0.128)], sc([0.05, 0.13, 0.055], m), 0.025),
      E(`fcannon${side}`, [0.556, 0.51, z(0.13)], [0.05, 0.058, 0.048], 0.025),
      C(`fcannon${side}`, [0.552, 0.49, z(0.13)], 0.034, [0.55, 0.205, z(0.13)], 0.032, 0.02, { sz: 1.2 }),
      C(`fcannon${side}`, [0.512, 0.46, z(0.13)], 0.018, [0.517, 0.225, z(0.13)], 0.018, 0.015),
      E(`fpastern${side}`, [0.545, 0.185, z(0.13)], [0.046, 0.05, 0.042], 0.025),
      C(`fpastern${side}`, [0.552, 0.175, z(0.13)], 0.036, [0.624, 0.085, z(0.13)], 0.038, 0.02),
      // トモ：臀部・大腿二頭筋・四頭筋・半腱様筋（後ろの線）
      E(`femur${side}`, [-0.6, 1.2, z(0.13)], sc([0.28, 0.2, 0.1], m), 0.05, { rotZ: -0.3 }),
      E(`femur${side}`, [-0.58, 1.03, z(0.15)], sc([0.13, 0.22, 0.1], m), 0.035, { rotZ: -0.15 }),
      E(`femur${side}`, [-0.41, 1.05, z(0.145)], sc([0.1, 0.15, 0.09], m), 0.045, { rotZ: 0.3 }),
      C(`femur${side}`, [-0.8, 1.28, z(0.11)], 0.1 * m, [-0.63, 0.86, z(0.13)], 0.075 * m, 0.035),
      // 下腿（ガスキン）・飛節・飛端・管・腱・球節・繋
      C(`tibia${side}`, [-0.4, 0.93, z(0.14)], 0.09 * m, [-0.6, 0.585, z(0.14)], 0.05, 0.04),
      E(`tibia${side}`, [-0.53, 0.8, z(0.14)], sc([0.075, 0.13, 0.06], m), 0.035, { rotZ: -0.5 }),
      E(`hcannon${side}`, [-0.6, 0.545, z(0.14)], [0.06, 0.06, 0.048], 0.03),
      C(`hcannon${side}`, [-0.62, 0.565, z(0.14)], 0.034, [-0.69, 0.6, z(0.14)], 0.028, 0.03),
      C(`hcannon${side}`, [-0.6, 0.52, z(0.14)], 0.036, [-0.586, 0.205, z(0.14)], 0.034, 0.02, { sz: 1.2 }),
      C(`hcannon${side}`, [-0.645, 0.5, z(0.14)], 0.018, [-0.624, 0.225, z(0.14)], 0.018, 0.015),
      E(`hpastern${side}`, [-0.585, 0.185, z(0.14)], [0.046, 0.05, 0.042], 0.025),
      C(`hpastern${side}`, [-0.58, 0.175, z(0.14)], 0.036, [-0.511, 0.085, z(0.14)], 0.038, 0.02),
    );
  }
  return prims;
}
