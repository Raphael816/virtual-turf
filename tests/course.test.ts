import { describe, expect, it } from 'vitest';
import { type RaceConditions, type SimRunner, simulateRace } from '../src/core/sim';
import { COURSES, courseFor, elevationAt, pointAt } from '../src/core/track';
import { type Horse, HORSES } from '../src/data/roster';

/** 追加の能力・適性を外す（テストでは基本の能力から決まる値を使い、上書きした能力が効くようにする） */
function stripExtended(h: Horse): Horse {
  const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...rest } = h;
  return rest;
}

describe('中山を参考にしたコース（公式の数値との一致）', () => {
  it('1周の距離：芝内回り 1,667.1m・芝外回り 1,839.7m・ダート 1,493m', () => {
    expect(COURSES.turf.circumference).toBeCloseTo(1667.1, 0);
    expect(COURSES.turfOuter.circumference).toBeCloseTo(1839.7, 0);
    expect(COURSES.dirt.circumference).toBeCloseTo(1493, 0);
  });

  it('直線（4コーナー出口からゴールまで）：芝 310m・ダート 308m', () => {
    expect(COURSES.turf.finishU).toBe(310);
    expect(COURSES.turfOuter.finishU).toBe(310);
    expect(COURSES.dirt.finishU).toBe(308);
  });

  it('右回り（コーナーでは右へ曲がる＝曲率が正）', () => {
    for (const c of Object.values(COURSES)) {
      expect(pointAt(c, c.corners[0] + 50, 0).curvature).toBeGreaterThan(0); // 1コーナーの中
      expect(pointAt(c, c.corners[2] + 50, 0).curvature).toBeGreaterThan(0); // 3コーナーの中
    }
  });

  it('高低差：芝 約5.3m・ダート 約4.5m', () => {
    const diff = (c: (typeof COURSES)['turf']) => Math.max(...c.es) - Math.min(...c.es);
    expect(diff(COURSES.turf)).toBeCloseTo(5.3, 0);
    expect(diff(COURSES.dirt)).toBeCloseTo(4.5, 0);
  });

  it('ゴール前の上り坂：残り180m〜70mで約2.2m上る', () => {
    const c = COURSES.turf;
    const rise = elevationAt(c, c.finishU - 70) - elevationAt(c, c.finishU - 180);
    expect(rise).toBeGreaterThan(1.8);
    expect(rise).toBeLessThan(2.4);
  });

  it('外回りは、ホームストレッチと1コーナーで内回りと同じ経路を通る', () => {
    for (const u of [0, 150, 310, 390, 500]) {
      const a = pointAt(COURSES.turf, u, 0);
      const b = pointAt(COURSES.turfOuter, u, 0);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.5);
    }
    expect(courseFor('turf', 'outer')).toBe(COURSES.turfOuter);
    expect(courseFor('dirt', 'outer')).toBe(COURSES.dirt);
  });

  it('ダートは芝の内側にあり、ラチが重ならない', () => {
    const t = pointAt(COURSES.turf, 100, -0.5);
    const d = pointAt(COURSES.dirt, 100, COURSES.dirt.width + 0.5);
    expect(d.z).toBeLessThan(t.z);
  });
});

function horse(id: string, over: Partial<Horse> = {}): Horse {
  return { ...stripExtended(HORSES[0]), id, name: id, speed: 75, stamina: 75, accel: 75, start: 70, temper: 75, power: 70, style: 'senko', bestDistance: 2000, turf: 'B', dirt: 'B', heavy: 'B', ...over };
}

describe('起伏がレースに影響する', () => {
  const cond: RaceConditions = { surface: 'turf', layout: 'inner', distance: 2000, weather: 'sunny', going: 'good', timeOfDay: 'day' };

  it('ゴール前の坂（最後の200m）は、その前の200mより時計がかかりやすい', () => {
    const runners: SimRunner[] = Array.from({ length: 10 }, (_, i) => ({ horse: horse(`h${i}`), number: i + 1 }));
    let slower = 0;
    for (let s = 0; s < 40; s++) {
      const r = simulateRace(cond, runners, `hill${s}`, { record: false });
      const n = r.splits.length;
      if (r.splits[n - 1] > r.splits[n - 2] - 0.3) slower++;
    }
    expect(slower).toBeGreaterThan(25);
  });

  it('パワーのある馬は坂で失速しにくい（パワー以外が同じ馬どうしで比べる）', () => {
    const hs = Array.from({ length: 8 }, (_, i) => horse(`p${i}`));
    hs[0] = horse('strong', { power: 95 });
    hs[1] = horse('weak', { power: 40 });
    let ahead = 0;
    for (let s = 0; s < 240; s++) {
      const r = simulateRace(cond, hs.map((h, i) => ({ horse: h, number: i + 1 })), `pw${s}`, { record: false });
      if (r.order.indexOf(0) < r.order.indexOf(1)) ahead++;
    }
    expect(ahead / 240).toBeGreaterThan(0.55);
  });
});
