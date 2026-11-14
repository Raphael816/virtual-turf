import { describe, expect, it } from 'vitest';
import { type Aptitudes, distanceFit, distanceMark, gradeOf, profileOf, raceAbility } from '../src/core/ability';
import { type RaceConditions, simulateRace } from '../src/core/sim';
import { COURSES } from '../src/core/track';

const HAND = COURSES.turf.hand;
import { type Horse, HORSES } from '../src/data/roster';

/** 平均的な馬（追加の能力・適性もすべて平均）。over で一部だけ変える */
function horse(id: string, over: Partial<Horse> = {}, apt: Partial<Aptitudes> = {}): Horse {
  const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...base } = HORSES[0];
  return {
    ...base,
    id,
    name: id,
    speed: 75,
    stamina: 75,
    accel: 75,
    start: 70,
    temper: 75,
    power: 70,
    style: 'senko',
    bestDistance: 1600,
    turf: 'B',
    dirt: 'B',
    heavy: 'B',
    sustain: 75,
    control: 75,
    health: 65,
    apt: { right: 60, left: 60, slope: 50, tight: 50, longStraight: 50, heat: 50, cold: 50, ...apt },
    ...over,
  };
}
const MILE: RaceConditions = { surface: 'turf', distance: 1600, weather: 'sunny', going: 'good', timeOfDay: 'day' };

/** 対象（0番）が比較（1番）に先着する割合。残りは平均的な馬。脚質は混ぜる */
function beatRate(target: Horse, rival: Horse, cond: RaceConditions = MILE, trials = 400): number {
  const styles = ['nige', 'senko', 'sashi', 'oikomi', 'senko', 'sashi'] as const;
  const others = styles.map((st, i) => horse(`o${i}`, { style: st }));
  const runners = [target, rival, ...others].map((h, i) => ({ horse: h, number: i + 1 }));
  let ahead = 0;
  for (let s = 0; s < trials; s++) {
    const r = simulateRace(cond, runners, `ab${s}`, { record: false, dt: 0.2 });
    if (r.order.indexOf(0) < r.order.indexOf(1)) ahead++;
  }
  return ahead / trials;
}

describe('能力がレース結果に効く（他の条件が同じ馬どうしで比べる）', () => {
  const cases: [string, Partial<Horse>, RaceConditions?][] = [
    ['スピード', { speed: 88 }],
    ['スタミナ（2400m）', { stamina: 90 }, { ...MILE, distance: 2400 }],
    ['瞬発力', { accel: 90 }],
    ['持続力', { sustain: 92 }],
    ['パワー（重馬場）', { power: 90 }, { ...MILE, going: 'heavy', weather: 'rain' }],
    ['ゲート', { start: 92 }],
  ];
  for (const [label, over, cond] of cases) {
    it(`${label}が高い馬は先着しやすい（ただし必ずではない）`, () => {
      const r = beatRate(horse('t', over), horse('c'), cond ?? MILE);
      expect(r).toBeGreaterThan(0.56);
      expect(r).toBeLessThan(1);
    });
  }
  it('気性・操縦性：掛かりやすい馬（気性45）は落ち着いた馬に先着されやすい', () => {
    {
      const r = beatRate(horse('t', { temper: 90, control: 90 }), horse('c', { temper: 45, control: 45 }));
      expect(r).toBeGreaterThan(0.56);
      expect(r).toBeLessThan(1);
    }
  });
  it('スタミナの差は長距離ほど大きく効き、短距離では小さい', () => {
    const long = beatRate(horse('t', { stamina: 92, bestDistance: 1800 }), horse('c', { bestDistance: 1800 }), { ...MILE, distance: 2400 });
    const short = beatRate(horse('t', { stamina: 92, bestDistance: 1800 }), horse('c', { bestDistance: 1800 }), { ...MILE, distance: 1200 });
    expect(long).toBeGreaterThan(short + 0.05);
  });
  it('スピードの差は短距離ほど大きく効く', () => {
    const short = beatRate(horse('t', { speed: 85, bestDistance: 1600 }), horse('c', { bestDistance: 1600 }), { ...MILE, distance: 1200 });
    const long = beatRate(horse('t', { speed: 85, bestDistance: 1600 }), horse('c', { bestDistance: 1600 }), { ...MILE, distance: 2400 });
    expect(short).toBeGreaterThan(long);
  });
});

