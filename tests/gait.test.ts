import { describe, expect, it } from 'vitest';
import {
  type GaitTraits,
  type LegSpec,
  dutyFactor,
  footTarget,
  legOffset,
  solveTwoBone,
  strideFrequency,
} from '../src/render/three/gait';

const T: GaitTraits = { freqScale: 1, dutyOffset: 0, lead: 'right', lift: 1 };
const FORE: LegSpec = { id: 'FL', fore: true, ax: 0.55, ay: 0.98, l1: 0.42, l2: 0.3, pastern: 0.2 };
const HIND: LegSpec = { id: 'HL', fore: false, ax: -0.45, ay: 1.05, l1: 0.46, l2: 0.36, pastern: 0.2 };

describe('2関節IK', () => {
  it('届く範囲の目標には、先端がぴったり一致する', () => {
    for (const [tx, ty] of [[0.6, 0.3], [0.9, 0.5], [0.3, 0.45], [0.55, 0.35]]) {
      const r = solveTwoBone(FORE.ax, FORE.ay, tx, ty, FORE.l1, FORE.l2, 1);
      const ex = r.jx + FORE.l2 * Math.sin(r.a2);
      const ey = r.jy - FORE.l2 * Math.cos(r.a2);
      expect(r.reached).toBe(true);
      expect(ex).toBeCloseTo(tx, 6);
      expect(ey).toBeCloseTo(ty, 6);
    }
  });

  it('前肢の膝は前へ、後肢の飛節は後ろへ曲がる', () => {
    const f = solveTwoBone(0, 1, 0, 0.4, 0.4, 0.3, 1);
    const h = solveTwoBone(0, 1, 0, 0.4, 0.4, 0.3, -1);
    expect(f.jx).toBeGreaterThan(0);
    expect(h.jx).toBeLessThan(0);
  });

  it('届かない目標では脚を伸ばしきる（関節が破綻しない）', () => {
    const r = solveTwoBone(0, 1, 0, -2, 0.4, 0.3, 1);
    expect(r.reached).toBe(false);
    expect(r.a1).toBeCloseTo(r.a2, 3);
  });
});

describe('襲歩の歩様', () => {
  it('競走速度で1秒あたり約2.4完歩、着地時間は短い', () => {
    expect(strideFrequency(17, T)).toBeGreaterThan(2.3);
    expect(strideFrequency(17, T)).toBeLessThanOrEqual(2.45);
    expect(dutyFactor(17, T)).toBeLessThan(0.25);
    expect(dutyFactor(3, T)).toBeGreaterThan(0.5);
  });

  it('右手前の着地順は 左後 → 右後 → 左前 → 右前', () => {
    const o = (['HL', 'HR', 'FL', 'FR'] as const).map((id) => legOffset(id, T));
    expect([...o].sort((a, b) => a - b)).toEqual(o);
    const left = (['HR', 'HL', 'FR', 'FL'] as const).map((id) => legOffset(id, { ...T, lead: 'left' }));
    expect([...left].sort((a, b) => a - b)).toEqual(left);
  });

  it('着地中の蹄は世界座標で止まっている（滑らない）', () => {
    for (const v of [8, 14, 17]) {
      for (const leg of [FORE, HIND]) {
        const f = strideFrequency(v, T);
        const dt = 1 / 240;
        let prevWorld: number | null = null;
        let maxSlip = 0;
        let stanceFrames = 0;
        for (let i = 0; i < 480; i++) {
          const time = i * dt;
          const phase = f * time;
          const ft = footTarget(leg, phase, phase - f * dt, v, T);
          const world = v * time + ft.x; // 体は速度 v で前進
          if (ft.stance && prevWorld !== null && !ft.justLanded) {
            maxSlip = Math.max(maxSlip, Math.abs(world - prevWorld));
            stanceFrames++;
          }
          prevWorld = ft.stance ? world : null;
        }
        expect(stanceFrames).toBeGreaterThan(10);
        expect(maxSlip).toBeLessThan(1e-6);
      }
    }
  });

  it('着地中は地面の高さ、遊脚中は地面より上', () => {
    let sawSwing = false;
    for (let p = 0; p < 1; p += 0.01) {
      const ft = footTarget(FORE, p, p - 0.01, 17, T);
      if (ft.stance) expect(ft.y).toBe(0);
      else {
        expect(ft.y).toBeGreaterThanOrEqual(0);
        sawSwing = true;
      }
    }
    expect(sawSwing).toBe(true);
  });

  it('停止時は4本とも着地', () => {
    for (const leg of [FORE, HIND]) expect(footTarget(leg, 0.3, 0.29, 0, T).stance).toBe(true);
  });
});
