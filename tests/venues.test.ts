import { describe, expect, it } from 'vitest';
import { type Course, courseFor, courseTraits, elevationAt, pointAt, venueCourses } from '../src/core/track';
import { VENUES, VENUE_IDS } from '../src/data/venues';

function polygon(c: Course, lane: number) {
  const pts: { x: number; z: number }[] = [];
  for (let u = 0; u < c.circumference; u += 4) {
    const p = pointAt(c, u, lane);
    pts.push({ x: p.x, z: p.z });
  }
  return pts;
}
function inside(poly: { x: number; z: number }[], x: number, z: number): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) r = !r;
  }
  return r;
}
function range(c: Course) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of c.es) {
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
  }
  return hi - lo;
}

describe('JRA 10場のコース（公式の値）', () => {
  for (const id of VENUE_IDS) {
    const v = VENUES[id];
    it(`${v.name}：回り・1周距離・直線距離・高低差が公式の値`, () => {
      const cs = venueCourses(id);
      const specs = [
        [cs.turf, v.turf],
        [cs.dirt, v.dirt],
        ...(v.outer ? [[cs.turfOuter, v.outer] as const] : []),
      ] as const;
      for (const [c, spec] of specs) {
        expect(c.hand).toBe(v.hand);
        expect(Math.abs(c.circumference - spec.circumference)).toBeLessThan(spec.circumference * 0.003);
        // 直線距離は公式の値（京都の外回りだけは形の都合で短い。docs/11-venues.md）
        if (!(id === 'kyoto' && c.id === 'turfOuter')) expect(c.finishU).toBe(spec.straight);
        else expect(c.finishU).toBeGreaterThan(375);
        // 経路が閉じている（終点から始点へなめらかにつながる）
        const a = pointAt(c, c.circumference - 0.5, 0);
        const b = pointAt(c, 0, 0);
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1.5);
      }
      // 起伏：内回り・ダートは高低差が公式の値（外回りは内回りとの共通区間に合わせるため ±0.6m）
      expect(Math.abs(range(cs.turf) - v.turf.elevation)).toBeLessThan(0.15);
      expect(Math.abs(range(cs.dirt) - v.dirt.elevation)).toBeLessThan(0.15);
      if (v.outer) expect(Math.abs(range(cs.turfOuter) - v.outer.elevation)).toBeLessThan(0.6);
      expect(courseTraits(cs.turf).hand).toBe(v.hand);
    });

    it(`${v.name}：ダートは芝の内側、外回りは内回りの外側を通る`, () => {
      const cs = venueCourses(id);
      const turfInner = polygon(cs.turf, -0.5);
      for (let u = 0; u < cs.dirt.circumference; u += 10) {
        const p = pointAt(cs.dirt, u, cs.dirt.width);
        expect(inside(turfInner, p.x, p.z)).toBe(true);
      }
      if (v.outer) {
        const innerCore = polygon(cs.turf, -1);
        for (let u = 0; u < cs.turfOuter.circumference; u += 10) {
          const p = pointAt(cs.turfOuter, u, 0);
          expect(inside(innerCore, p.x, p.z)).toBe(false);
        }
      }
    });
  }

  it('回り：東京・新潟・中京は左回り、それ以外は右回り（公式）', () => {
    const left = VENUE_IDS.filter((id) => VENUES[id].hand < 0).sort();
    expect(left).toEqual(['chukyo', 'niigata', 'tokyo']);
  });

  it('坂の位置：中山はゴール前（残り180〜70m）に約2.2mの上り、京都は3コーナーの丘、東京は残り460〜300mに上り', () => {
    const nk = courseFor('turf', 'inner', 'nakayama');
    expect(elevationAt(nk, nk.finishU - 70) - elevationAt(nk, nk.finishU - 180)).toBeGreaterThan(1.8);
    const ky = courseFor('turf', 'outer', 'kyoto');
    let top = 0;
    for (let u = ky.corners[2]; u < ky.circumference; u += 5) top = Math.max(top, elevationAt(ky, u));
    expect(top).toBeGreaterThan(elevationAt(ky, ky.finishU) + 3);
    const tk = courseFor('turf', undefined, 'tokyo');
    expect(elevationAt(tk, tk.finishU - 300) - elevationAt(tk, tk.finishU - 460)).toBeGreaterThan(1.4);
    // 直線の長さ：東京・新潟外回りは長く、函館・札幌は短い
    expect(courseTraits(courseFor('turf', 'outer', 'niigata')).straight).toBeGreaterThan(600);
    expect(courseTraits(courseFor('turf', undefined, 'hakodate')).straight).toBeLessThan(270);
  });

  it('発走距離はすべて、その場のコースで走れる（外回り・内回りの指定はその場にある）', () => {
    for (const id of VENUE_IDS) {
      const v = VENUES[id];
      for (const t of v.distances.turf) {
        if (t.layout === 'outer') expect(v.outer).toBeDefined();
        expect(t.d).toBeGreaterThanOrEqual(1000);
        expect(t.d).toBeLessThanOrEqual(3600);
      }
      expect(v.distances.dirt.length).toBeGreaterThan(2);
    }
  });
});

describe('開催場と番組', () => {
  it('週ごとに1場で開催し、距離はその場の公式の発走距離から選ぶ。重賞の週は重賞の場', async () => {
    const { createWorld, advanceWeek } = await import('../src/core/world');
    const { createMeeting } = await import('../src/core/meeting');
    const { venueOfWeek, STAKES } = await import('../src/core/program');
    let w = createWorld();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      w = advanceWeek(w);
      const cards = await createMeeting(`VM${i}`, () => 's', w);
      const venue = venueOfWeek(w.date.week);
      seen.add(venue);
      for (const c of cards) {
        expect(c.conditions.venue).toBe(venue);
        const v = VENUES[venue];
        if (c.conditions.surface === 'dirt') expect(v.distances.dirt).toContain(c.conditions.distance);
        else expect(v.distances.turf.some((t) => t.d === c.conditions.distance && (t.layout ?? 'inner') === (c.conditions.layout ?? 'inner'))).toBe(true);
        // JRA の平地競走は日中（夏の新潟の最終レースだけ薄暮）
        expect(c.conditions.timeOfDay).not.toBe('night');
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const s of STAKES) {
      expect(venueOfWeek(s.week)).toBe(s.venue);
      const v = VENUES[s.venue];
      if (s.surface === 'dirt') expect(v.distances.dirt).toContain(s.distance);
      else expect(v.distances.turf.some((t) => t.d === s.distance && (t.layout ?? 'inner') === (s.layout ?? 'inner'))).toBe(true);
    }
  });
});