describe('適性', () => {
  it('距離適性：中心距離から離れるほど発揮が落ち、適性の幅が広い馬は離れた距離でも力を出せる', () => {
    const wide = { center: 1600, short: 500, long: 600 };
    const narrow = { center: 1600, short: 200, long: 200 };
    expect(distanceFit(wide, 1600)).toBeCloseTo(1);
    expect(distanceFit(wide, 2000)).toBeGreaterThan(distanceFit(narrow, 2000));
    expect(distanceFit(narrow, 2400)).toBeLessThan(distanceFit(narrow, 2000));
    expect(distanceMark(wide, 2000)).toBe('○');
    expect(distanceMark(narrow, 2400)).toBe('×');
    const r = beatRate(horse('wide', {}, { distance: wide }), horse('narrow', {}, { distance: narrow }), { ...MILE, distance: 2000 });
    expect(r).toBeGreaterThan(0.6);
  });
  it('芝・ダート：ダート適性の高い馬はダートで先着しやすい', () => {
    const cond = { ...MILE, surface: 'dirt' as const, distance: 1800 };
    expect(beatRate(horse('t', {}, { dirt: 85 }), horse('c', {}, { dirt: 45 }), cond)).toBeGreaterThan(0.65);
  });
  it('馬場：重馬場では道悪の得意な馬が、良馬場より大きく有利', () => {
    const heavy = beatRate(horse('t', {}, { going: 85 }), horse('c', {}, { going: 30 }), { ...MILE, going: 'heavy', weather: 'rain' });
    const good = beatRate(horse('t', {}, { going: 85 }), horse('c', {}, { going: 30 }));
    expect(heavy).toBeGreaterThan(good + 0.1);
  });
  it('回り：今のコースの回り方向が得意な馬が先着しやすい', () => {
    const fit = HAND > 0 ? { right: 90, left: 40 } : { left: 90, right: 40 };
    const unfit = HAND > 0 ? { right: 40, left: 90 } : { left: 40, right: 90 };
    expect(beatRate(horse('t', {}, fit), horse('c', {}, unfit))).toBeGreaterThan(0.6);
  });
  it('坂：ゴール前に坂のあるコースでは、坂の得意な馬が先着しやすい', () => {
    expect(beatRate(horse('t', {}, { slope: 90 }), horse('c', {}, { slope: 15 }))).toBeGreaterThan(0.55);
  });
  it('小回り：コーナーのきついコースでは、小回りの得意な馬が先着しやすい', () => {
    expect(beatRate(horse('t', {}, { tight: 95 }), horse('c', {}, { tight: 10 }))).toBeGreaterThan(0.55);
  });
  it('季節：暑さに弱い馬は真夏に力を落とす', () => {
    const summer = beatRate(horse('t', {}, { heat: 90 }), horse('c', {}, { heat: 10 }), { ...MILE, month: 8 });
    const spring = beatRate(horse('t', {}, { heat: 90 }), horse('c', {}, { heat: 10 }), { ...MILE, month: 4 });
    expect(summer).toBeGreaterThan(spring + 0.05);
  });
  it('段階評価：数値の適性から A〜D を求める', () => {
    expect([gradeOf(85), gradeOf(65), gradeOf(45), gradeOf(25)]).toEqual(['A', 'B', 'C', 'D']);
  });
  it('追加の能力がない馬（古い保存データ）でも、既存の能力から能力・適性がそろう', () => {
    const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...legacy } = HORSES[0];
    const p = profileOf(legacy);
    expect(p.sustain).toBe(Math.round((legacy.stamina + legacy.accel) / 2));
    expect(p.apt.distance.center).toBe(legacy.bestDistance);
    const ab = raceAbility(p, { surface: 'turf', distance: 1600, goingIndex: 0, course: { hand: 1, straight: 310, turnRadius: 138, finalHill: 2.2 } });
    expect(Number.isFinite(ab.speedAdj)).toBe(true);
  });
});

