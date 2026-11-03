/**
 * 符号付き距離関数（SDF）で馬体を表し、ポリゴンメッシュに変換する（DOM・three.js 非依存）。
 *
 * 胴・肩・トモ・首・頭・脚を「筋肉や骨の塊」（楕円体・先細りのカプセル）として置き、
 * なめらかな和（smooth union）でつなぐ。部品の境目に段差や継ぎ目ができず、
 * 筋肉の盛り上がりとくぼみが自然に出る。
 *
 * 変換は Surface Nets（格子のセルごとに1頂点）→ Taubin 平滑化 → SDF の表面への射影。
 * 法線は SDF の勾配、くぼみの陰影（AO）も SDF から求める。
 */

export type Vec3 = [number, number, number];

export interface Prim {
  kind: 'ellipsoid' | 'cone';
  /** 所属する骨（スキニングの重みに使う） */
  bone: number;
  /** なめらかにつなぐ幅 (m)。大きいほどゆるやかに溶け合う */
  k: number;
  sub?: boolean;
  /** 楕円体：中心・半径・（任意）回転（z 軸まわり、ラジアン） */
  c?: Vec3;
  r?: Vec3;
  rotZ?: number;
  /** 先細りのカプセル：両端と半径 */
  a?: Vec3;
  b?: Vec3;
  ra?: number;
  rb?: number;
  /** 横方向（z）につぶす倍率（首のように縦に深く横に薄い形） */
  sz?: number;
  /** 内部：境界箱 */
  box?: [number, number, number, number, number, number];
}

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

function ellipsoid(px: number, py: number, pz: number, p: Prim): number {
  const [cx, cy, cz] = p.c!;
  let x = px - cx;
  let y = py - cy;
  const z = (pz - cz) * (p.sz ?? 1);
  if (p.rotZ) {
    const c = Math.cos(-p.rotZ);
    const s = Math.sin(-p.rotZ);
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
  }
  const [rx, ry, rz] = p.r!;
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

/** 先細りのカプセル（iq の round cone） */
function roundCone(px: number, py: number, pz: number, p: Prim): number {
  const [ax, ay, az] = p.a!;
  const [bx, by, bz] = p.b!;
  const sz = p.sz ?? 1;
  const r1 = p.ra!;
  const r2 = p.rb!;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = (bz - az) * sz;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax;
  const pay = py - ay;
  const paz = (pz - az) * sz;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y;
  const xy = pay * l2 - bay * y;
  const xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

export function primDist(p: Prim, x: number, y: number, z: number): number {
  return p.kind === 'ellipsoid' ? ellipsoid(x, y, z, p) : roundCone(x, y, z, p);
}

function primBox(p: Prim): [number, number, number, number, number, number] {
  const m = p.k + 0.01;
  if (p.kind === 'ellipsoid') {
    const [cx, cy, cz] = p.c!;
    const r = Math.max(p.r![0], p.r![1]);
    const rz = p.r![2] / (p.sz ?? 1);
    return [cx - r - m, cy - r - m, cz - rz - m, cx + r + m, cy + r + m, cz + rz + m];
  }
  const [ax, ay, az] = p.a!;
  const [bx, by, bz] = p.b!;
  const r = Math.max(p.ra!, p.rb!) + m;
  const rz = Math.max(p.ra!, p.rb!) / (p.sz ?? 1) + m;
  return [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.min(az, bz) - rz, Math.max(ax, bx) + r, Math.max(ay, by) + r, Math.max(az, bz) + rz];
}

export class Shape {
  readonly adds: Prim[];
  readonly subs: Prim[];
  readonly all: Prim[];
  readonly bounds: [number, number, number, number, number, number];

  constructor(prims: Prim[]) {
    for (const p of prims) p.box = primBox(p);
    this.adds = prims.filter((p) => !p.sub);
    this.subs = prims.filter((p) => p.sub);
    this.all = prims;
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of this.adds) {
      for (let i = 0; i < 3; i++) {
        b[i] = Math.min(b[i], p.box![i]);
        b[i + 3] = Math.max(b[i + 3], p.box![i + 3]);
      }
    }
    this.bounds = b;
  }

  /** 距離。候補の部品（cand）を渡すと、その中だけで計算する（高速化） */
  dist(x: number, y: number, z: number, cand: Prim[] = this.all): number {
    let d = 0.5;
    let first = true;
    for (const p of cand) {
      if (p.sub) continue;
      const b = p.box!;
      if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) continue;
      const di = primDist(p, x, y, z);
      d = first ? di : smin(d, di, p.k);
      first = false;
    }
    for (const p of cand) {
      if (!p.sub) continue;
      const b = p.box!;
      if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) continue;
      d = smax(d, -primDist(p, x, y, z), p.k);
    }
    if (first) {
      // どの部品の境界箱にも入らない点：最も近い境界箱までの距離（真の距離以下なので光線の追跡に使える）
      let m = 0.5;
      for (const p of cand) {
        if (p.sub) continue;
        const b = p.box!;
        const dx = Math.max(b[0] - x, 0, x - b[3]);
        const dy = Math.max(b[1] - y, 0, y - b[4]);
        const dz = Math.max(b[2] - z, 0, z - b[5]);
        m = Math.min(m, Math.hypot(dx, dy, dz) + 1e-3);
      }
      return m;
    }
    return d;
  }

  grad(x: number, y: number, z: number, e = 0.002): Vec3 {
    const gx = this.dist(x + e, y, z) - this.dist(x - e, y, z);
    const gy = this.dist(x, y + e, z) - this.dist(x, y - e, z);
    const gz = this.dist(x, y, z + e) - this.dist(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  }
}

