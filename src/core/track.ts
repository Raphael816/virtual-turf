/**
 * コース形状（経路・曲率・起伏）。JRA 10場（src/data/venues.ts）の公開データからの **非公式の再現**。
 * JRA の図面・写真は使っていない。数値の出典と、推定で補った箇所は docs/05-course-reference.md・docs/11-venues.md に記載。
 *
 * - 回りは競馬場ごと（右回り・左回り）。経路は右回りで作り、左回りの場は最後に x を反転する
 * - u はホームストレッチ入口（4コーナー出口）からのラチ沿い距離。ゴールは u = 直線距離
 * - 1周距離・直線距離・幅員・高低差は公式の値。形（コーナーの半径・ゴールから1コーナーまで）と起伏の形は推定
 * - 中山だけは、以前から作り込んでいた形（外回りが2コーナーで分かれ3コーナーで合流する形、ゴール前の急坂）を使う
 *
 * 経路は 0.5m 刻みの点列（位置・向き・曲率・標高）として持ち、どんな形でも同じ関数で扱う。
 */

import { DEFAULT_VENUE, type ElevationKeys, type Layout, VENUES, type VenueId, type VenueSpec } from '../data/venues';

export type Surface = 'turf' | 'dirt';
export type CourseId = 'turf' | 'turfOuter' | 'dirt';

export interface Course {
  id: CourseId;
  venue: VenueId;
  /** 1 = 右回り、-1 = 左回り */
  hand: 1 | -1;
  surface: Surface;
  label: string;
  /** コース幅 (m) */
  width: number;
  /** 1周の距離 (m) */
  circumference: number;
  /** ゴール板の u 座標 */
  finishU: number;
  /** ホームストレッチ全体の長さ (m)（表示・配置用） */
  straight: number;
  /** 代表的なコーナー半径 (m)（表示・配置用） */
  radius: number;
  /** 1角・2角・3角・4角の u 座標 */
  corners: [number, number, number, number];
  step: number;
  xs: Float32Array;
  zs: Float32Array;
  hs: Float32Array;
  /** 曲率（コーナーの内側へ曲がるとき正。回り方向によらない） */
  ks: Float32Array;
  /** 標高 (m) */
  es: Float32Array;
}

export interface TrackPoint {
  x: number;
  y: number;
  z: number;
  /** 進行方向（ラジアン、+x 方向が 0、+z 方向が +π/2） */
  heading: number;
  onTurn: boolean;
  curvature: number;
  /** 勾配（上りが正、2.24% なら 0.0224） */
  grade: number;
}

const STEP = 0.5;
const STRAIGHT = 400;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 経路の生成

interface Pt {
  x: number;
  z: number;
}

/** 直線と円弧（右回りは正の角度）をつないで点列を作る */
function trace(start: Pt & { h: number }, segs: ({ line: number } | { r: number; angle: number })[], res = 0.25): Pt[] {
  const pts: Pt[] = [{ x: start.x, z: start.z }];
  let { x, z, h } = start;
  for (const s of segs) {
    if ('line' in s) {
      const n = Math.ceil(s.line / res);
      for (let i = 1; i <= n; i++) pts.push({ x: x + Math.cos(h) * (s.line * i) / n, z: z + Math.sin(h) * (s.line * i) / n });
      x += Math.cos(h) * s.line;
      z += Math.sin(h) * s.line;
    } else {
      // 右回りの円弧：中心は進行方向の右側
      const cx = x - Math.sin(h) * s.r;
      const cz = z + Math.cos(h) * s.r;
      const a0 = Math.atan2(z - cz, x - cx);
      const n = Math.ceil((s.r * Math.abs(s.angle)) / res);
      for (let i = 1; i <= n; i++) {
        const a = a0 + (s.angle * i) / n;
        pts.push({ x: cx + Math.cos(a) * s.r, z: cz + Math.sin(a) * s.r });
      }
      h += s.angle;
      x = pts[pts.length - 1].x;
      z = pts[pts.length - 1].z;
    }
  }
  return pts;
}

