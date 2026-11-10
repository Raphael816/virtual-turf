/**
 * コース形状（経路・曲率・起伏）。
 *
 * 中山競馬場の公開データ（JRA公式サイト「コース紹介」）を参考にした **非公式の再現**。
 * JRA の図面・写真は使っていない。数値の出典と、推定で補った箇所は docs/05-course-reference.md に記載。
 *
 * - 右回り。u はホームストレッチ入口（4コーナー出口）からのラチ沿い距離
 * - 芝 内回り：1周 1,667.1m、直線 310m（4コーナー出口からゴールまで）
 * - 芝 外回り：1周 1,839.7m。2コーナーで内回りから分かれ、3コーナーで合流する（形は推定）
 * - ダート：1周 1,493m、直線 308m
 * - 起伏：芝の高低差 5.3m、ゴール前の上り坂（残り180m〜70m、高低差2.2m）は公式値。それ以外の区間は推定
 *
 * 経路は 0.5m 刻みの点列（位置・向き・曲率・標高）として持ち、どんな形でも同じ関数で扱う。
 */

export type Surface = 'turf' | 'dirt';
export type CourseId = 'turf' | 'turfOuter' | 'dirt';

export interface Course {
  id: CourseId;
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
  /** 曲率（右へ曲がるとき正） */
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
  return {
    id,
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

// ---------------------------------------------------------------- 中山を参考にしたコース

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

function buildTurfInner(): Course {
  const R = (1667.1 - 2 * STRAIGHT) / TAU; // 約138m
  const pts = trace({ x: STRAIGHT / 2, z: R, h: Math.PI }, [{ line: STRAIGHT }, { r: R, angle: Math.PI }, { line: STRAIGHT }, { r: R, angle: Math.PI }]);
  pts.pop(); // 始点と重複する終点
  const arc = Math.PI * R;
  return makeCourse('turf', 'turf', '芝・内回り', 26, 310, pts, [STRAIGHT, STRAIGHT + arc, 2 * STRAIGHT + arc, 0], R, (c) => turfElevation(310, c));
}

/**
 * 芝・外回り（形は推定）。内回りと同じホームストレッチ・1コーナーを通り、2コーナー途中で接線方向へ外に分かれ、
 * 外側の向正面を走ってから、3コーナー途中で内回りに接線方向から合流する（すべて右回りの曲線と直線）。
 * 外側への張り出し d は、1周が 1,839.7m になるよう二分探索で決める。
 */
function buildTurfOuter(): Course {
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
  return makeCourse('turfOuter', 'turf', '芝・外回り', 28, 310, pts, [L, c2, c3, 0], R, (c) => turfElevation(310, c));
}

function buildDirt(): Course {
  const R = (1493 - 2 * STRAIGHT) / TAU; // 約110m（芝の内側）
  const pts = trace({ x: STRAIGHT / 2, z: R, h: Math.PI }, [{ line: STRAIGHT }, { r: R, angle: Math.PI }, { line: STRAIGHT }, { r: R, angle: Math.PI }]);
  pts.pop();
  const arc = Math.PI * R;
  // ダートの高低差 4.5m（区間ごとの形は芝と同じ傾向と仮定）
  return makeCourse('dirt', 'dirt', 'ダート', 22, 308, pts, [STRAIGHT, STRAIGHT + arc, 2 * STRAIGHT + arc, 0], R, (c) => turfElevation(308, c, 4.5 / 5.3));
}

/**
 * 外回りの標高を、内回りと同じ経路を通る区間（ホームストレッチ〜1・2コーナーの途中、3コーナーの途中〜ゴール）では
 * 内回りと完全に一致させる。外回りだけの区間は、自前の起伏の形を保ったまま両端で内回りにつながるよう補正する。
 * （一致させないと、共通区間で同じ場所なのに外回りの方が低くなり、馬が芝の面に沈んで見える）
 */
function alignOuterElevation(inner: Course, outer: Course): Course {
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
  // 外回りだけの区間：両端の差を線形に配分して、内回りの標高へなめらかにつなぐ
  let a = 0;
  while (a < n && shared[a]) a++;
  let b = a;
  while (b < n && !shared[b]) b++;
  if (a > 0 && b < n && b > a) {
    const da = innerE(innerU[a - 1]) - outer.es[a - 1];
    const db = innerE(innerU[b]) - outer.es[b];
    for (let i = a; i < b; i++) {
      const t = (i - a) / (b - a);
      es[i] = outer.es[i] + da + (db - da) * t;
    }
  }
  return { ...outer, es };
}

const TURF_INNER = buildTurfInner();
export const COURSES: Record<CourseId, Course> = {
  turf: TURF_INNER,
  turfOuter: alignOuterElevation(TURF_INNER, buildTurfOuter()),
  dirt: buildDirt(),
};

/** レース条件からコースを選ぶ（芝は layout で内回り/外回り） */
export function courseFor(surface: Surface, layout?: 'inner' | 'outer'): Course {
  if (surface === 'dirt') return COURSES.dirt;
  return layout === 'outer' ? COURSES.turfOuter : COURSES.turf;
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
  const x = c.xs[i0] + (c.xs[i1] - c.xs[i0]) * t + Math.sin(heading) * lane;
  const z = c.zs[i0] + (c.zs[i1] - c.zs[i0]) * t - Math.cos(heading) * lane;
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
export function courseBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of Object.values(COURSES)) {
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
