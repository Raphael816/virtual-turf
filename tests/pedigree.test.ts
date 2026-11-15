import { describe, expect, it } from 'vitest';
import { FOUNDERS, GENE_KEYS, GENE_MEAN, GENE_SD, LINES, activeStud, assignPedigree, breedingValue, inheritGrowth, midParent, pedigreeOutlook, phenotype, planCrop, promoteStallions, sireWeights } from '../src/core/pedigree';
import { Rng } from '../src/core/rng';
import { migrate } from '../src/core/storage';
import { createInitialState } from '../src/core/state';
import { advanceWeek, createWorld, upgradeWorld } from '../src/core/world';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const corr = (a: number[], b: number[]) => mean(a.map((x, i) => (x - mean(a)) * (b[i] - mean(b)))) / (sd(a) * sd(b));

describe('種牡馬と系統', () => {
  it('はじめの種牡馬は24頭・6系統。名前は重ならず、系統の特徴を持つ', () => {
    expect(FOUNDERS).toHaveLength(24);
    expect(new Set(FOUNDERS.map((s) => s.name)).size).toBe(24);
    expect(new Set(FOUNDERS.map((s) => s.line)).size).toBe(6);
    const of = (l: string) => FOUNDERS.filter((s) => s.line === l);
    expect(mean(of('tempest').map((s) => s.genes.distance))).toBeLessThan(mean(of('granvert').map((s) => s.genes.distance)) - 800);
    expect(mean(of('iron').map((s) => s.genes.surface))).toBeGreaterThan(0.4);
    expect(mean(of('solaris').map((s) => s.genes.surface))).toBeLessThan(-0.2);
    expect(mean(of('granvert').map((s) => s.genes.growth))).toBeGreaterThan(mean(of('tempest').map((s) => s.genes.growth)) + 0.5);
    for (const s of FOUNDERS) expect(LINES[s.line].background.length).toBeGreaterThan(10);
  });
  it('評価の高い種牡馬ほど産駒が多い', () => {
    const w = sireWeights(FOUNDERS);
    const best = FOUNDERS.map((s, i) => ({ q: (s.genes.speed + s.genes.accel + s.genes.stamina) / 3, w: w[i] })).sort((a, b) => b.q - a.q);
    expect(best[0].w).toBeGreaterThan(best[best.length - 1].w);
    expect(activeStud(FOUNDERS, 2026).length).toBeGreaterThan(10);
  });
});

describe('遺伝', () => {
  it('親が子に伝える値は、親自身の値を平均へ戻したもの（そのままは伝わらない）', () => {
    const p = { speed: 90, stamina: 60, accel: 73, power: 67, temper: 68, distance: 2750, surface: 1, growth: 0.7 };
    const g = breedingValue(p);
    expect(g.speed).toBeCloseTo(82);
    expect(g.stamina).toBeCloseTo(66);
    expect(g.accel).toBeCloseTo(73);
    expect(g.distance).toBeCloseTo(2350);
    const m = midParent(g, breedingValue({ ...GENE_MEAN }));
    expect(m.speed).toBeCloseTo(4);
    expect(m.distance).toBeCloseTo(300);
  });
  it('配合：世代の平均からのずれは合計0（世代全体の能力は上がり続けない）。両親の値で子の中心が変わる', () => {
    const crop = planCrop(new Rng('t'), 400, FOUNDERS, []);
    expect(crop).toHaveLength(400);
    for (const k of GENE_KEYS) expect(Math.abs(mean(crop.map((m) => m.mid[k])))).toBeLessThan(1e-6 * GENE_SD[k] + 1e-6);
    // 血統による中心のずれは、個体差（標準偏差）よりずっと小さい
    expect(sd(crop.map((m) => m.mid.speed))).toBeLessThan(GENE_SD.speed * 0.5);
    expect(sd(crop.map((m) => m.mid.speed))).toBeGreaterThan(0.5);
    // 父の系統が記録され、母父は父と別の馬のこともある
    expect(crop.every((m) => m.ped.l === m.sire.line && m.ped.s === m.sire.name && m.ped.d.length > 0)).toBe(true);
    expect(planCrop(new Rng('t'), 400, FOUNDERS, [])).toEqual(crop);
  });
  it('成長型：両親が晩成寄りなら晩成が増え、早熟寄りなら早熟が増える', () => {
    const count = (g: number, t: string) => Array.from({ length: 2000 }, (_, i) => inheritGrowth(new Rng(`g${i}`), g)).filter((x) => x === t).length / 2000;
    expect(count(0.5, 'late')).toBeGreaterThan(count(0, 'late') + 0.15);
    expect(count(-0.5, 'early')).toBeGreaterThan(count(0, 'early') + 0.15);
    expect(count(0.5, 'early')).toBeGreaterThan(0.05);
  });
  it('走っていた牝馬が母になることがあり、その父が母父になる', () => {
    const mare = { name: 'テストノハナ', sire: 'グランヴェール', genes: { ...GENE_MEAN }, weight: 5 };
    const crop = planCrop(new Rng('m'), 300, FOUNDERS, [mare]);
    const kids = crop.filter((m) => m.ped.d === 'テストノハナ');
    expect(kids.length).toBeGreaterThan(50);
    expect(kids.length).toBeLessThan(140);
    expect(kids.every((m) => m.ped.ds === 'グランヴェール')).toBe(true);
  });
});