/** 閉じた点列を等間隔に並べ直し、向き・曲率を求める */
function resample(pts: Pt[]): { xs: Float32Array; zs: Float32Array; hs: Float32Array; ks: Float32Array; length: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const length = cum[cum.length - 1] + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z);
  const n = Math.round(length / STEP);
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (i * length) / n;
    while (j < pts.length - 1 && cum[j + 1] < s) j++;
    const a = pts[j];
    const b = pts[(j + 1) % pts.length];
    const segLen = j + 1 < pts.length ? cum[j + 1] - cum[j] : length - cum[j];
    const t = segLen > 0 ? (s - cum[j]) / segLen : 0;
    xs[i] = a.x + (b.x - a.x) * t;
    zs[i] = a.z + (b.z - a.z) * t;
  }
  const hs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const q = (i + 1) % n;
    hs[i] = Math.atan2(zs[q] - zs[p], xs[q] - xs[p]);
  }
  // 曲率 = 向きの変化 ÷ 距離（±3m で平滑化）
  const ks = new Float32Array(n);
  const w = Math.round(3 / STEP);
  for (let i = 0; i < n; i++) {
    let d = hs[(i + w) % n] - hs[(i - w + n) % n];
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    ks[i] = d / (2 * w * (length / n));
  }
  return { xs, zs, hs, ks, length };
}

/** 標高のキー点（u, 標高）を線形補間し、移動平均で滑らかにする */
function elevationProfile(n: number, length: number, keys: [number, number][], smoothM: number): Float32Array {
  const raw = new Float32Array(n);
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < n; i++) {
    const u = (i * length) / n;
    let a = k[k.length - 1];
    let b = k[0];
    let ua = a[0] - length;
    let ub = b[0];
    for (let j = 0; j < k.length; j++) {
      if (k[j][0] <= u) {
        a = k[j];
        ua = k[j][0];
        b = k[(j + 1) % k.length];
        ub = j + 1 < k.length ? k[j + 1][0] : k[0][0] + length;
      }
    }
    const t = ub > ua ? (u - ua) / (ub - ua) : 0;
    raw[i] = a[1] + (b[1] - a[1]) * t;
  }
  const out = new Float32Array(n);
  const w = Math.max(1, Math.round(smoothM / 2 / (length / n)));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -w; d <= w; d++) s += raw[(i + d + n) % n];
    out[i] = s / (2 * w + 1);
  }
  return out;
}

function makeCourse(
  venue: VenueId,
  hand: 1 | -1,
  id: CourseId,
  surface: Surface,
  label: string,
  width: number,
  finishU: number,
  pts: Pt[],
  corners: [number, number, number, number],
  radius: number,
  elevKeys: (c: { length: number; corners: [number, number, number, number] }) => [number, number][],
): Course {
  const r = resample(pts);
  const n = r.xs.length;
  if (hand < 0) {
    // 左右反転：位置の x と向きを鏡写しにする（曲率は「内側へ曲がると正」のまま）
    for (let i = 0; i < n; i++) {
      r.xs[i] = -r.xs[i];
      let h = Math.PI - r.hs[i];
      if (h > Math.PI) h -= TAU;
      r.hs[i] = h;
    }
  }
  return {
    id,
    venue,
    hand,
    surface,
    label,
    width,
    circumference: r.length,
    finishU,
    straight: STRAIGHT,
    radius,
    corners,
    step: r.length / n,
    xs: r.xs,
    zs: r.zs,
    hs: r.hs,
    ks: r.ks,
    es: elevationProfile(n, r.length, elevKeys({ length: r.length, corners }), 24),
  };
}

// ---------------------------------------------------------------- 中山（以前から作り込んでいた形）

