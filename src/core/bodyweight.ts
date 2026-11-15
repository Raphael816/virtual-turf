/**
 * 馬体重（第10段階）。
 *
 * JRA は出走馬の馬体重を 2kg 単位で発表し、前走からの増減を併せて示す（公式の出馬表・成績表の表記）。
 * ゲームでは、馬体重を「馬の状態の表れ」として計算する。馬体重そのものがレースの計算に効くのではなく、
 * 馬体重を動かしている要素（疲労・仕上がり・休み明け・成長）が、調子や能力を通してレースに効く。
 * 下の数値はすべて推定（docs/15-results-paper.md）。
 *
 * - 完成時の体重：牡・セン 488kg、牝 464kg を中心に ±22kg の個体差。パワーのある馬は少し重い
 * - 成長：2歳の夏は完成時の約 −5%、4歳で完成
 * - 仕上がり：強めの調教で絞れる（仕上がり 50 を普通として ±5kg）
 * - 疲労：疲労が残っていると減る（最大 −8kg）
 * - 休み明け：10週以上空くと増える（最大 +14kg）
 * - 当日のばらつき：±2.5kg（標準偏差）
 */
import { bioAge } from './lifecycle';
import { Rng } from './rng';
import { type GameDate, type WorldHorse, weeksBetween } from './world';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** 完成時（4歳以上・普通の状態）の体重 (kg) */
export function matureWeight(h: Pick<WorldHorse, 'id' | 'sex' | 'power'>): number {
  const rng = new Rng(`bw:${h.id}`);
  return clamp((h.sex === '牝' ? 464 : 488) + rng.normal(0, 22) + (h.power - 70) * 0.4, 400, 560);
}

/** 状態による増減の内訳 (kg)。画面の説明にも使う */
export function weightParts(h: WorldHorse, date: GameDate): { grow: number; fit: number; fatigue: number; rest: number } {
  const base = matureWeight(h);
  const age = bioAge(h.birthYear, date);
  const grow = -base * 0.05 * clamp((4 - age) / 2, 0, 1);
  const fit = -((h.life.fitness ?? 50) - 50) * 0.1;
  const fatigue = -h.life.fatigue * 0.08;
  const weeks = h.lastRun ? weeksBetween(h.lastRun, date) : 0;
  const rest = weeks >= 10 ? Math.min(14, weeks - 8) : 0;
  return { grow, fit, fatigue, rest };
}

/** 出走時の馬体重 (kg。2kg 単位)。key は開催の ID（同じ開催では同じ値になる） */
export function bodyWeight(h: WorldHorse, date: GameDate, key: string): number {
  const p = weightParts(h, date);
  const noise = new Rng(`bwd:${key}:${h.id}`).normal(0, 2.5);
  return Math.round((matureWeight(h) + p.grow + p.fit + p.fatigue + p.rest + noise) / 2) * 2;
}

/** 「478(+4)」の形。前走の記録がないときは増減を付けない */
export function bodyText(bw: number | undefined, diff: number | undefined, first = false): string {
  if (bw === undefined) return '—';
  if (first) return `${bw}(初)`;
  if (diff === undefined) return `${bw}`;
  return `${bw}(${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)})`;
}
