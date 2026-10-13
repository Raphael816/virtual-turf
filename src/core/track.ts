/**
 * 架空の「翠ヶ原競馬場」のコース形状。
 * 2本の直線と2つの半円からなる楕円（スタジアム型）で、左回り。
 * u = ホームストレッチ入口（4コーナー出口）からのラチ沿い距離。
 */

export type Surface = 'turf' | 'dirt';

export interface Course {
  surface: Surface;
  /** 直線の長さ (m) */
  straight: number;
  /** 内ラチの半径 (m) */
  radius: number;
  /** コース幅 (m) */
  width: number;
  /** 1周の距離 (m) */
  circumference: number;
  /** ゴール板の u 座標 */
  finishU: number;
}

export interface TrackPoint {
  x: number;
  z: number;
  /** 進行方向（ラジアン、+x 方向が 0、+z 方向が +π/2） */
  heading: number;
  onTurn: boolean;
}

function makeCourse(surface: Surface, radius: number, width: number): Course {
  const straight = 480;
  return {
    surface,
    straight,
    radius,
    width,
    circumference: 2 * straight + 2 * Math.PI * radius,
    finishU: straight - 100,
  };
}

export const COURSES: Record<Surface, Course> = {
  turf: makeCourse('turf', 150, 26),
  dirt: makeCourse('dirt', 120, 20),
};

const TAU = Math.PI * 2;

export function wrapU(c: Course, u: number): number {
  return ((u % c.circumference) + c.circumference) % c.circumference;
}

/** u と外ラチ方向へのオフセット lane(m) から平面座標を求める */
export function pointAt(c: Course, uRaw: number, lane: number): TrackPoint {
  const u = wrapU(c, uRaw);
  const L = c.straight;
  const R = c.radius + lane;
  const arc = Math.PI * c.radius;
  if (u < L) {
    return { x: -L / 2 + u, z: R, heading: 0, onTurn: false };
  }
  if (u < L + arc) {
    const phi = (u - L) / c.radius;
    return { x: L / 2 + R * Math.sin(phi), z: R * Math.cos(phi), heading: -phi, onTurn: true };
  }
  if (u < 2 * L + arc) {
    const t = u - L - arc;
    return { x: L / 2 - t, z: -R, heading: Math.PI, onTurn: false };
  }
  const phi = (u - 2 * L - arc) / c.radius;
  return {
    x: -L / 2 - R * Math.sin(phi),
    z: -R * Math.cos(phi),
    heading: (Math.PI - phi + TAU) % TAU,
    onTurn: true,
  };
}

export function isOnTurn(c: Course, uRaw: number): boolean {
  const u = wrapU(c, uRaw);
  const L = c.straight;
  const arc = Math.PI * c.radius;
  return (u >= L && u < L + arc) || u >= 2 * L + arc;
}

/** レース距離 distance のうち covered を走った時点の u 座標 */
export function raceU(c: Course, distance: number, covered: number): number {
  return wrapU(c, c.finishU - distance + covered);
}

/** 1〜4コーナーの u 座標（ゴール後に最初に入るコーナーが1角） */
export function cornerUs(c: Course): number[] {
  const L = c.straight;
  const arc = Math.PI * c.radius;
  return [L, L + arc, 2 * L + arc, 0];
}

/** スタートからゴールまでに通過するコーナー（covered 距離, コーナー番号）を順に返す。直近4つまで */
export function cornersOnRoute(c: Course, distance: number): { at: number; corner: number }[] {
  const start = raceU(c, distance, 0);
  const res: { at: number; corner: number }[] = [];
  const us = cornerUs(c);
  for (let lap = 0; lap < 3; lap++) {
    us.forEach((cu, i) => {
      const at = wrapU(c, cu - start) + lap * c.circumference;
      if (at > 50 && at < distance - 50) res.push({ at, corner: i + 1 });
    });
  }
  res.sort((a, b) => a.at - b.at);
  return res.slice(-4);
}
