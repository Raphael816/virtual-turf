import { describe, expect, it } from 'vitest';
import { CLIMATE } from '../src/data/climate';
import {
  advanceTracks,
  cushionOf,
  dayWeather,
  dryMoisture,
  goingOf,
  initialTracks,
  raceDaySky,
  stepMoisture,
  wearOf,
} from '../src/core/weather';
import { type RaceConditions, simulateRace } from '../src/core/sim';
import { HORSES } from '../src/data/roster';
import { createMeeting } from '../src/core/meeting';
import { advanceWeek, createWorld } from '../src/core/world';

describe('馬場状態と含水率（JRA 公式の表）', () => {
  it('芝は競馬場ごと、ダートは全場共通の境目で決まる', () => {
    // 中山：良 13以下・稍重 11〜15 → 12% が境目
    expect(goingOf('turf', 'nakayama', 11.9)).toBe('good');
    expect(goingOf('turf', 'nakayama', 12.1)).toBe('yielding');
    // 東京は路盤の含水率が高い（良 19以下）
    expect(goingOf('turf', 'tokyo', 17.5)).toBe('good');
    expect(goingOf('turf', 'tokyo', 21)).toBe('soft');
    // 小倉は低い（良 10以下・不良 12以上）
    expect(goingOf('turf', 'kokura', 13.5)).toBe('heavy');
    // ダート：良 9以下・稍重 7〜13・重 11〜16・不良 14以上
    expect(['good', 'yielding', 'soft', 'heavy'].map((_, i) => goingOf('dirt', 'tokyo', [7.9, 8.1, 12.1, 15.1][i]))).toEqual(['good', 'yielding', 'soft', 'heavy']);
  });

  it('雨で含水率が上がり、晴れると乾く（乾いた状態より下がらない）。ダートは雨に敏感（同じ雨で馬場状態が変わりやすい）', () => {
    const t0 = dryMoisture('turf', 'nakayama');
    const d0 = dryMoisture('dirt', 'nakayama');
    const t1 = stepMoisture(t0, 'turf', 'nakayama', { mm: 20, temp: 15, sun: 0 });
    const d1 = stepMoisture(d0, 'dirt', 'nakayama', { mm: 20, temp: 15, sun: 0 });
    expect(goingOf('turf', 'nakayama', t1)).not.toBe('good');
    expect(goingOf('dirt', 'nakayama', d1)).not.toBe('good');
    const sunny = { mm: 0, temp: 20, sun: 0.8 };
    const t2 = stepMoisture(t1, 'turf', 'nakayama', sunny);
    const d2 = stepMoisture(d1, 'dirt', 'nakayama', sunny);
    expect(t2).toBeLessThan(t1);
    expect(d2).toBeLessThan(d1);
    expect(d1 - d0).toBeGreaterThan(t1 - t0);
    let t = t1;
    for (let i = 0; i < 30; i++) t = stepMoisture(t, 'turf', 'nakayama', sunny);
    expect(t).toBeGreaterThanOrEqual(t0);
    expect(t - t0).toBeLessThan(0.1);
  });
});

describe('天候（気象庁の平年値から）', () => {
  it('降水のある日の割合と月の降水量が、平年値に近い（東京の6月・1月）', () => {
    for (const [month, weeks] of [
      [6, [23, 24, 25, 26]],
      [1, [1, 2, 3, 4]],
    ] as const) {
      let rainy = 0;
      let mm = 0;
      let days = 0;
      for (let y = 2026; y < 2126; y++) {
        for (const w of weeks) {
          for (let d = 1; d <= 7; d++) {
            const x = dayWeather('tokyo', y, w, d);
            days++;
            if (x.mm > 0) rainy++;
            mm += x.mm;
          }
        }
      }
      const c = CLIMATE.tokyo[month - 1];
      expect(rainy / days).toBeGreaterThan((c.d1 / 30.4) * 0.85);
      expect(rainy / days).toBeLessThan((c.d1 / 30.4) * 1.15);
      expect((mm / days) * 30.4).toBeGreaterThan(c.prec * 0.8);
      expect((mm / days) * 30.4).toBeLessThan(c.prec * 1.25);
    }
  });
  it('寒い日の降水は雪になる（札幌の1月）', () => {
    let snow = 0;
    for (let y = 2026; y < 2066; y++) for (let d = 1; d <= 7; d++) if (['snow', 'lightsnow'].includes(dayWeather('sapporo', y, 2, d).kind)) snow++;
    expect(snow).toBeGreaterThan(40);
  });
});

