import { describe, expect, it } from 'vitest';
import { Rng, sha256Hex } from '../src/core/rng';
import { COURSES, cornersOnRoute, pointAt, raceU } from '../src/core/track';
import { HORSES } from '../src/data/roster';

describe('Rng', () => {
  it('同じシードから同じ系列を生成する', () => {
    const a = new Rng('race-1:seed');
    const b = new Rng('race-1:seed');
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });
  it('異なるシードでは系列が異なる', () => {
    expect(new Rng('a').next()).not.toBe(new Rng('b').next());
  });
  it('SHA-256 を計算できる', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('track', () => {
  const turf = COURSES.turf;
  it('コースは閉じている（1周で同じ点に戻る）', () => {
    const p0 = pointAt(turf, 10, 0);
    const p1 = pointAt(turf, 10 + turf.circumference, 0);
    expect(p1.x).toBeCloseTo(p0.x);
    expect(p1.z).toBeCloseTo(p0.z);
  });
  it('区間の境目で座標が連続している', () => {
    for (let u = 0; u < turf.circumference; u += 1) {
      const a = pointAt(turf, u, 3);
      const b = pointAt(turf, u + 0.5, 3);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.6);
    }
  });
  it('ゴール時点の u はゴール板の位置', () => {
    expect(raceU(turf, 1600, 1600)).toBeCloseTo(turf.finishU);
  });
  it('通過コーナーは最大4つで、距離の昇順', () => {
    const cs = cornersOnRoute(turf, 2400);
    expect(cs.length).toBeLessThanOrEqual(4);
    expect(cs.map((c) => c.at)).toEqual([...cs.map((c) => c.at)].sort((x, y) => x - y));
  });
});

describe('roster', () => {
  it('馬IDが一意', () => {
    expect(new Set(HORSES.map((h) => h.id)).size).toBe(HORSES.length);
  });
});