/** 芝・内回りの起伏（推定。ゴール前の坂だけは公式値）。高低差は約5.3m */
function turfElevation(finishU: number, c: { length: number; corners: [number, number, number, number] }, scale = 1): [number, number][] {
  const [c1, c2, c3] = c.corners;
  const L = c.length;
  const e = (v: number) => 0.05 + (v - 0.05) * scale;
  return [
    [0, e(0.15)],
    [finishU - 200, e(0.05)], // 直線の最も低いあたり
    [finishU - 180, e(0.08)], // 坂の始まり（残り180m）
    [finishU - 70, e(2.28)], // 坂の終わり（残り70m）：+2.2m
    [finishU, e(2.55)],
    [c1, e(3.0)], // 1コーナー：上り
    [(c1 + c2) / 2, e(4.4)],
    [c2, e(5.35)], // 2コーナー付近が最も高い（推定）
    [(c2 + c3) / 2, e(4.1)], // 向正面：下り（推定）
    [c3, e(2.7)],
    [(c3 + L) / 2, e(1.0)], // 3〜4コーナー：下り（推定）
  ];
}

function buildTurfInner(hand: 1 | -1): Course {
  const R = (1667.1 - 2 * STRAIGHT) / TAU; // 約138m
  const pts = trace({ x: STRAIGHT / 2, z: R, h: Math.PI }, [{ line: STRAIGHT }, { r: R, angle: Math.PI }, { line: STRAIGHT }, { r: R, angle: Math.PI }]);
  pts.pop(); // 始点と重複する終点
  const arc = Math.PI * R;
  return makeCourse('nakayama', hand, 'turf', 'turf', '芝・内回り', 26, 310, pts, [STRAIGHT, STRAIGHT + arc, 2 * STRAIGHT + arc, 0], R, (c) => turfElevation(310, c));
}

/**
 * 芝・外回り（形は推定）。内回りと同じホームストレッチ・1コーナーを通り、2コーナー途中で接線方向へ外に分かれ、
 * 外側の向正面を走ってから、3コーナー途中で内回りに接線方向から合流する（すべて右回りの曲線と直線）。
 * 外側への張り出し d は、1周が 1,839.7m になるよう二分探索で決める。
 */
function buildTurfOuter(hand: 1 | -1): Course {
  const R = (1667.1 - 2 * STRAIGHT) / TAU;
  const L = STRAIGHT;
  const target = 1839.7;
  const b1 = Math.PI * 0.62; // 1・2コーナーのうち内回りと共通の角度
  const b2 = Math.PI * 0.3; // 3・4コーナーのうち、外回りが合流する位置（3コーナー入口からの角度）
  const Rb = 150; // 外回りのコーナー半径（推定）

  const layout = (d: number) => {
    // 分岐点 B（1・2コーナーの円上）と接線方向の直線 t1
    const h1 = Math.PI + b1;
    const B = { x: -L / 2 + Math.cos(Math.PI / 2 + b1) * R, z: Math.sin(Math.PI / 2 + b1) * R };
    const t1 = (-(R + d) + Rb * (1 - Math.cos(h1)) - B.z) / Math.sin(h1);
    const P = { x: B.x + t1 * Math.cos(h1), z: B.z + t1 * Math.sin(h1) };
    const xe = P.x - Rb * Math.sin(h1); // 向正面の始まり
    // 合流点 J（3・4コーナーの円上）と、そこへ入る接線方向の直線 t2
    const J = { x: L / 2 + Math.cos(-Math.PI / 2 + b2) * R, z: Math.sin(-Math.PI / 2 + b2) * R };
    const t2 = (J.z + R + d - Rb * (1 - Math.cos(b2))) / Math.sin(b2);
    const xs = J.x - Rb * Math.sin(b2) - t2 * Math.cos(b2); // 向正面の終わり
    return { t1, t2, back: xs - xe };
  };
  let lo = 1;
  let hi = 150;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    const g = layout(mid);
    const len = L + R * b1 + g.t1 + Rb * (Math.PI - b1) + g.back + Rb * b2 + g.t2 + R * (Math.PI - b2);
    if (len < target) lo = mid;
    else hi = mid;
  }
  const g = layout((lo + hi) / 2);
  if (g.t1 < 0 || g.t2 < 0 || g.back < 0) throw new Error('外回りコースの形が成立しません');
  const pts = trace({ x: L / 2, z: R, h: Math.PI }, [
    { line: L },
    { r: R, angle: b1 },
    { line: g.t1 },
    { r: Rb, angle: Math.PI - b1 },
    { line: g.back },
    { r: Rb, angle: b2 },
    { line: g.t2 },
    { r: R, angle: Math.PI - b2 },
  ]);
  pts.pop();
  const c2 = L + R * b1 + g.t1 + Rb * (Math.PI - b1); // 向正面の始まり
  const c3 = c2 + g.back; // 外回りの3コーナー入口
  return makeCourse('nakayama', hand, 'turfOuter', 'turf', '芝・外回り', 28, 310, pts, [L, c2, c3, 0], R, (c) => turfElevation(310, c));
}