describe('脚質と展開（能力が同じ12頭で集計）', () => {
  const field = (nige: number, D = 1600) =>
    Array.from({ length: 12 }, (_, i) => horse(`s${i}`, { bestDistance: D, style: i < nige ? 'nige' : i < 6 ? 'senko' : i < 9 ? 'sashi' : 'oikomi' }));
  const tally = (nige: number, D = 1600, trials = 240) => {
    const hs = field(nige, D);
    const win: Record<string, number> = { nige: 0, senko: 0, sashi: 0, oikomi: 0 };
    let pace = 0;
    for (let s = 0; s < trials; s++) {
      // 第8段階：枠の有利不利が混ざらないよう、毎回枠を回す（脚質ごとに外枠に偏らせない）
      const runners = hs.map((h, i) => ({ horse: h, number: ((i + s) % hs.length) + 1 })).sort((a, b) => a.number - b.number);
      const r = simulateRace({ ...MILE, distance: D }, runners, `st${s}`, { record: false });
      win[runners[r.order[0]].horse.style]++;
      // 第8段階：ペースは前半と後半のタイムの差（halfDiff。大きいほど前半が速い）
      pace += r.halfDiff;
    }
    for (const k of Object.keys(win)) win[k] /= trials;
    return { win, pace: pace / trials };
  };
  const one = tally(1);
  const four = tally(4);
  it('どの脚質も勝ち、特定の脚質だけが極端に有利にならない（逃げ1頭のマイル）', () => {
    for (const k of ['nige', 'senko', 'sashi', 'oikomi']) expect(one.win[k]).toBeGreaterThan(0.05);
    for (const k of ['nige', 'senko', 'sashi', 'oikomi']) expect(one.win[k]).toBeLessThan(0.6);
  });
  it('逃げ馬が多いと前半が速くなり、逃げ馬は共倒れになりやすく、差し・追込が台頭する', () => {
    expect(four.pace).toBeGreaterThan(one.pace + 0.003);
    expect(four.win.nige / 4).toBeLessThan(one.win.nige);
    expect(four.win.sashi + four.win.oikomi).toBeGreaterThan(one.win.sashi + one.win.oikomi);
  });
  it('逃げ馬がいないときは、先行馬が押し出されて先頭に立ち、ペースが落ちる', () => {
    const none = tally(0, 1600, 120);
    expect(none.pace).toBeLessThan(one.pace);
    const hs = field(0);
    const r = simulateRace(MILE, hs.map((h, i) => ({ horse: h, number: i + 1 })), 'nonige', { record: false });
    const leader = r.factors.findIndex((f) => f.actualStyle === 'nige');
    expect(hs[leader].style).toBe('senko');
  });
  it('脚質は目安で、ゲートの速い差し馬は遅い差し馬より前で運ぶ', () => {
    const others = Array.from({ length: 8 }, (_, i) => horse(`m${i}`, { style: i % 2 ? 'senko' : 'sashi' }));
    const fast = horse('fast', { style: 'sashi', start: 95, accel: 90 });
    const slow = horse('slow', { style: 'sashi', start: 45, accel: 60 });
    let forward = 0;
    for (let s = 0; s < 80; s++) {
      const r = simulateRace(MILE, [fast, slow, ...others].map((h, i) => ({ horse: h, number: i + 1 })), `pos${s}`, { record: false });
      const c = r.cornerOrders[0].order;
      if (c.indexOf(0) < c.indexOf(1)) forward++;
    }
    expect(forward / 80).toBeGreaterThan(0.75);
  });
});