export interface Polygonized {
  positions: Float32Array;
  normals: Float32Array;
  /** くぼみの暗さ 0（明るい）〜1（暗い） */
  occlusion: Float32Array;
  indices: Uint32Array;
}

/**
 * Surface Nets でメッシュ化する。h は格子の間隔 (m)。
 */
export function polygonize(shape: Shape, h: number, smoothIters = 2): Polygonized {
  const [x0, y0, z0, x1, y1, z1] = shape.bounds;
  const nx = Math.ceil((x1 - x0) / h) + 2;
  const ny = Math.ceil((y1 - y0) / h) + 2;
  const nz = Math.ceil((z1 - z0) / h) + 2;
  const ox = x0 - h;
  const oy = y0 - h;
  const oz = z0 - h;
  const field = new Float32Array(nx * ny * nz);
  const id = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // 部品の境界箱で候補を絞りながら距離場を計算する（x 列ごと → y ごと）
  for (let i = 0; i < nx; i++) {
    const x = ox + i * h;
    const cx = shape.all.filter((p) => x >= p.box![0] && x <= p.box![3]);
    for (let j = 0; j < ny; j++) {
      const y = oy + j * h;
      const cy = cx.filter((p) => y >= p.box![1] && y <= p.box![4]);
      if (!cy.some((p) => !p.sub)) {
        for (let k = 0; k < nz; k++) field[id(i, j, k)] = 0.5;
        continue;
      }
      for (let k = 0; k < nz; k++) field[id(i, j, k)] = shape.dist(x, y, oz + k * h, cy);
    }
  }

  // セルごとの頂点
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const corner = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[id(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cnt = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          cnt++;
        }
        cellVert[cid(i, j, k)] = pos.length / 3;
        pos.push(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
      }
    }
  }

  // 符号が変わる格子の辺ごとに、その辺を囲む4セルの頂点で四角形を作る
  const quads: number[] = [];
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const v0 = field[id(i, j, k)];
        // x 方向の辺
        if (i < nx - 1) {
          const v1 = field[id(i + 1, j, k)];
          if (v0 < 0 !== v1 < 0) {
            const q = [cid(i, j - 1, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i, j - 1, k)].map((c) => cellVert[c]);
            if (q.every((v) => v >= 0)) quads.push(...(v0 < 0 ? q : [q[0], q[3], q[2], q[1]]));
          }
        }
        if (j < ny - 1) {
          const v1 = field[id(i, j + 1, k)];
          if (v0 < 0 !== v1 < 0) {
            const q = [cid(i - 1, j, k - 1), cid(i - 1, j, k), cid(i, j, k), cid(i, j, k - 1)].map((c) => cellVert[c]);
            if (q.every((v) => v >= 0)) quads.push(...(v0 < 0 ? q : [q[0], q[3], q[2], q[1]]));
          }
        }
        if (k < nz - 1) {
          const v1 = field[id(i, j, k + 1)];
          if (v0 < 0 !== v1 < 0) {
            const q = [cid(i - 1, j - 1, k), cid(i, j - 1, k), cid(i, j, k), cid(i - 1, j, k)].map((c) => cellVert[c]);
            if (q.every((v) => v >= 0)) quads.push(...(v0 < 0 ? q : [q[0], q[3], q[2], q[1]]));
          }
        }
      }
    }
  }

  const n = pos.length / 3;
  const P = new Float32Array(pos);
  // 隣接（Taubin 平滑化用）
  const nbr: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let q = 0; q < quads.length; q += 4) {
    for (let e = 0; e < 4; e++) {
      const a = quads[q + e];
      const b = quads[q + ((e + 1) % 4)];
      nbr[a].add(b);
      nbr[b].add(a);
    }
  }
  const nb = nbr.map((s) => Int32Array.from(s));
  const tmp = new Float32Array(P.length);
  const laplace = (lambda: number) => {
    for (let v = 0; v < n; v++) {
      const list = nb[v];
      if (!list.length) {
        tmp.set(P.subarray(v * 3, v * 3 + 3), v * 3);
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const u of list) {
        sx += P[u * 3];
        sy += P[u * 3 + 1];
        sz += P[u * 3 + 2];
      }
      const m = list.length;
      tmp[v * 3] = P[v * 3] + lambda * (sx / m - P[v * 3]);
      tmp[v * 3 + 1] = P[v * 3 + 1] + lambda * (sy / m - P[v * 3 + 1]);
      tmp[v * 3 + 2] = P[v * 3 + 2] + lambda * (sz / m - P[v * 3 + 2]);
    }
    P.set(tmp);
  };
  for (let it = 0; it < smoothIters; it++) {
    laplace(0.5);
    laplace(-0.53);
  }
  // 表面へ射影し、法線を SDF の勾配から求める
  const N = new Float32Array(P.length);
  for (let v = 0; v < n; v++) {
    let x = P[v * 3];
    let y = P[v * 3 + 1];
    let z = P[v * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const d = shape.dist(x, y, z);
      const g = shape.grad(x, y, z);
      x -= g[0] * d;
      y -= g[1] * d;
      z -= g[2] * d;
    }
    P[v * 3] = x;
    P[v * 3 + 1] = y;
    P[v * 3 + 2] = z;
    const g = shape.grad(x, y, z);
    N.set(g, v * 3);
  }
  // くぼみの陰影（法線方向に少しずつ離れた点の距離が、離れた量より小さいほど暗い）
  const occ = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    let o = 0;
    const step = 0.03;
    for (let s = 1; s <= 5; s++) {
      const t = s * step;
      const d = shape.dist(P[v * 3] + N[v * 3] * t, P[v * 3 + 1] + N[v * 3 + 1] * t, P[v * 3 + 2] + N[v * 3 + 2] * t);
      o += (t - d) / Math.pow(2, s - 1);
    }
    occ[v] = Math.max(0, Math.min(1, o * 5));
  }

  // 四角形を、短い方の対角線で2つの三角形に分ける
  const idx = new Uint32Array((quads.length / 4) * 6);
  let w = 0;
  const d2 = (a: number, b: number) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  // 三角形の向き（表裏）は SDF の法線に合わせる
  const tri = (a: number, b: number, c: number) => {
    const ux = P[b * 3] - P[a * 3];
    const uy = P[b * 3 + 1] - P[a * 3 + 1];
    const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3];
    const vy = P[c * 3 + 1] - P[a * 3 + 1];
    const vz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const dot = fx * (N[a * 3] + N[b * 3] + N[c * 3]) + fy * (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]) + fz * (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
    if (dot >= 0) idx.set([a, b, c], w);
    else idx.set([a, c, b], w);
    w += 3;
  };
  for (let q = 0; q < quads.length; q += 4) {
    const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    if (d2(a, c) < d2(b, d)) {
      tri(a, b, c);
      tri(a, c, d);
    } else {
      tri(a, b, d);
      tri(b, c, d);
    }
  }
  return { positions: P, normals: N, occlusion: occ, indices: idx };
}

/**
 * スキニングの重み：各頂点で、近い部品ほど大きく、その部品の骨に配分する（上位4本）。
 * s は重みの広がり (m)。関節では隣り合う骨の部品が重なり、自然に滑らかになる。
 */
export function skinWeights(shape: Shape, positions: Float32Array, boneCount: number, s = 0.035): { index: Uint16Array; weight: Float32Array } {
  const n = positions.length / 3;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  const acc = new Float64Array(boneCount);
  for (let v = 0; v < n; v++) {
    acc.fill(0);
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    let dmin = Infinity;
    const ds: number[] = [];
    for (const p of shape.adds) {
      const d = primDist(p, x, y, z);
      ds.push(d);
      if (d < dmin) dmin = d;
    }
    shape.adds.forEach((p, i) => {
      const d = ds[i] - dmin;
      if (d < s * 6) acc[p.bone] += Math.exp(-d / s);
    });
    const order = Array.from(acc.keys()).sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const total = order.reduce((t, b) => t + acc[b], 0) || 1;
    order.forEach((b, i) => {
      index[v * 4 + i] = b;
      weight[v * 4 + i] = acc[b] / total;
    });
  }
  return { index, weight };
}
