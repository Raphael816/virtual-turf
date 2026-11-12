import { describe, expect, it } from 'vitest';
import { DEV_DEFAULT, GROWTH_KEYS, type Life, conditionOf, currentAbilities, initLife } from '../src/core/lifecycle';
import { MENU_BY_ID, type MenuId, ageResponse, npcPlan, train, trainRisk } from '../src/core/training';
import { HORSES } from '../src/data/roster';

const base = HORSES[0];
const fresh = (over: Partial<Life> = {}): Life => ({
  ...initLife(base, 4, 't'),
  fatigue: 0,
  mental: 0,
  layoff: 0,
  fitness: 50,
  dev: Object.fromEntries(GROWTH_KEYS.map((k) => [k, 0.4])) as Life['pot'],
  train: [],
  ...over,
});
/** 毎週のメニューを続けて行う（毎週の疲労の回復も入れる） */
function program(menus: MenuId[], weeks: number, age = 4, start = fresh()): { life: Life; injuries: number } {
  let l = start;
  let injuries = 0;
  for (let i = 0; i < weeks; i++) {
    l = { ...l, fatigue: Math.max(0, l.fatigue - 8), mental: Math.max(0, l.mental - 4), injury: undefined };
    const o = train(l, menus[i % menus.length], { age, health: 65, seed: `p${i}`, date: { year: 2026, week: (i % 52) + 1 } });
    if (o.injured) injuries++;
    l = o.life;
  }
  return { life: l, injuries };
}

describe('調教メニューの効果', () => {
  it('坂路はパワー、芝コースはスピード、ウッドはスタミナを主に鍛える', () => {
    const hill = program(['hill', 'canter'], 12).life.dev!;
    const turf = program(['turf', 'canter'], 12).life.dev!;
    const wood = program(['wood', 'canter'], 12).life.dev!;
    expect(hill.power).toBeGreaterThan(turf.power);
    expect(turf.speed).toBeGreaterThan(hill.speed);
    expect(wood.stamina).toBeGreaterThan(turf.stamina);
  });
  it('繰り返しても無限には伸びない（効果は上限に近いほど小さく、能力の倍率は最大1.02）', () => {
    const a = program(['hill', 'canter'], 10).life;
    const a2 = program(['hill', 'canter'], 20).life;
    const b = program(['hill', 'canter'], 60).life;
    // 同じ10週でも、鍛えられてからの伸び（10〜20週目）は最初の10週より小さい
    expect(a2.dev!.power - a.dev!.power).toBeLessThan(a.dev!.power - 0.4);
    expect(b.dev!.power).toBeLessThan(1);
    const cur = currentAbilities(base, b, 4.5);
    expect(cur.power).toBeLessThanOrEqual(Math.round(b.pot.power * 1.02) + 1);
  });
  it('若い馬ほど調教の効果が大きい', () => {
    expect(ageResponse(2)).toBeGreaterThan(ageResponse(4));
    expect(ageResponse(4)).toBeGreaterThan(ageResponse(7));
    const young = program(['wood', 'canter'], 10, 2.2).life.dev!.stamina;
    const old = program(['wood', 'canter'], 10, 7).life.dev!.stamina;
    expect(young).toBeGreaterThan(old);
  });
  it('同じメニューばかりだと慣れて効果が薄れる', () => {
    const mono = program(['wood'], 8).life.dev!.stamina;
    const mixed = program(['wood', 'canter'], 16).life.dev!.stamina;
    // 同じ回数（8回）のウッドでも、間に別のメニューを挟んだ方が伸びる
    expect(mixed).toBeGreaterThan(mono);
  });
});