describe('クッション値・開催日数・使用コース', () => {
  it('クッション値：洋芝は野芝より低く、湿っているほど低い', () => {
    expect(cushionOf('sapporo', 8, 12, 1, 0)).toBeLessThan(cushionOf('niigata', 8, 12, 1, 0));
    const dry = dryMoisture('turf', 'tokyo');
    expect(cushionOf('tokyo', 10, dry + 3, 1, 0)).toBeLessThan(cushionOf('tokyo', 10, dry, 1, 0) - 1);
  });
  it('続けて開催すると開催日数が進み、4日ごとにコースが替わる。5週より空くと新しい開催', () => {
    let s = initialTracks();
    const days: [number, number][] = [];
    for (let w = 1; w <= 10; w++) {
      s = advanceTracks(s, { year: 2026, week: w }, { year: 2026, week: w + 1 }, 'tokyo');
      days.push([s.tokyo.day, s.tokyo.rail]);
    }
    expect(days.map((d) => d[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(days.map((d) => d[1])).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
    expect(wearOf(s.tokyo)).toBeGreaterThan(0);
    s = advanceTracks(s, { year: 2026, week: 11 }, { year: 2026, week: 20 }, 'tokyo');
    expect([s.tokyo.day, s.tokyo.rail]).toEqual([1, 0]);
    expect(wearOf(s.tokyo)).toBe(0);
  });
  it('開催日：レースごとの馬場状態は含水率と一致し、雨の日は朝より湿る', () => {
    const st = { ...initialTracks().tokyo, day: 1, rail: 0, railDay: 1 };
    for (let w = 1; w <= 52; w++) {
      const sky = raceDaySky(st, 'tokyo', { year: 2027, week: w }, 8, `t${w}`);
      for (const r of sky) {
        expect(r.turfGoing).toBe(goingOf('turf', 'tokyo', r.turf));
        expect(r.dirtGoing).toBe(goingOf('dirt', 'tokyo', r.dirt));
      }
      if (dayWeather('tokyo', 2027, w, 7).mm > 10) expect(Math.max(...sky.map((r) => r.dirt))).toBeGreaterThan(st.dirt + 2);
    }
  });
});

describe('馬場がレースに与える影響', () => {
  const base = (over: Partial<RaceConditions>): RaceConditions => ({ surface: 'turf', distance: 2000, weather: 'sunny', going: 'good', timeOfDay: 'day', ...over });
  const runners = HORSES.slice(0, 10).map((h, i) => ({ horse: h, number: i + 1, weight: 56 }));
  const avgWin = (c: RaceConditions) => {
    let t = 0;
    for (let s = 0; s < 40; s++) {
      const r = simulateRace(c, runners, `c${s}`, { record: false });
      t += r.finishTimes[r.order[0]];
    }
    return t / 40;
  };
  it('クッション値が高い（硬い）芝ほど時計が速い', () => {
    expect(avgWin(base({ cushion: 11 }))).toBeLessThan(avgWin(base({ cushion: 8 })) - 0.5);
  });
  it('芝は重いほど遅く、ダートは湿ると速くなる', () => {
    expect(avgWin(base({ going: 'heavy' }))).toBeGreaterThan(avgWin(base({ going: 'good' })) + 2);
    expect(avgWin(base({ surface: 'dirt', distance: 1800, going: 'soft' }))).toBeLessThan(avgWin(base({ surface: 'dirt', distance: 1800, going: 'good' })));
  });
});

describe('競馬界の開催', () => {
  it('出馬表の馬場状態は、そのレースの芝・ダートの含水率から決まり、週をまたいで含水率が続く', async () => {
    let w = createWorld();
    for (let i = 0; i < 8; i++) {
      w = advanceWeek(w);
      const cards = await createMeeting(`WX${i}`, () => 's', w);
      for (const c of cards) {
        const k = c.conditions;
        expect(k.going).toBe(k.surface === 'turf' ? k.turfGoing : k.dirtGoing);
        expect(k.moisture).toBeDefined();
        expect(k.cushion).toBeGreaterThan(5);
      }
    }
    expect(Object.values(w.tracks).some((t) => t.turf > dryMoisture('turf', 'tokyo') - 10)).toBe(true);
  });
});
