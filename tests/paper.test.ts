import { beforeAll, describe, expect, it } from 'vitest';
import { bodyText, bodyWeight, matureWeight, weightParts } from '../src/core/bodyweight';
import { type RaceCard, createMeeting, runRace } from '../src/core/meeting';
import { paperNotes, splitCourse, talliesFor, tally, tallyText } from '../src/core/paper';
import { postRaceComments } from '../src/core/postrace';
import { runUnwatchedMeeting } from '../src/core/raceflow';
import { type RunRecord, type World, createWorld } from '../src/core/world';

let world: World;
let cards: RaceCard[];
beforeAll(async () => {
  world = createWorld();
  // 12週進めて、戦績に馬体重が入った状態にする
  for (let i = 0; i < 12; i++) world = await runUnwatchedMeeting(world, `paper-${i}`);
  let k = 0;
  cards = await createMeeting('paper-now', () => `s${k++}`, world);
}, 120000);

describe('馬体重', () => {
  it('2kg 単位で、現実的な範囲に収まる。牝馬は牡馬より平均で軽い', () => {
    const ws = world.horses.filter((h) => h.status === 'active').map((h) => ({ h, w: bodyWeight(h, world.date, 'x') }));
    for (const { w } of ws) {
      expect(w % 2).toBe(0);
      expect(w).toBeGreaterThanOrEqual(370);
      expect(w).toBeLessThanOrEqual(580);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const m = mean(ws.filter((x) => x.h.sex !== '牝').map((x) => x.w));
    const f = mean(ws.filter((x) => x.h.sex === '牝').map((x) => x.w));
    expect(m).toBeGreaterThan(f + 10);
    expect(m).toBeGreaterThan(455);
    expect(m).toBeLessThan(500);
  });
  it('同じ開催では同じ値。疲労で減り、休み明けで増え、若い馬は完成時より軽い', () => {
    const h = world.horses.find((x) => x.status === 'active' && world.date.year - x.birthYear >= 5)!;
    expect(bodyWeight(h, world.date, 'a')).toBe(bodyWeight(h, world.date, 'a'));
    const tired = { ...h, life: { ...h.life, fatigue: 80 } };
    const fresh = { ...h, life: { ...h.life, fatigue: 0 } };
    expect(weightParts(tired, world.date).fatigue).toBeLessThan(weightParts(fresh, world.date).fatigue - 5);
    const rested = { ...h, lastRun: { year: world.date.year - 1, week: world.date.week } };
    expect(weightParts(rested, world.date).rest).toBeGreaterThan(10);
    const young = { ...h, birthYear: world.date.year - 2 };
    expect(weightParts(young, world.date).grow).toBeLessThan(-10);
    expect(weightParts(h, world.date).grow).toBeCloseTo(0);
    expect(matureWeight(h)).toBe(matureWeight(h));
  });
  it('出走表に馬体重が入り、前走の記録がある馬は増減が付く。増減はほとんどが ±20kg 以内', () => {
    const es = cards.flatMap((c) => c.entries);
    expect(es.every((e) => e.body !== undefined)).toBe(true);
    const diffs = es.filter((e) => e.bodyDiff !== undefined).map((e) => e.bodyDiff!);
    expect(diffs.length).toBeGreaterThan(20);
    expect(diffs.filter((d) => Math.abs(d) <= 20).length / diffs.length).toBeGreaterThan(0.95);
    // 戦績にも記録される
    const withBw = world.horses.filter((h) => h.history[0]?.bw !== undefined);
    expect(withBw.length).toBeGreaterThan(100);
    expect(withBw.some((h) => h.history[0].bd !== undefined)).toBe(true);
    expect(withBw.every((h) => ['H', 'M', 'S'].includes(h.history[0].pc!) && !!h.history[0].vs)).toBe(true);
  });
  it('表記', () => {
    expect(bodyText(478, 4)).toBe('478(+4)');
    expect(bodyText(478, -6)).toBe('478(−6)');
    expect(bodyText(478, 0)).toBe('478(±0)');
    expect(bodyText(478, undefined)).toBe('478');
    expect(bodyText(478, undefined, true)).toBe('478(初)');
    expect(bodyText(undefined, undefined)).toBe('—');
  });
});

describe('レース後のコメント', () => {
  it('全馬に着順どおりのコメントが付き、同じレースからは同じ文章になる', () => {
    for (const card of cards) {
      const res = runRace(card, card.seed);
      const cs = postRaceComments(card, res);
      expect(cs).toHaveLength(card.entries.length);
      expect(cs.map((c) => c.rank)).toEqual(card.entries.map((_, i) => i + 1));
      expect(cs.map((c) => c.number)).toEqual(res.order.map((i) => card.entries[i].number));
      for (const c of cs) expect(c.text.length).toBeGreaterThan(8);
      expect(postRaceComments(card, res)).toEqual(cs);
    }
  });
  it('出遅れ・掛かりのあった馬のコメントは、そのことに触れる', () => {
    let late = 0;
    let kakari = 0;
    for (const card of cards) {
      const res = runRace(card, card.seed);
      const cs = postRaceComments(card, res);
      res.order.forEach((i, k) => {
        const f = res.factors[i];
        if (f.lateStart) {
          late++;
          expect(cs[k].text).toMatch(/スタート|ゲート/);
        } else if (f.kakari) {
          kakari++;
          expect(cs[k].text).toMatch(/力ん|折り合い/);
        }
      });
    }
    expect(late + kakari).toBeGreaterThan(0);
  });
});

describe('競馬新聞の集計', () => {
  const run = (o: Partial<RunRecord>): RunRecord => ({ r: 'x', y: 2026, w: 1, n: 'テスト', c: '東京芝1600m', g: '良', f: 16, no: 1, rk: 5, t: 95, m: '1', l3: 34.5, p: '5-5', j: '佐伯 透', ...o });
  it('コース表記を分解する', () => {
    expect(splitCourse('東京芝1600m')).toEqual({ venue: 'tokyo', surface: 'turf', distance: 1600 });
    expect(splitCourse('京都芝外3000m')).toEqual({ venue: 'kyoto', surface: 'turf', distance: 3000 });
    expect(splitCourse('中山ダ1800m')).toEqual({ venue: 'nakayama', surface: 'dirt', distance: 1800 });
    expect(splitCourse('芝外1600m')).toEqual({ surface: 'turf', distance: 1600 });
  });
  it('条件別の成績', () => {
    const hist = [run({ rk: 1 }), run({ rk: 2, c: '中山芝2000m' }), run({ rk: 7, c: '東京ダ1600m', g: '重' }), run({ rk: 3, c: '東京芝1800m', g: '不良' })];
    const t = talliesFor(hist, { venue: 'tokyo', surface: 'turf', distance: 1600 });
    expect(t.venue).toEqual([1, 0, 1, 1]);
    expect(t.surface).toEqual([1, 1, 1, 0]);
    expect(t.distance).toEqual([1, 0, 1, 0]);
    expect(t.soft).toEqual([0, 0, 1, 1]);
    expect(tallyText(tally([]))).toBe('—');
    expect(tallyText(t.venue)).toBe('1-0-1-1');
  });
  it('短評：前走との違いと状態を並べる', () => {
    const hist = [run({ rk: 1, k: 'win1', kg: 55, c: '東京芝1400m' })];
    const notes = paperNotes(hist, { course: { venue: 'tokyo', surface: 'turf', distance: 1600 }, cls: 'win2', weight: 57, jockey: '鷹野 翔', bodyDiff: 12, condition: 0.5, weeksSince: 14, firstRun: false });
    expect(notes).toContain('休み明け（14週）');
    expect(notes).toContain('昇級戦');
    expect(notes).toContain('距離延長（前走 1400m）');
    expect(notes.length).toBeLessThanOrEqual(5);
    const n2 = paperNotes([run({ rk: 2, tb: 0.1, kg: 57 })], { course: { venue: 'nakayama', surface: 'dirt', distance: 1800 }, weight: 55, jockey: '佐伯 透', bodyDiff: -12, firstRun: false });
    expect(n2).toEqual(['ダート替わり', '前走は 0.1秒差の2着', '斤量 2kg 減', '馬体重 −12kg']);
    expect(paperNotes([], { course: { surface: 'turf', distance: 1200 }, jockey: 'x', firstRun: true })).toEqual(['初出走']);
  });
});