describe('競馬界と血統', () => {
  const w0 = createWorld();
  it('ゲーム開始時のすべての馬に、父・母・母父・系統が付く。能力は血統を付ける前と変わらない', () => {
    expect(w0.schema).toBe(6);
    expect(w0.stud).toHaveLength(24);
    const names = new Set(FOUNDERS.map((s) => s.name));
    for (const h of w0.horses) {
      expect(h.ped).toBeDefined();
      expect(names.has(h.ped!.s)).toBe(true);
      expect(names.has(h.ped!.ds)).toBe(true);
      expect(h.ped!.s).not.toBe(h.ped!.ds);
      expect(assignPedigree(h, h.life.pot)).toEqual(h.ped);
    }
    // 産駒は父に似る傾向（距離）。ただし完全には決まらない
    const stud = new Map(FOUNDERS.map((s) => [s.name, s]));
    const r = corr(w0.horses.map((h) => stud.get(h.ped!.s)!.genes.distance), w0.horses.map((h) => h.bestDistance));
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.9);
  });
  it('新しい世代は配合から生まれる：父の値と子の能力に相関があるが、血統だけでは決まらない。世代の平均は変わらない', () => {
    let w = w0;
    for (let i = 0; i < 52 * 4; i++) w = advanceWeek(w);
    const foals = w.horses.filter((h) => h.id.startsWith('y'));
    expect(foals.length).toBeGreaterThan(300);
    expect(foals.every((h) => !!h.ped)).toBe(true);
    const stud = new Map(w.stud.map((s) => [s.name, s]));
    const known = foals.filter((h) => stud.has(h.ped!.s));
    for (const k of ['speed', 'stamina', 'accel'] as const) {
      const r = corr(known.map((h) => stud.get(h.ped!.s)!.genes[k]), known.map((h) => h.life.pot[k]));
      // 相関 0.15〜0.5：父の値で説明できるのは、ばらつきの 2〜25%
      expect(r).toBeGreaterThan(0.15);
      expect(r).toBeLessThan(0.5);
    }
    const rd = corr(known.map((h) => stud.get(h.ped!.s)!.genes.distance), known.map((h) => h.bestDistance));
    expect(rd).toBeGreaterThan(0.25);
    // 世代の平均とばらつきは、血統のない生成（ゲーム開始時の馬）と同じ水準
    const gen0 = w0.horses.filter((h) => h.id.startsWith('g'));
    expect(Math.abs(mean(foals.map((h) => h.life.pot.speed)) - mean(gen0.map((h) => h.life.pot.speed)))).toBeLessThan(1);
    expect(Math.abs(mean(foals.map((h) => h.life.pot.stamina)) - mean(gen0.map((h) => h.life.pot.stamina)))).toBeLessThan(1.2);
    expect(Math.abs(sd(foals.map((h) => h.life.pot.speed)) - sd(gen0.map((h) => h.life.pot.speed)))).toBeLessThan(1);
    // 同じ父の産駒でも能力に幅がある
    const top = [...new Set(foals.map((h) => h.ped!.s))].map((s) => foals.filter((h) => h.ped!.s === s)).sort((a, b) => b.length - a.length)[0];
    expect(sd(top.map((h) => h.life.pot.speed))).toBeGreaterThan(3);
    // 同じ経過からは同じ競馬界になる
    let w2 = w0;
    for (let i = 0; i < 52 * 4; i++) w2 = advanceWeek(w2);
    expect(w2.horses.map((h) => h.ped)).toEqual(w.horses.map((h) => h.ped));
  }, 120000);
  it('引退した牡馬のうち成績のよい馬が種牡馬になる（1年に3頭まで。セン馬・牝馬・条件馬はならない）', () => {
    const base = w0.horses.filter((h) => h.sex === '牡').slice(0, 5).map((h, i) => ({ ...h, earnings: 3000 + i * 1000, career: { ...h.career, prize: 10000 * i } }));
    const others = [{ ...w0.horses.find((h) => h.sex === '牝')!, earnings: 9000 }, { ...base[0], id: 'x1', name: 'テストセン', sex: 'セ' as const, earnings: 9000 }, { ...base[0], id: 'x2', name: 'テストジョウケン', earnings: 900 }];
    const added = promoteStallions([...base, ...others], FOUNDERS, 2030);
    expect(added).toHaveLength(3);
    expect(added.map((s) => s.name)).toEqual([base[4].name, base[3].name, base[2].name]);
    expect(added[0]).toMatchObject({ from: 2030, until: 2044, horseId: base[4].id, line: base[4].ped!.l, sire: base[4].ped!.s });
    expect(added[0].genes).toEqual(breedingValue(phenotype(base[4], base[4].life.pot)));
    // すでに種牡馬になっている馬は重ねて加えない
    expect(promoteStallions(base, [...FOUNDERS, ...added], 2031).map((s) => s.name)).toEqual([base[1].name, base[0].name]);
  });
  it('血統から見た傾向の説明', () => {
    const tempest = FOUNDERS.find((s) => s.line === 'tempest')!;
    const iron = FOUNDERS.find((s) => s.line === 'iron')!;
    const out = pedigreeOutlook({ s: tempest.name, d: 'x', ds: tempest.name, l: 'tempest' }, FOUNDERS);
    expect(out[0]).toMatch(/短距離|マイル/);
    expect(pedigreeOutlook({ s: iron.name, d: 'x', ds: iron.name, l: 'iron' }, FOUNDERS)).toContain('ダート向き');
    expect(pedigreeOutlook({ s: 'いない馬', d: 'x', ds: 'y', l: 'iron' }, FOUNDERS)).toEqual([]);
  });
  it('古い保存データ（schema 5）を移行：血統と種牡馬が付き、能力・戦績は変わらない', async () => {
    const s = await createInitialState(Date.now());
    const old = { ...s, world: { ...s.world, schema: 5, stud: undefined, horses: s.world.horses.map(({ ped: _p, ...h }) => h) } };
    const m = migrate(JSON.parse(JSON.stringify(old)))!;
    expect(m.world.schema).toBe(6);
    expect(m.world.stud).toHaveLength(24);
    expect(m.world.horses.every((h) => !!h.ped)).toBe(true);
    expect(m.world.horses.map(({ ped: _p, ...h }) => h)).toEqual(JSON.parse(JSON.stringify(old.world.horses)));
    expect(upgradeWorld(m.world)).toBe(m.world);
  });
});
