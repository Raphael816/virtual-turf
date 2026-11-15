import { describe, expect, it } from 'vitest';
import { JOCKEY_LIST, SKILL_KEYS, type Skills, allowanceOf, chemistry, makeRide, rating, rideBonus } from '../src/core/jockey';
import { createMeeting, runRace } from '../src/core/meeting';
import { resultForWorld } from '../src/core/raceflow';
import { type RaceConditions, simulateRace } from '../src/core/sim';
import { advanceWeek, createWorld, recordRace } from '../src/core/world';
import { type Horse, HORSES } from '../src/data/roster';

describe('減量（JRA 公式の表）', () => {
  it('男性の見習騎手：30勝以下 3kg、31〜50勝 2kg、51〜100勝 1kg。見習でなければなし', () => {
    expect(allowanceOf('男', 1, 30, false, false)).toEqual({ kg: 3, mark: '▲' });
    expect(allowanceOf('男', 2, 31, false, false)).toEqual({ kg: 2, mark: '△' });
    expect(allowanceOf('男', 3, 51, false, false)).toEqual({ kg: 1, mark: '☆' });
    expect(allowanceOf('男', 3, 101, false, false).kg).toBe(0);
    expect(allowanceOf('男', 8, 20, false, false).kg).toBe(0);
  });
  it('女性騎手：見習で50勝以下 4kg、51〜100勝 3kg、見習でなければ 2kg', () => {
    expect(allowanceOf('女', 1, 50, false, false)).toEqual({ kg: 4, mark: '★' });
    expect(allowanceOf('女', 2, 51, false, false)).toEqual({ kg: 3, mark: '◆' });
    expect(allowanceOf('女', 9, 400, false, false)).toEqual({ kg: 2, mark: '◇' });
  });
  it('特別競走・ハンデキャップ競走では減量なし', () => {
    expect(allowanceOf('女', 1, 5, true, false).kg).toBe(0);
    expect(allowanceOf('男', 1, 5, false, true).kg).toBe(0);
  });
});

describe('騎手の技術・適性・相性', () => {
  it('騎手ごとに8つの技術があり、技術はばらつく（1つの数値ではない）', () => {
    expect(JOCKEY_LIST.length).toBeGreaterThanOrEqual(24);
    for (const j of JOCKEY_LIST) {
      for (const k of SKILL_KEYS) {
        expect(j.skills[k]).toBeGreaterThanOrEqual(35);
        expect(j.skills[k]).toBeLessThanOrEqual(97);
      }
      expect(Math.max(...SKILL_KEYS.map((k) => j.skills[k])) - Math.min(...SKILL_KEYS.map((k) => j.skills[k]))).toBeGreaterThan(3);
      expect(j.venues).toHaveLength(2);
    }
    expect(new Set(JOCKEY_LIST.map((j) => j.name)).size).toBe(JOCKEY_LIST.length);
  });
  it('得意な競馬場・距離・芝ダートと、馬との相性・乗り慣れで、その日の技術が上下する', () => {
    const j = JOCKEY_LIST[0];
    const base = { surface: 'turf' as const, distance: 1600, horseId: 'hx', horseStyle: 'senko' as const, ridesTogether: 0 };
    const home = rideBonus(j, { ...base, venue: j.venues[0] });
    const away = rideBonus(j, { ...base, venue: undefined });
    expect(home.venue).toBe(4);
    expect(home.total - away.total).toBe(4);
    expect(rideBonus(j, { ...base, ridesTogether: 5 }).familiar).toBe(3);
    // 相性は組み合わせごとに一定で、馬によって違う
    expect(chemistry('a', j.id)).toBe(chemistry('a', j.id));
    const cs = Array.from({ length: 30 }, (_, i) => chemistry(`h${i}`, j.id));
    expect(Math.max(...cs)).toBeGreaterThan(0.3);
    expect(Math.min(...cs)).toBeLessThan(-0.3);
    const r = makeRide(j, { ...base, venue: j.venues[0] }, { kg: 0, mark: '' });
    expect(r.skills.start).toBeGreaterThan(0.2);
    expect(r.skills.start).toBeLessThanOrEqual(1);
  });
});

function plain(id: string, style: Horse['style']): Horse {
  const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...rest } = HORSES[0];
  return { ...rest, id, name: id, speed: 75, stamina: 75, accel: 75, start: 70, temper: 65, power: 70, style, bestDistance: 1800, turf: 'B', dirt: 'B', heavy: 'B' };
}
const sk = (v: number, over: Partial<Skills> = {}): Skills => ({ ...(Object.fromEntries(SKILL_KEYS.map((k) => [k, v])) as Skills), ...over });
const COND: RaceConditions = { surface: 'turf', distance: 1800, weather: 'sunny', going: 'good', timeOfDay: 'day' };
const STYLES: Horse['style'][] = ['senko', 'sashi', 'nige', 'oikomi', 'senko', 'sashi', 'senko', 'sashi', 'oikomi', 'senko'];

