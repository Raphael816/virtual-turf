import { describe, expect, it } from 'vitest';
import { commitInput, createMeeting, frameOf, runRace, verifyRace } from '../src/core/meeting';
import { sha256Hex } from '../src/core/rng';
import {
  type RaceConditions,
  type SimRunner,
  formatTime,
  marginLabel,
  sampleAt,
  simulateRace,
} from '../src/core/sim';
import { type Horse, HORSES } from '../src/data/roster';

/** 平均的な能力の馬をベースに、一部の能力だけ変えた馬を作る */
function horse(id: string, over: Partial<Horse> = {}): Horse {
  return {
    ...HORSES[0],
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
    ...over,
  };
}

function field(horses: Horse[]): SimRunner[] {
  return horses.map((h, i) => ({ horse: h, number: i + 1 }));
}

const MILE: RaceConditions = { surface: 'turf', distance: 1600, weather: 'sunny', going: 'good', timeOfDay: 'day' };

function winRate(cond: RaceConditions, runners: SimRunner[], target: number, trials = 120): number {
  let wins = 0;
  for (let s = 0; s < trials; s++) {
    if (simulateRace(cond, runners, `t${s}`, { record: false }).order[0] === target) wins++;
  }
  return wins / trials;
}

describe('simulateRace: 基本性質', () => {
  const runners = field(Array.from({ length: 10 }, (_, i) => horse(`x${i}`, { speed: 70 + i })));

  it('同じ seed なら完全に同じ結果（決定論的）', () => {
    const a = simulateRace(MILE, runners, 'seed-A');
    const b = simulateRace(MILE, runners, 'seed-A');
    expect(a.order).toEqual(b.order);
    expect(a.finishTimes).toEqual(b.finishTimes);
    expect(Array.from(a.data!)).toEqual(Array.from(b.data!));
  });

  it('seed が違えば結果も変わりうる（意外性）', () => {
    const winners = new Set<number>();
    for (let s = 0; s < 60; s++) winners.add(simulateRace(MILE, runners, `v${s}`, { record: false }).order[0]);
    expect(winners.size).toBeGreaterThan(3);
  });

  it('全馬が入線し、着順は重複のない並び', () => {
    const r = simulateRace(MILE, runners, 'finish');
    expect([...r.order].sort((a, b) => a - b)).toEqual(runners.map((_, i) => i));
    r.finishTimes.forEach((t) => expect(Number.isFinite(t)).toBe(true));
    for (let k = 1; k < r.order.length; k++) {
      expect(r.finishTimes[r.order[k]]).toBeGreaterThanOrEqual(r.finishTimes[r.order[k - 1]]);
    }
  });

  it('走破タイムが現実的な範囲（芝1600m 良: 1:31〜1:40）', () => {
    const r = simulateRace(MILE, runners, 'time');
    expect(r.finishTimes[r.order[0]]).toBeGreaterThan(91);
    expect(r.finishTimes[r.order[0]]).toBeLessThan(100);
    expect(r.splits).toHaveLength(8);
    expect(r.final3F).toBeGreaterThan(32);
    expect(r.final3F).toBeLessThan(38);
  });

  it('記録モードと非記録モードで結果が一致する', () => {
    const a = simulateRace(MILE, runners, 'rec', { record: true });
    const b = simulateRace(MILE, runners, 'rec', { record: false });
    expect(a.order).toEqual(b.order);
    expect(b.data).toBeNull();
  });

  it('sampleAt はゴール時に走破距離がレース距離付近', () => {
    const r = simulateRace(MILE, runners, 'sample');
    const out: { x: number; lane: number; v: number }[] = [];
    const w = r.order[0];
    sampleAt(r, r.finishTimes[w], out);
    expect(out[w].x).toBeGreaterThan(1599);
    expect(out[w].x).toBeLessThan(1602);
    sampleAt(r, 0, out);
    out.forEach((o) => expect(o.x).toBe(0));
  });
});