describe('負担と回復', () => {
  it('強めの追い切りを続けると疲労がたまり、故障しやすくなる', () => {
    const hard = program(['strong'], 30);
    const easy = program(['canter', 'hill', 'light'], 30);
    expect(hard.life.fatigue).toBeGreaterThan(easy.life.fatigue + 20);
    expect(trainRisk(MENU_BY_ID.strong, hard.life, 65, 4)).toBeGreaterThan(trainRisk(MENU_BY_ID.canter, easy.life, 65, 4) * 5);
  });
  it('疲れているときに追っても効きにくい', () => {
    const tired = train(fresh({ fatigue: 70 }), 'hill', { age: 4, health: 65, seed: 'x', date: { year: 2026, week: 1 } });
    const ok = train(fresh(), 'hill', { age: 4, health: 65, seed: 'x', date: { year: 2026, week: 1 } });
    expect(tired.gains.power!).toBeLessThan(ok.gains.power! * 0.5);
  });
  it('休養で疲労と気持ちが回復し、仕上がりは落ちる', () => {
    const l = fresh({ fatigue: 60, mental: 50, fitness: 80 });
    const r = program(['rest'], 3, 4, l).life;
    expect(r.fatigue).toBeLessThan(20);
    expect(r.mental).toBeLessThan(30);
    expect(r.fitness!).toBeLessThan(70);
  });
  it('長く休むと鍛え具合が少しずつ落ちる', () => {
    const r = program(['rest'], 20, 4, fresh({ dev: Object.fromEntries(GROWTH_KEYS.map((k) => [k, 0.8])) as Life['pot'] })).life;
    expect(r.dev!.speed).toBeLessThan(0.8);
    expect(r.dev!.speed).toBeGreaterThan(0.5);
  });
  it('故障中は休養しかしない（調教しない）', () => {
    const o = train(fresh({ injury: { name: '骨折', severity: 'moderate', weeksLeft: 10, loss: 0 } }), 'strong', { age: 4, health: 65, seed: 'i', date: { year: 2026, week: 1 } });
    expect(o.life.train![0].m).toBe('rest');
  });
});

describe('仕上がりと調子', () => {
  it('追い切りで仕上がりが上がり、調子も上向く（ただし調子は −1〜1 の範囲）', () => {
    const l0 = fresh({ fitness: 40 });
    const l1 = program(['hill', 'canter', 'strong'], 6, 4, l0).life;
    expect(l1.fitness!).toBeGreaterThan(40);
    expect(conditionOf(l1, 0)).toBeGreaterThan(conditionOf(l0, 0));
    expect(Math.abs(conditionOf(l1, 0))).toBeLessThanOrEqual(1);
  });
  it('既定の鍛え具合の馬は、成長曲線どおりの能力になる', () => {
    const l = { ...fresh(), dev: Object.fromEntries(GROWTH_KEYS.map((k) => [k, DEV_DEFAULT])) as Life['pot'] };
    const l2 = { ...l, dev: undefined };
    expect(currentAbilities(base, l, 4)).toEqual(currentAbilities(base, l2, 4));
  });
});

describe('厩舎の調教計画（自動）', () => {
  it('故障中・疲労が大きい馬は休養、レースの翌週は軽め', () => {
    expect(npcPlan(fresh({ injury: { name: 'x', severity: 'minor', weeksLeft: 3, loss: 0 } }), 5, 'speed', 'a')).toBe('rest');
    expect(npcPlan(fresh({ fatigue: 60 }), 5, 'speed', 'a')).toBe('rest');
    expect(npcPlan(fresh({ fatigue: 10 }), 1, 'speed', 'a')).toBe('light');
  });
  it('仕上がってきた元気な馬には、ときどき強めの追い切りをかける', () => {
    const plans = Array.from({ length: 40 }, (_, i) => npcPlan(fresh({ fitness: 60, fatigue: 5 }), 4, 'speed', `s${i}`));
    expect(plans.filter((p) => p === 'strong').length).toBeGreaterThan(15);
  });
  it('同じ状態・同じ週からは同じ調教になる（決定論的）', () => {
    expect(program(['hill', 'strong', 'wood'], 10).life).toEqual(program(['hill', 'strong', 'wood'], 10).life);
  });
});