function buildDirt(hand: 1 | -1): Course {
  const R = (1493 - 2 * STRAIGHT) / TAU; // 約110m（芝の内側）
  const pts = trace({ x: STRAIGHT / 2, z: R, h: Math.PI }, [{ line: STRAIGHT }, { r: R, angle: Math.PI }, { line: STRAIGHT }, { r: R, angle: Math.PI }]);
  pts.pop();
  const arc = Math.PI * R;
  // ダートの高低差 4.5m（区間ごとの形は芝と同じ傾向と仮定）
  return makeCourse('nakayama', hand, 'dirt', 'dirt', 'ダート', 22, 308, pts, [STRAIGHT, STRAIGHT + arc, 2 * STRAIGHT + arc, 0], R, (c) => turfElevation(308, c, 4.5 / 5.3));
}

/**
 * 外回りの標高を、内回りと同じ経路を通る区間（ホームストレッチ〜1・2コーナーの途中、3コーナーの途中〜ゴール）では
 * 内回りと完全に一致させる。外回りだけの区間は、自前の起伏の形を保ったまま両端で内回りにつながるよう補正する。
 * （一致させないと、共通区間で同じ場所なのに外回りの方が低くなり、馬が芝の面に沈んで見える）
 */
function alignOuterElevation(inner: Course, outer: Course, targetRange?: number): Course {
  const n = outer.es.length;
  const nearestInnerU = (x: number, z: number, uGuess: number) => {
    let best = uGuess;
    let bd = Infinity;
    for (let du = -40; du <= 40; du += 0.5) {
      const u = (((uGuess + du) % inner.circumference) + inner.circumference) % inner.circumference;
      const i = Math.floor(u / inner.step) % inner.xs.length;
      const d = (inner.xs[i] - x) ** 2 + (inner.zs[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return { u: best, d: Math.sqrt(bd) };
  };
  const innerE = (u: number) => {
    const i0 = Math.floor(u / inner.step) % inner.es.length;
    const i1 = (i0 + 1) % inner.es.length;
    const t = u / inner.step - Math.floor(u / inner.step);
    return inner.es[i0] + (inner.es[i1] - inner.es[i0]) * t;
  };
  // 各点が内回りの芝の上にあるかと、対応する内回りの u
  const shared = new Array<boolean>(n);
  const innerU = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const uo = i * outer.step;
    // ゴール側から測った距離が同じなら、内回りでも同じ位置（外回りの方が長い分だけずらす）
    const guess = uo <= outer.circumference / 2 ? uo : uo - (outer.circumference - inner.circumference);
    const r = nearestInnerU(outer.xs[i], outer.zs[i], guess);
    // 内回りの芝の帯（幅）の上に重なっている間は、内回りと同じ高さにする
    shared[i] = r.d < inner.width;
    innerU[i] = r.u;
  }
  const es = new Float32Array(outer.es);
  for (let i = 0; i < n; i++) if (shared[i]) es[i] = innerE(innerU[i]);
  // 外回りだけの区間（1周の中のひと続きの区間ごと）：両端の差を線形に配分して、内回りの標高へなめらかにつなぐ
  const first = shared.indexOf(true);
  const runs: { s0: number; len: number; ea: number; eb: number }[] = [];
  if (first >= 0) {
    let i = 0;
    while (i < n) {
      const s0 = (first + i) % n;
      if (shared[s0]) {
        i++;
        continue;
      }
      let len = 0;
      while (len < n && !shared[(s0 + len) % n]) len++;
      const before = (s0 - 1 + n) % n;
      const after = (s0 + len) % n;
      const da = innerE(innerU[before]) - outer.es[before];
      const db = innerE(innerU[after]) - outer.es[after];
      for (let k = 0; k < len; k++) {
        const j = (s0 + k) % n;
        const t = (k + 1) / (len + 1);
        es[j] = outer.es[j] + da + (db - da) * t;
      }
      runs.push({ s0, len, ea: innerE(innerU[before]), eb: innerE(innerU[after]) });
      i += len;
    }
  }
  // 外回りだけの区間の起伏を、全体の高低差が公式の値になるまで強める（共通区間に合わせると起伏が小さくなるため）
  if (targetRange !== undefined && runs.length) {
    const base = new Float32Array(es);
    const apply = (k: number) => {
      for (const r of runs) {
        for (let q = 0; q < r.len; q++) {
          const j = (r.s0 + q) % n;
          const b = r.ea + (r.eb - r.ea) * ((q + 1) / (r.len + 1));
          es[j] = b + (base[j] - b) * k;
        }
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const e of es) {
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
      }
      return hi - lo;
    };
    if (apply(1) < targetRange) apply(solve(apply, targetRange, 1, 4));
  }
  return { ...outer, es };
}

// ---------------------------------------------------------------- 10場の一般的な形

/**
 * ホームストレッチ（長さ H）・1〜2コーナー（半径 r1）・向正面・3〜4コーナー（半径 r2）からなる閉じた形（右回り）。
 * 向正面は2つの円の共通接線。r1 = r2 なら左右対称の形になる。
 * 始点 (x0, zh) から −x 方向へ進み、内側は −z 側。
 */
function loopShape(H: number, r1: number, r2: number) {
  const hb = 2 * Math.atan((r1 - r2) / H); // 向正面の向き（+x からの角度）
  const B = H * Math.cos(hb) + (r1 - r2) * Math.sin(hb);
  const a1 = Math.PI + hb;
  const a2 = Math.PI - hb;
  return { hb, B, a1, a2, length: H + B + r1 * a1 + r2 * a2 };
}

function solve(f: (x: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 起伏：キー点の形を、高低差が公式の値になるよう拡大・縮小する */
function scaledKeys(keys: ElevationKeys, elevation: number) {
  return (c: { length: number; corners: [number, number, number, number] }, S: number): [number, number][] => {
    const L = c.length;
    const lm = { C: L, S, c1: c.corners[0], c2: c.corners[1], c3: c.corners[2], rem: (r: number) => (((S - r) % L) + L) % L };
    const raw = keys(lm).map(([u, h]) => [(((u % L) + L) % L), h] as [number, number]);
    const lo = Math.min(...raw.map((k) => k[1]));
    const hi = Math.max(...raw.map((k) => k[1]));
    const k = hi > lo ? elevation / (hi - lo) : 0;
    return raw.map(([u, h]) => [u, 0.05 + (h - lo) * k] as [number, number]);
  };
}

interface LoopParams {
  H: number;
  r1: number;
  r2: number;
  x0: number;
  zh: number;
}

function loopCourse(v: VenueSpec, id: CourseId, surface: Surface, label: string, spec: VenueSpec['turf'], p: LoopParams): Course {
  const g = loopShape(p.H, p.r1, p.r2);
  const pts = trace({ x: p.x0, z: p.zh, h: Math.PI }, [{ line: p.H }, { r: p.r1, angle: g.a1 }, { line: g.B }, { r: p.r2, angle: g.a2 }]);
  pts.pop();
  const c1 = p.H;
  const c2 = c1 + p.r1 * g.a1;
  const c3 = c2 + g.B;
  const keys = scaledKeys(spec.keys, spec.elevation);
  const course = makeCourse(v.id, v.hand, id, surface, label, spec.width, spec.straight, pts, [c1, c2, c3, 0], Math.min(p.r1, p.r2), (c) => keys(c, spec.straight));
  // 起伏の平滑化で高低差が縮むので、公式の値に合わせ直す
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of course.es) {
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
  }
  if (hi > lo) for (let i = 0; i < course.es.length; i++) course.es[i] = 0.05 + ((course.es[i] - lo) * spec.elevation) / (hi - lo);
  return course;
}

/** 芝と芝の内側のダートのあいだ（m） */
const INFIELD_GAP = 2;

/**
 * 中山以外の場：
 * - 芝（内回り）：ゴールから1コーナー入口までの距離（推定）と直線距離から H を決め、1周距離が公式の値になる半径を求める（左右対称）
 * - 外回り：ホームストレッチの延長線上で直線が長くなり（4コーナー出口がゴールから遠い）、1〜2コーナーは内回りと共通、
 *   3〜4コーナーの半径を1周距離が公式の値になるよう求める
 * - ダート：芝の内側に同じ中心のコーナーで置き（芝の幅＋2m 内側）、1周距離が公式の値になるよう直線の長さを決める
 */
function buildVenue(v: VenueSpec): Record<CourseId, Course> {
  const t = v.turf;
  const H = t.straight + v.goalToTurn;
  const R = (t.circumference - 2 * H) / TAU;
  const zh = R;
  const x0 = H / 2;
  const turf = loopCourse(v, 'turf', 'turf', v.outer ? '芝・内回り' : '芝', t, { H, r1: R, r2: R, x0, zh });
  let outer = turf;
  if (v.outer) {
    const o = v.outer;
    let ext = o.straight - t.straight;
    let r2 = solve((r) => loopShape(H + ext, R, r).length, o.circumference, R * 0.5, R * 4);
    let spec = o;
    // 3〜4コーナーが内回りより小さくなる（内回りの内側に入り込む）ときは、直線を延ばした左右対称の形にする。
    // 1周距離を優先し、外回りの直線距離は形から決まる値になる（京都：公式 403.7m に対して約 384m。docs/11-venues.md）
    if (r2 < R) {
      ext = (o.circumference - t.circumference) / 2;
      r2 = R;
      spec = { ...o, straight: t.straight + ext };
    }
    outer = alignOuterElevation(turf, loopCourse(v, 'turfOuter', 'turf', '芝・外回り', spec, { H: H + ext, r1: R, r2, x0: x0 + ext, zh }), o.elevation);
  }
  const d = v.dirt;
  // 芝とダートのあいだ：ふつうは2m。ダートの1周が芝に比べて長い場（函館・小倉）は、コーナーが芝にかからないところまで詰める
  const gMax = (H / 2 + t.width - d.width - 1 - (d.circumference - TAU * (R - t.width)) / 4) / (Math.PI / 2 - 1);
  const gap = Math.max(0, Math.min(INFIELD_GAP, gMax));
  const Rd = R - t.width - gap;
  const Hd = (d.circumference - TAU * Rd) / 2;
  const dirt = loopCourse(v, 'dirt', 'dirt', 'ダート', d, { H: Hd, r1: Rd, r2: Rd, x0: Hd / 2, zh: zh - t.width - gap });
  return { turf, turfOuter: outer, dirt };
}

function buildNakayama(): Record<CourseId, Course> {
  const hand = VENUES.nakayama.hand;
  const inner = buildTurfInner(hand);
  return { turf: inner, turfOuter: alignOuterElevation(inner, buildTurfOuter(hand)), dirt: buildDirt(hand) };
}

const cache = new Map<VenueId, Record<CourseId, Course>>();

/** 競馬場のコース（内回り・外回り・ダート）。外回りのない場は turfOuter が内回りと同じ */
export function venueCourses(venue: VenueId = DEFAULT_VENUE): Record<CourseId, Course> {
  let c = cache.get(venue);
  if (!c) {
    c = venue === 'nakayama' ? buildNakayama() : buildVenue(VENUES[venue]);
    cache.set(venue, c);
  }
  return c;
}

/** 外回りがある場か */
export function hasOuter(venue: VenueId = DEFAULT_VENUE): boolean {
  return !!VENUES[venue].outer;
}

/** 以前からの参照用（中山） */
export const COURSES: Record<CourseId, Course> = venueCourses(DEFAULT_VENUE);

/** レース条件からコースを選ぶ（芝は layout で内回り/外回り） */
export function courseFor(surface: Surface, layout?: Layout, venue: VenueId = DEFAULT_VENUE): Course {
  const c = venueCourses(venue);
  if (surface === 'dirt') return c.dirt;
  return layout === 'outer' ? c.turfOuter : c.turf;
}

// ---------------------------------------------------------------- 参照

export function wrapU(c: Course, u: number): number {
  return ((u % c.circumference) + c.circumference) % c.circumference;
}

function sample(c: Course, uRaw: number): { i0: number; i1: number; t: number } {
  const n = c.xs.length;
  const f = wrapU(c, uRaw) / c.step;
  const i0 = Math.floor(f) % n;
  return { i0, i1: (i0 + 1) % n, t: f - Math.floor(f) };
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** u と外ラチ方向へのオフセット lane(m) から位置を求める（右回りなので外側は進行方向の左） */
export function pointAt(c: Course, uRaw: number, lane: number): TrackPoint {
  const { i0, i1, t } = sample(c, uRaw);
  const heading = lerpAngle(c.hs[i0], c.hs[i1], t);
  const k = c.ks[i0] + (c.ks[i1] - c.ks[i0]) * t;
  // lane はラチから外側への距離。外側は、右回りでは進行方向の左、左回りでは右
  const x = c.xs[i0] + (c.xs[i1] - c.xs[i0]) * t + c.hand * Math.sin(heading) * lane;
  const z = c.zs[i0] + (c.zs[i1] - c.zs[i0]) * t - c.hand * Math.cos(heading) * lane;
  const y = c.es[i0] + (c.es[i1] - c.es[i0]) * t;
  const grade = (c.es[i1] - c.es[i0]) / c.step;
  return { x, y, z, heading, onTurn: Math.abs(k) > 1 / 1500, curvature: k, grade };
}

export function curvatureAt(c: Course, u: number): number {
  const { i0, i1, t } = sample(c, u);
  return c.ks[i0] + (c.ks[i1] - c.ks[i0]) * t;
}

export function elevationAt(c: Course, u: number): number {
  const { i0, i1, t } = sample(c, u);
  return c.es[i0] + (c.es[i1] - c.es[i0]) * t;
}

/** 勾配（±5m の平均） */
export function gradeAt(c: Course, u: number): number {
  return (elevationAt(c, u + 5) - elevationAt(c, u - 5)) / 10;
}

export function isOnTurn(c: Course, u: number): boolean {
  return Math.abs(curvatureAt(c, u)) > 1 / 1500;
}

/** レース距離 distance のうち covered を走った時点の u 座標 */
export function raceU(c: Course, distance: number, covered: number): number {
  return wrapU(c, c.finishU - distance + covered);
}

export function cornerUs(c: Course): number[] {
  return [...c.corners];
}

/** スタートからゴールまでに通過するコーナー（covered 距離, コーナー番号）を順に返す。直近4つまで */
export function cornersOnRoute(c: Course, distance: number): { at: number; corner: number }[] {
  const start = raceU(c, distance, 0);
  const res: { at: number; corner: number }[] = [];
  for (let lap = 0; lap < 3; lap++) {
    c.corners.forEach((cu, i) => {
      const at = wrapU(c, cu - start) + lap * c.circumference;
      if (at > 50 && at < distance - 50) res.push({ at, corner: i + 1 });
    });
  }
  res.sort((a, b) => a.at - b.at);
  return res.slice(-4);
}

/** 全コースの範囲（描画の縮尺用） */
export function courseBounds(venue: VenueId = DEFAULT_VENUE): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of Object.values(venueCourses(venue))) {
    for (let i = 0; i < c.xs.length; i += 4) {
      for (const lane of [0, c.width]) {
        const p = pointAt(c, i * c.step, lane);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/** 適性の計算に使うコースの特徴（ability.ts） */
export function courseTraits(c: Course): { hand: 1 | -1; straight: number; turnRadius: number; finalHill: number } {
  const hill = elevationAt(c, c.finishU - 70) - elevationAt(c, c.finishU - 180);
  return { hand: c.hand, straight: c.finishU, turnRadius: c.radius, finalHill: Math.max(0, hill) };
}