/** 同じ能力の10頭で、騎手 a と b を毎回ちがう枠に置いて比べる */
function duel(a: Skills, b: Skills, n: number, over: Partial<Horse> = {}) {
  let ahead = 0;
  let gap = 0;
  const flags = { kakariA: 0, kakariB: 0, lateA: 0, lateB: 0, lossA: 0, lossB: 0 };
  for (let s = 0; s < n; s++) {
    const ia = s % 10;
    const ib0 = (s * 3 + 5) % 10;
    const ib = ib0 === ia ? (ia + 1) % 10 : ib0;
    const runners = STYLES.map((st, i) => ({ horse: { ...plain(`h${i}`, st), ...over }, number: i + 1, weight: 56, rider: i === ia ? a : i === ib ? b : sk(0.72) }));
    const r = simulateRace(COND, runners, `jd${s}`, { record: false, dt: 0.2 });
    if (r.order.indexOf(ia) < r.order.indexOf(ib)) ahead++;
    gap += ((r.finishTimes[ib] - r.finishTimes[ia]) * 16.5) / 2.4;
    flags.kakariA += r.factors[ia].kakari ? 1 : 0;
    flags.kakariB += r.factors[ib].kakari ? 1 : 0;
    flags.lateA += r.factors[ia].lateStart ? 1 : 0;
    flags.lateB += r.factors[ib].lateStart ? 1 : 0;
    flags.lossA += r.factors[ia].laneLoss;
    flags.lossB += r.factors[ib].laneLoss;
  }
  return { beat: ahead / n, gap: gap / n, ...flags };
}

describe('騎手がレースに与える影響', () => {
  it('上手な騎手は先着しやすいが、馬の能力を覆すほどではない（同じ馬で最上位と最下位の差が3馬身未満）', () => {
    const r = duel(sk(0.9), sk(0.55), 500);
    expect(r.beat).toBeGreaterThan(0.56);
    expect(r.beat).toBeLessThan(0.8);
    expect(r.gap).toBeGreaterThan(0.5);
    expect(r.gap).toBeLessThan(3);
  });
  it('技術は別々の場面に効く：折り合い→掛かり、スタート→出遅れ、コーナリング→外を回る距離損', () => {
    const settle = duel(sk(0.72, { settle: 0.95 }), sk(0.72, { settle: 0.5 }), 400, { temper: 50 });
    expect(settle.kakariA).toBeLessThan(settle.kakariB);
    const start = duel(sk(0.72, { start: 0.95 }), sk(0.72, { start: 0.5 }), 600, { start: 55 });
    expect(start.lateA).toBeLessThan(start.lateB);
    const corner = duel(sk(0.72, { corner: 0.95 }), sk(0.72, { corner: 0.5 }), 300);
    expect(corner.lossA).toBeLessThan(corner.lossB);
  });
  it('能力の高い馬に下手な騎手が乗っても、能力の低い馬に上手な騎手が乗るより先着しやすい', () => {
    let ahead = 0;
    const N = 300;
    for (let s = 0; s < N; s++) {
      const runners = STYLES.map((st, i) => ({
        horse: i === 3 ? { ...plain('good', 'senko'), speed: 84, accel: 82 } : i === 6 ? { ...plain('weak', 'senko'), speed: 70, accel: 70 } : plain(`h${i}`, st),
        number: i + 1,
        weight: 56,
        rider: i === 3 ? sk(0.55) : i === 6 ? sk(0.92) : sk(0.72),
      }));
      const r = simulateRace(COND, runners, `ab${s}`, { record: false, dt: 0.2 });
      if (r.order.indexOf(3) < r.order.indexOf(6)) ahead++;
    }
    expect(ahead / N).toBeGreaterThan(0.6);
  });
});

describe('競馬界での騎手', () => {
  it('出走表：1レースに同じ騎手は1頭だけ、一般競走では減量が負担重量から引かれ、特別競走では引かれない', async () => {
    let w = createWorld();
    w = advanceWeek(w);
    const cards = await createMeeting('JK1', () => 's', w);
    let reduced = 0;
    for (const c of cards) {
      const ids = c.entries.map((e) => e.ride!.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of c.entries) {
        if (c.terms!.special || c.terms!.rule === 'handicap') expect(e.ride!.allowance).toBe(0);
        if (e.ride!.allowance > 0) reduced++;
      }
    }
    expect(reduced).toBeGreaterThan(0);
  });
  it('有力な馬には上位の騎手が乗りやすく、騎手の成績が記録される', async () => {
    let w = createWorld();
    let top = 0;
    let rest = 0;
    let nTop = 0;
    let nRest = 0;
    for (let i = 0; i < 6; i++) {
      w = advanceWeek(w);
      for (const c of await createMeeting(`JK2-${i}`, () => 's', w)) {
        const str = c.entries.map((e) => e.horse!.speed * 0.4 + e.horse!.accel * 0.25 + e.horse!.stamina * 0.2 + e.horse!.power * 0.15);
        const order = str.map((_, k) => k).sort((a, b) => str[b] - str[a]);
        order.forEach((k, rank) => {
          const rt = rating(JOCKEY_LIST.find((j) => j.id === c.entries[k].ride!.id)!);
          if (rank < 3) {
            top += rt;
            nTop++;
          } else if (rank >= order.length - 3) {
            rest += rt;
            nRest++;
          }
        });
        w = recordRace(w, resultForWorld(c, runRace(c, 's', { record: false })));
      }
    }
    expect(top / nTop).toBeGreaterThan(rest / nRest + 2);
    const total = Object.values(w.jockeys).reduce((a, j) => a + j.rides, 0);
    const wins = Object.values(w.jockeys).reduce((a, j) => a + j.wins, 0);
    expect(total).toBeGreaterThan(300);
    expect(wins).toBeGreaterThanOrEqual(40);
  });
});
