import { describe, expect, it } from 'vitest';
import { profileOf, raceAbility } from '../src/core/ability';
import { afterRace, bioAge, conditionOf, currentAbilities, initLife, injuryRisk, maturity, retireProbability, weeklyRecovery, type Life } from '../src/core/lifecycle';
import { runUnwatchedMeeting } from '../src/core/raceflow';
import { type RaceConditions, simulateRace } from '../src/core/sim';
import { migrate } from '../src/core/storage';
import { createInitialState } from '../src/core/state';
import { DEBUT_WEEK, FATIGUE_LIMIT, TARGET_ACTIVE, advanceWeek, ageOf, createWorld, eligibleHorses, upgradeWorld, type World } from '../src/core/world';
import { type Horse, HORSES } from '../src/data/roster';

const base: Horse = HORSES[0];
const life = (over: Partial<Life> = {}): Life => ({ ...initLife(base, 4, 'test'), fatigue: 0, mental: 0, layoff: 0, ...over });

describe('成長曲線', () => {
  it('早熟は3歳でほぼ完成し、晩成は3歳ではまだ伸びしろが大きく、古馬（5〜6歳）でピークを迎える', () => {
    expect(maturity('early', 60, 2.8, 'speed')).toBeGreaterThan(0.98);
    expect(maturity('late', 60, 2.8, 'speed')).toBeLessThan(0.93);
    expect(maturity('late', 60, 5.5, 'speed')).toBe(1);
    expect(maturity('late', 60, 5.5, 'speed')).toBeGreaterThan(maturity('late', 60, 3.0, 'speed'));
  });
  it('ピーク後は衰え、スピードはスタミナより先に落ちる', () => {
    expect(maturity('early', 60, 6.5, 'speed')).toBeLessThan(maturity('early', 60, 4, 'speed'));
    expect(maturity('normal', 60, 8, 'speed')).toBeLessThan(maturity('normal', 60, 8, 'stamina'));
  });
  it('成長力が高い馬ほど、若いうちと完成時の差（伸びしろ）が大きい', () => {
    expect(maturity('normal', 90, 1.8, 'speed')).toBeLessThan(maturity('normal', 30, 1.8, 'speed'));
  });
  it('現在の能力は上限を超えない', () => {
    const l = life();
    for (const age of [1.8, 3, 4.5, 6, 8]) {
      const c = currentAbilities(base, l, age);
      for (const k of ['speed', 'stamina', 'accel', 'sustain', 'power'] as const) expect(c[k]).toBeLessThanOrEqual(Math.max(l.pot[k], 20));
    }
  });
  it('競馬界で年を重ねると、晩成馬の能力は古馬になって伸び、高齢の馬は衰える', async () => {
    let w = createWorld();
    const late = w.horses.find((h) => h.growthType === 'late' && ageOf(h, w.date) === 3)!;
    const old = w.horses.find((h) => ageOf(h, w.date) === 7 && h.growthType !== 'late')!;
    const s0 = { late: late.speed, old: old.speed };
    for (let i = 0; i < 104; i++) w = advanceWeek(w);
    const late2 = w.horses.find((h) => h.id === late.id)!;
    const old2 = w.horses.find((h) => h.id === old.id);
    expect(late2.speed).toBeGreaterThan(s0.late);
    if (old2 && old2.status === 'active') expect(old2.speed).toBeLessThan(s0.old);
  });
});

describe('疲労とコンディション', () => {
  it('レースで疲労がたまり、休養すると回復する（長い距離・重い馬場ほど疲れる）', () => {
    const l0 = life();
    const mile = afterRace(l0, 65, 4, { distance: 1600, goingIndex: 0, kakari: false, rank: 3, field: 12 }, 'a');
    const long = afterRace(l0, 65, 4, { distance: 2500, goingIndex: 3, kakari: false, rank: 3, field: 12 }, 'a');
    expect(mile.fatigue).toBeGreaterThan(30);
    expect(long.fatigue).toBeGreaterThan(mile.fatigue);
    let l = mile;
    for (let i = 0; i < 6; i++) l = weeklyRecovery(l, 65);
    expect(l.fatigue).toBeLessThan(FATIGUE_LIMIT / 3);
  });
  it('間隔を詰めて使うと疲労が残る（中1週は中5週より疲労が多い）', () => {
    let a = afterRace(life(), 65, 4, { distance: 1800, goingIndex: 0, kakari: false, rank: 5, field: 12 }, 'b');
    let b = a;
    a = weeklyRecovery(a, 65);
    for (let i = 0; i < 5; i++) b = weeklyRecovery(b, 65);
    a = afterRace(a, 65, 4, { distance: 1800, goingIndex: 0, kakari: false, rank: 5, field: 12 }, 'c');
    b = afterRace(b, 65, 4, { distance: 1800, goingIndex: 0, kakari: false, rank: 5, field: 12 }, 'c');
    expect(a.fatigue).toBeGreaterThan(b.fatigue + 15);
  });
  it('疲労が残っていると走りにくいが、必ず負けるわけではない', () => {
    const mk = (id: string, fatigue: number): Horse => ({ ...base, id, name: id, form: { condition: 0, fatigue, mental: 0 } });
    const cond: RaceConditions = { surface: 'turf', distance: 1800, weather: 'sunny', going: 'good', timeOfDay: 'day' };
    const runners = [mk('fresh', 0), mk('tired', 60), ...Array.from({ length: 6 }, (_, i) => mk(`o${i}`, 10))].map((h, i) => ({ horse: h, number: i + 1 }));
    let tiredAhead = 0;
    for (let s = 0; s < 150; s++) {
      const r = simulateRace(cond, runners, `ft${s}`, { record: false });
      if (r.order.indexOf(1) < r.order.indexOf(0)) tiredAhead++;
    }
    expect(tiredAhead / 150).toBeLessThan(0.42);
    expect(tiredAhead).toBeGreaterThan(0);
  });
  it('調子は能力を大きく超えない（絶好調と絶不調の差は 0.12 m/s 以内）', () => {
    const p = (c: number) => raceAbility(profileOf({ ...base, form: { condition: c, fatigue: 0, mental: 0 } }), { surface: 'turf', distance: 1600, goingIndex: 0, course: { hand: 1, straight: 310, turnRadius: 138, finalHill: 2 } }).speedAdj;
    expect(p(1) - p(-1)).toBeGreaterThan(0);
    expect(p(1) - p(-1)).toBeLessThanOrEqual(0.1201);
  });
  it('調子には波があり、好調期と不調期がある（周期10〜16週）', () => {
    const l = life();
    const cs = Array.from({ length: 30 }, (_, i) => conditionOf(l, i));
    expect(Math.max(...cs)).toBeGreaterThan(0.4);
    expect(Math.min(...cs)).toBeLessThan(-0.4);
  });
});

