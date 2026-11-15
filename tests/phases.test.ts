import { describe, expect, it } from 'vitest';
import { type RaceConditions, type SimRunner, simulateRace } from '../src/core/sim';
import { type Horse, HORSES } from '../src/data/roster';

/** 平均的な能力の馬（追加の能力・適性は外す） */
function horse(id: string, over: Partial<Horse> = {}): Horse {
  const { sustain: _a, control: _b, health: _c, growth: _d, growthType: _e, apt: _f, ...rest } = HORSES[0];
  return { ...rest, id, name: id, speed: 75, stamina: 75, accel: 75, start: 70, temper: 75, power: 70, style: 'senko', bestDistance: 1800, turf: 'B', dirt: 'B', heavy: 'B', ...over };
}
const field = (hs: Horse[]): SimRunner[] => hs.map((h, i) => ({ horse: h, number: i + 1, weight: 56 }));
const cond = (distance: number, over: Partial<RaceConditions> = {}): RaceConditions => ({ surface: 'turf', distance, weather: 'sunny', going: 'good', timeOfDay: 'day', ...over });
const STYLES: Horse['style'][] = ['senko', 'sashi', 'nige', 'oikomi', 'senko', 'sashi', 'senko', 'sashi', 'oikomi', 'senko'];

describe('レースの段階', () => {
  it('各馬の段階ごとの順位（スタート直後・序盤・中盤・直線の入口・ゴール）と、段階の区切りを返す', () => {
    const r = simulateRace(cond(2000), field(STYLES.map((s, i) => horse(`h${i}`, { style: s }))), 'ph1', { record: false });
    expect(r.phaseMarks).toHaveLength(4);
    expect(r.phaseMarks[0]).toBe(200);
    for (let k = 1; k < 4; k++) expect(r.phaseMarks[k]).toBeGreaterThan(r.phaseMarks[k - 1]);
    r.factors.forEach((f, i) => {
      expect(f.phasePos).toHaveLength(5);
      expect(f.phasePos[4]).toBe(r.order.indexOf(i) + 1);
    });
  });

  it('スタート：外枠ほど序盤に横へ動く距離が長く、コーナーで外を回る距離も長い', () => {
    let early = [0, 0];
    let loss = [0, 0];
    for (let s = 0; s < 60; s++) {
      const r = simulateRace(cond(1600), field(STYLES.map((_, i) => horse(`h${i}`))), `gate${s}`, { record: false, dt: 0.2 });
      early = [early[0] + r.factors[0].earlyLateral, early[1] + r.factors[9].earlyLateral];
      loss = [loss[0] + r.factors[0].laneLoss, loss[1] + r.factors[9].laneLoss];
    }
    expect(early[1]).toBeGreaterThan(early[0] * 2);
    expect(loss[1]).toBeGreaterThan(loss[0]);
  });

  it('枠順：内枠ほど有利だが極端ではない（同じ能力の10頭。2番と10番の勝率の比が3倍未満、1番も4割未満）', () => {
    // 1番（最内）は内ラチ沿いを取りやすく、同じ能力の馬だけで比べると有利が大きく出る。位置の取り合いは騎手の段階（第9段階）で見直す
    const w = new Array(10).fill(0);
    const N = 600;
    for (let s = 0; s < N; s++) w[simulateRace(cond(2000), field(STYLES.map((_, i) => horse(`h${i}`))), `dr${s}`, { record: false, dt: 0.2 }).order[0]]++;
    expect(w[1]).toBeGreaterThan(w[9] * 0.9);
    expect(w[1] / Math.max(1, w[9])).toBeLessThan(3);
    expect(w[0] / N).toBeLessThan(0.4);
  });
});