describe('simulateRace: 能力と条件が結果に影響する', () => {
  it('能力が大きく上の馬はよく勝つが、必ず勝つわけではない', () => {
    const hs = Array.from({ length: 10 }, (_, i) => horse(`n${i}`));
    hs[4] = horse('star', { speed: 92, stamina: 85, accel: 90 });
    const rate = winRate(MILE, field(hs), 4);
    expect(rate).toBeGreaterThan(0.45);
    expect(rate).toBeLessThan(1);
  });

  it('逃げ馬が多いとハイペースになりやすい', () => {
    const highRate = (nigeCount: number) => {
      const hs = Array.from({ length: 12 }, (_, i) =>
        horse(`p${i}`, { style: i < nigeCount ? 'nige' : i % 2 ? 'sashi' : 'senko' }),
      );
      let high = 0;
      for (let s = 0; s < 80; s++) if (simulateRace(MILE, field(hs), `pace${s}`, { record: false }).pace === 'high') high++;
      return high / 80;
    };
    expect(highRate(4)).toBeGreaterThan(highRate(0) + 0.2);
  });

  it('ハイペースでは差し・追込が、スローでは逃げ・先行が有利になる', () => {
    const closerShare = (nigeCount: number) => {
      const hs = Array.from({ length: 12 }, (_, i) =>
        horse(`c${i}`, { style: i < nigeCount ? 'nige' : i < 6 ? 'senko' : i < 9 ? 'sashi' : 'oikomi' }),
      );
      let closers = 0;
      for (let s = 0; s < 120; s++) {
        const r = simulateRace(MILE, field(hs), `cs${s}`, { record: false });
        const st = r.factors[r.order[0]].style;
        if (st === 'sashi' || st === 'oikomi') closers++;
      }
      return closers / 120;
    };
    expect(closerShare(4)).toBeGreaterThan(closerShare(1));
  });

  it('道悪適性: 重馬場では適性Aの馬が適性Dの馬に先着しやすい', () => {
    const beatRate = (going: RaceConditions['going']) => {
      const hs = Array.from({ length: 8 }, (_, i) => horse(`g${i}`));
      hs[0] = horse('mudA', { heavy: 'A' });
      hs[1] = horse('mudD', { heavy: 'D' });
      let ahead = 0;
      for (let s = 0; s < 100; s++) {
        const r = simulateRace({ ...MILE, going, weather: going === 'good' ? 'sunny' : 'rain' }, field(hs), `m${s}`, {
          record: false,
        });
        if (r.order.indexOf(0) < r.order.indexOf(1)) ahead++;
      }
      return ahead / 100;
    };
    expect(beatRate('heavy')).toBeGreaterThan(0.65);
    expect(beatRate('heavy')).toBeGreaterThan(beatRate('good') + 0.1);
  });

  it('距離適性: 長距離ではステイヤー、短距離ではスプリンターが優位', () => {
    const hs = Array.from({ length: 8 }, (_, i) => horse(`d${i}`, { bestDistance: 1800 }));
    hs[0] = horse('stayer', { bestDistance: 2400, stamina: 88, speed: 72 });
    hs[1] = horse('sprinter', { bestDistance: 1200, stamina: 58, speed: 82 });
    const cmp = (distance: number) => {
      let stayerAhead = 0;
      for (let s = 0; s < 80; s++) {
        const r = simulateRace({ ...MILE, distance }, field(hs), `dist${s}`, { record: false });
        if (r.order.indexOf(0) < r.order.indexOf(1)) stayerAhead++;
      }
      return stayerAhead / 80;
    };
    expect(cmp(2400)).toBeGreaterThan(0.6);
    expect(cmp(1200)).toBeLessThan(0.4);
  });

  it('外枠ほどコーナーでのロス距離が大きい傾向', () => {
    const hs = Array.from({ length: 14 }, (_, i) => horse(`l${i}`));
    let inner = 0;
    let outer = 0;
    for (let s = 0; s < 30; s++) {
      const r = simulateRace(MILE, field(hs), `lane${s}`, { record: false });
      inner += r.factors.slice(0, 3).reduce((a, f) => a + f.laneLoss, 0);
      outer += r.factors.slice(-3).reduce((a, f) => a + f.laneLoss, 0);
    }
    expect(outer).toBeGreaterThan(inner);
  });
});

describe('meeting: 開催生成とコミット・リビール', () => {
  const fixedSeeds = () => {
    let i = 0;
    return () => `seed-${i++}`;
  };

  it('枠番の割り当て', () => {
    expect(Array.from({ length: 8 }, (_, i) => frameOf(8, i + 1))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from({ length: 10 }, (_, i) => frameOf(10, i + 1))).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 8, 8]);
    expect(Array.from({ length: 16 }, (_, i) => frameOf(16, i + 1))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
  });

  it('同じ開催IDからは同じ出走表が生成される', async () => {
    const a = await createMeeting('day-1', fixedSeeds());
    const b = await createMeeting('day-1', fixedSeeds());
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    for (const c of a) {
      expect(c.entries.length).toBeGreaterThanOrEqual(9);
      expect(c.entries.length).toBeLessThanOrEqual(14);
      expect(new Set(c.entries.map((e) => e.horseId)).size).toBe(c.entries.length);
      expect(new Set(c.entries.map((e) => e.jockey)).size).toBe(c.entries.length);
    }
  });

  it('コミットは SHA-256(raceId|seed|engineVersion)', async () => {
    const [card] = await createMeeting('day-2', fixedSeeds());
    expect(card.commit).toBe(await sha256Hex(commitInput(card.id, card.seed)));
  });

  it('公開された seed で結果を再現・検証でき、改ざんされた seed は検出される', async () => {
    const [card] = await createMeeting('day-3', fixedSeeds());
    const official = runRace(card, card.seed);
    const ok = await verifyRace(card, card.seed);
    expect(ok.hashOk).toBe(true);
    expect(ok.order).toEqual(official.order.map((i) => card.entries[i].number));
    const ng = await verifyRace(card, 'tampered');
    expect(ng.hashOk).toBe(false);
  });
});

describe('表示用ユーティリティ', () => {
  it('着差表記', () => {
    expect(marginLabel(0.02)).toBe('ハナ');
    expect(marginLabel(0.2)).toBe('クビ');
    expect(marginLabel(1.0)).toBe('1');
    expect(marginLabel(2.5)).toBe('2 1/2');
    expect(marginLabel(12)).toBe('大差');
  });
  it('タイム表記（繰り上がりを含む）', () => {
    expect(formatTime(95.34)).toBe('1:35.3');
    expect(formatTime(119.97)).toBe('2:00.0');
    expect(formatTime(58.2)).toBe('58.2');
  });
});