describe('故障と引退', () => {
  it('疲労がたまっているほど、健康が低いほど、故障しやすい', () => {
    expect(injuryRisk(life({ fatigue: 60 }), 65, 4, 0)).toBeGreaterThan(injuryRisk(life({ fatigue: 0 }), 65, 4, 0) * 2);
    expect(injuryRisk(life(), 40, 4, 0)).toBeGreaterThan(injuryRisk(life(), 90, 4, 0));
  });
  it('故障した馬は治るまで出走せず、治療期間が過ぎると復帰し、重度の故障は能力の上限が下がる', () => {
    let l = life({ injury: { name: '屈腱炎', severity: 'severe', weeksLeft: 3, loss: 0.08 } });
    const pot0 = l.pot.speed;
    l = weeklyRecovery(l, 65);
    l = weeklyRecovery(l, 65);
    expect(l.injury).toBeDefined();
    l = weeklyRecovery(l, 65);
    expect(l.injury).toBeUndefined();
    expect(l.pot.speed).toBeLessThan(pot0);
    expect(l.layoff).toBe(1);
    let w = createWorld();
    w = { ...w, horses: w.horses.map((h, i) => (i === 0 ? { ...h, life: { ...h.life, injury: { name: '骨折', severity: 'moderate' as const, weeksLeft: 20, loss: 0 } } } : h)) };
    expect(eligibleHorses(w).some((h) => h.id === w.horses[0].id)).toBe(false);
  });
  it('高齢ほど引退しやすく、10歳では必ず引退する', () => {
    const l = life();
    expect(retireProbability(base, 4, l, 1, 5)).toBeLessThan(retireProbability(base, 8, l, 1, 5));
    expect(retireProbability(base, 10, l, 5, 10)).toBe(1);
  });
  it('2歳馬はデビューの時期（6月）までは出走しない', () => {
    let w = createWorld();
    const twoYo = w.horses.find((h) => ageOf(h, w.date) === 2)!;
    expect(eligibleHorses(w).some((h) => h.id === twoYo.id)).toBe(false);
    while (w.date.week < DEBUT_WEEK) w = advanceWeek(w);
    const h = w.horses.find((x) => x.id === twoYo.id)!;
    if (h.life.fatigue < FATIGUE_LIMIT && !h.life.injury) expect(eligibleHorses(w).some((x) => x.id === twoYo.id)).toBe(true);
  });
  it('2年進めても、引退と新しい世代で現役の頭数が保たれ、引退馬が出る', async () => {
    let w: World = createWorld();
    for (let i = 0; i < 104; i++) w = await runUnwatchedMeeting(w, `LC${i}`);
    const active = w.horses.filter((h) => h.status === 'active');
    expect(active.length).toBeGreaterThan(TARGET_ACTIVE * 0.9);
    expect(w.horses.some((h) => h.status === 'retired')).toBe(true);
    expect(active.some((h) => h.birthYear === w.date.year - 2)).toBe(true);
    // 前の年（2年進めると今は年明け）の出走は、おおよそ JRA 並み（1頭あたり4〜9走）
    const ran = w.horses.filter((h) => h.history.some((r) => r.y === w.date.year - 1));
    const perHorse = ran.reduce((a, h) => a + h.history.filter((r) => r.y === w.date.year - 1).length, 0) / active.length;
    expect(perHorse).toBeGreaterThan(4);
    expect(perHorse).toBeLessThan(9);
  }, 120000);
});

describe('保存データの移行', () => {
  it('生涯の状態がない競馬界（schema 1）を移行できる', async () => {
    const s = await createInitialState(0);
    const old = { ...s.world, schema: 1, horses: s.world.horses.map(({ life: _l, ...h }) => h) };
    const w = upgradeWorld(old as unknown as World);
    expect(w.schema).toBe(2);
    expect(w.horses.every((h) => h.life && h.life.pot.speed > 0)).toBe(true);
    const m = migrate(JSON.parse(JSON.stringify({ ...s, world: old })))!;
    expect(m.world.schema).toBe(2);
  });
  it('年齢の計算：JRA の馬齢は1月に加算、生後の年数は春生まれとして数える', () => {
    expect(bioAge(2024, { year: 2026, week: 1 })).toBeCloseTo(1.7, 1);
  });
});