describe('ペースと展開', () => {
  const run = (styles: Horse['style'][], D: number, N: number) => {
    let half = 0;
    let front = 0;
    for (let s = 0; s < N; s++) {
      const r = simulateRace(cond(D), field(styles.map((st, i) => horse(`h${i}`, { style: st }))), `pc${s}`, { record: false, dt: 0.2 });
      half += r.halfDiff;
      const a = r.factors[r.order[0]].actualStyle;
      if (a === 'nige' || a === 'senko') front++;
    }
    return { half: half / N, front: front / N };
  };
  it('逃げ馬が多いと前半が速く（ハイペース）、前に行った馬が勝ちにくい。逃げ馬がいないとスローで前が有利', () => {
    const many = run(['nige', 'nige', 'nige', 'senko', 'sashi', 'sashi', 'oikomi', 'senko', 'sashi', 'oikomi'], 2000, 250);
    const none = run(['senko', 'senko', 'sashi', 'sashi', 'sashi', 'oikomi', 'oikomi', 'senko', 'sashi', 'oikomi'], 2000, 250);
    expect(many.half).toBeGreaterThan(none.half);
    expect(none.front).toBeGreaterThan(many.front + 0.1);
  });

  it('ペースの判定：前半と後半のタイムの差（距離ごとの標準との差）で決まる', () => {
    const r = simulateRace(cond(2000), field(STYLES.map((s, i) => horse(`h${i}`, { style: s }))), 'pj', { record: false });
    expect(['high', 'middle', 'slow']).toContain(r.pace);
    expect(Number.isFinite(r.halfDiff)).toBe(true);
  });

  it('短距離は前半が速く後半が鈍り、中距離は道中を抑えて直線で加速する（ラップの形）', () => {
    let s1200 = 0;
    let s2400 = 0;
    for (let s = 0; s < 40; s++) {
      const a = simulateRace(cond(1200), field(STYLES.map((st, i) => horse(`h${i}`, { style: st, bestDistance: 1200 }))), `lp${s}`, { record: false, dt: 0.2 });
      const b = simulateRace(cond(2400), field(STYLES.map((st, i) => horse(`h${i}`, { style: st, bestDistance: 2400 }))), `lp${s}`, { record: false, dt: 0.2 });
      // 前半3Fには発馬の加速（約1秒）が含まれる
      s1200 += a.final3F - (a.first3F - 1);
      s2400 += b.final3F - (b.first3F - 1);
    }
    expect(s1200 / 40).toBeGreaterThan(0);
    expect(s2400 / 40).toBeLessThan(0);
  });

  it('スローペースでは、後方で脚を残した差し・追込が早めに動く（まくり）。直線では叩き合いが起きる', () => {
    let makuri = 0;
    let fight = 0;
    for (let s = 0; s < 120; s++) {
      const r = simulateRace(cond(2400), field(['senko', 'senko', 'sashi', 'sashi', 'oikomi', 'oikomi', 'sashi', 'senko', 'oikomi', 'sashi'].map((st, i) => horse(`h${i}`, { style: st as Horse['style'], stamina: 85 }))), `mk${s}`, { record: false, dt: 0.2 });
      if (r.events.some((e) => e.type === 'makuri')) makuri++;
      if (r.events.some((e) => e.type === 'fight')) fight++;
    }
    expect(makuri).toBeGreaterThan(5);
    expect(fight).toBeGreaterThan(20);
  });
});

describe('結果の不確実性', () => {
  it('能力の高い馬はよく勝つが、常に勝つわけではない。能力の低い馬が勝つこともある', () => {
    const hs = STYLES.map((s, i) => horse(`h${i}`, { style: s, speed: 75 + (i - 4.5) * 1.2 }));
    const w = new Array(10).fill(0);
    const N = 800;
    // 枠の有利不利が混ざらないよう、毎回枠を回す
    for (let s = 0; s < N; s++) {
      const runners = hs.map((h, i) => ({ horse: h, number: ((i + s) % 10) + 1, weight: 56 })).sort((a, b) => a.number - b.number);
      const r = simulateRace(cond(1800), runners, `un${s}`, { record: false, dt: 0.2 });
      w[Number(runners[r.order[0]].horse.id.slice(1))]++;
    }
    const best = w[9] / N;
    const worst = w[0] / N;
    expect(best).toBeGreaterThan(0.12);
    expect(best).toBeLessThan(0.7);
    expect(worst).toBeGreaterThan(0);
    expect(best).toBeGreaterThan(worst * 2);
  });
});
