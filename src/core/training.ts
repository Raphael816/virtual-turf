/**
 * 調教・育成（第4段階）。
 *
 * 調教は「能力を上げるボタン」ではなく、刺激（鍛え具合・仕上がり）と負担（疲労・精神的疲労・故障の危険）の釣り合いで考える。
 * - メニューごとに、刺激する能力・強さ・疲労・故障の危険が違う
 * - 効果は年齢（若いほど伸びる）・疲労（疲れていると効きにくい）・健康・同じメニューの繰り返し（慣れ）・鍛え具合（上限に近いほど小さい）で変わる
 * - 鍛え具合は能力ごとに 0〜1。現在の能力への影響は成長曲線の ±数%（lifecycle.ts の devFactor）。繰り返しても無限には上がらない
 * - 鍛えないと鍛え具合は少しずつ落ち、仕上がりは休むと下がる
 *
 * 係数は推定値（docs/09-training.md）。週1回、厩舎（調教師）が馬の状態を見てメニューを決める（npcPlan）。
 */
import { type GrowthKey, type Life, type TrainRecord, DEV_DEFAULT, GROWTH_KEYS, type Injury } from './lifecycle';
import { Rng } from './rng';

export type MenuId = 'hill' | 'wood' | 'turf' | 'dirt' | 'canter' | 'light' | 'strong' | 'rest';

export interface Menu {
  id: MenuId;
  label: string;
  /** 刺激する能力と重み */
  stim: Partial<Record<GrowthKey, number>>;
  /** 刺激の強さ（0〜1） */
  intensity: number;
  /** 疲労・精神的疲労の増減 */
  fatigue: number;
  mental: number;
  /** 仕上がりの増減 */
  fitness: number;
  /** 1回あたりの故障の確率（平均的な状態） */
  risk: number;
  description: string;
}

export const MENUS: Menu[] = [
  { id: 'hill', label: '坂路', stim: { power: 1, accel: 0.7, stamina: 0.4 }, intensity: 0.7, fatigue: 9, mental: 1, fitness: 5, risk: 0.0005, description: '上り坂を駆け上がる。脚への衝撃が小さく、パワーと瞬発力を鍛える' },
  { id: 'wood', label: 'ウッドチップ', stim: { stamina: 1, sustain: 0.8 }, intensity: 0.6, fatigue: 8, mental: 0, fitness: 4, risk: 0.0004, description: 'クッションの効いた周回コース。長めに乗ってスタミナと持続力を鍛える' },
  { id: 'turf', label: '芝コース', stim: { speed: 1, accel: 0.5 }, intensity: 0.7, fatigue: 8, mental: 2, fitness: 5, risk: 0.0009, description: '実戦に近い速さで走らせる。スピードを鍛えるが脚への負担はやや大きい' },
  { id: 'dirt', label: 'ダートコース', stim: { power: 0.8, stamina: 0.7 }, intensity: 0.6, fatigue: 8, mental: 1, fitness: 4, risk: 0.0006, description: '砂の上で負荷をかける。パワーとスタミナを鍛える' },
  { id: 'canter', label: 'キャンター', stim: { stamina: 0.4, sustain: 0.3 }, intensity: 0.3, fatigue: 3, mental: -2, fitness: 1, risk: 0.0002, description: 'ゆったりした駆け足。状態を保ちながら軽く体を動かす' },
  { id: 'light', label: '軽め', stim: {}, intensity: 0.1, fatigue: -2, mental: -4, fitness: -1, risk: 0.0001, description: '軽い運動。疲れを抜きながら気分を整える' },
  { id: 'strong', label: '強めの追い切り', stim: { speed: 1, accel: 1, sustain: 0.6 }, intensity: 1, fatigue: 16, mental: 5, fitness: 12, risk: 0.0018, description: '一杯に追って仕上げる。刺激も仕上がりも大きいが、疲労と故障の危険も大きい' },
  { id: 'rest', label: '休養', stim: {}, intensity: 0, fatigue: -8, mental: -8, fitness: -6, risk: 0, description: '調教を休む（放牧を含む）。疲れと気持ちを回復させるが、仕上がりは落ちる' },
];
export const MENU_BY_ID = Object.fromEntries(MENUS.map((m) => [m.id, m])) as Record<MenuId, Menu>;
export const TRAIN_HISTORY = 10;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 年齢による伸びやすさ（若いほど伸びる。推定） */
export function ageResponse(age: number): number {
  return age < 2.5 ? 1.25 : age < 3.5 ? 1.1 : age < 5 ? 1 : age < 6.5 ? 0.8 : 0.6;
}

export interface TrainContext {
  /** 生まれてからの年数 */
  age: number;
  health: number;
  /** 乱数のキー（年・週・馬） */
  seed: string;
  date: { year: number; week: number };
}

export interface TrainOutcome {
  life: Life;
  /** 故障したか（その名前） */
  injured?: string;
  /** 時計・内容の評価（A〜D） */
  eval: string;
  /** 能力ごとの鍛え具合の増分 */
  gains: Partial<Record<GrowthKey, number>>;
}

/** 調教の故障（軽度が多い。推定） */
const TRAIN_INJURIES: { name: string; severity: Injury['severity']; share: number; weeks: [number, number]; loss: [number, number] }[] = [
  { name: '筋肉痛・捻挫', severity: 'minor', share: 0.55, weeks: [2, 5], loss: [0, 0] },
  { name: '球節炎・ソエ', severity: 'minor', share: 0.25, weeks: [4, 8], loss: [0, 0.01] },
  { name: '骨折', severity: 'moderate', share: 0.15, weeks: [16, 28], loss: [0, 0.03] },
  { name: '屈腱炎', severity: 'severe', share: 0.05, weeks: [40, 60], loss: [0.04, 0.1] },
];

/** 1回の調教の故障の確率 */
export function trainRisk(menu: Menu, life: Life, health: number, age: number): number {
  return menu.risk * (1 + life.fatigue / 30) * (1.45 - health / 100) * (age >= 7 ? 1.3 : 1);
}

/**
 * 1週分の調教を行う。故障中は休養のみ。
 * - 刺激 = 強さ × 年齢 × 疲労（疲れていると効きにくい）× 慣れ（直近4週の同じメニューが多いほど小さい）
 * - 鍛え具合の増分 = 刺激 × 重み × 0.12 × (1 − 鍛え具合)（上限に近いほど小さい）
 * - 刺激のない能力の鍛え具合は少しずつ落ちる（毎週 0.4%、休養では 0.8%）。ふつうに調教している馬は 0.7〜0.8 前後で釣り合う
 * - 仕上がりは毎週、普通（45）へ向かって 12% 戻る
 */
export function train(life: Life, menuId: MenuId, ctx: TrainContext): TrainOutcome {
  const menu = life.injury ? MENU_BY_ID.rest : MENU_BY_ID[menuId];
  const rng = new Rng(`train:${ctx.seed}`);
  const dev = { ...(life.dev ?? Object.fromEntries(GROWTH_KEYS.map((k) => [k, DEV_DEFAULT]))) } as Record<GrowthKey, number>;
  const recent = (life.train ?? []).slice(0, 4).filter((r) => r.m === menu.id).length;
  const monotony = 1 - 0.15 * recent;
  const freshness = clamp(1 - life.fatigue / 80, 0.2, 1);
  const stim = menu.intensity * ageResponse(ctx.age) * freshness * monotony * (0.85 + rng.next() * 0.3);
  const gains: Partial<Record<GrowthKey, number>> = {};
  for (const k of GROWTH_KEYS) {
    const w = menu.stim[k] ?? 0;
    if (w > 0) {
      const g = stim * w * 0.12 * (1 - dev[k]);
      dev[k] = clamp(dev[k] + g, 0, 1);
      gains[k] = g;
    } else {
      dev[k] = clamp(dev[k] - (menu.id === 'rest' ? 0.008 : 0.004), 0, 1);
    }
  }
  // 疲労・精神的疲労・仕上がり（疲れているときに強く追うと、仕上がりは上がりにくく気持ちが参る）
  const fatigue = clamp(life.fatigue + menu.fatigue * (menu.fatigue > 0 ? 1.15 - ctx.health / 400 : 1), 0, 100);
  const mental = clamp(life.mental + menu.mental + (menu.intensity >= 0.7 && life.fatigue > 40 ? 4 : 0), 0, 100);
  const fit0 = life.fitness ?? 50;
  const fitness = clamp(fit0 - 0.12 * (fit0 - 45) + menu.fitness * (menu.fitness > 0 ? freshness : 1), 0, 100);
  // 時計の評価：仕上がりと刺激の強さ、疲労から（新聞の調教評価に使う）
  const score = (fitness - 50) / 25 + stim - life.fatigue / 50 + rng.normal(0, 0.4);
  const evalMark = menu.intensity < 0.5 ? '—' : score > 1.4 ? 'A' : score > 0.8 ? 'B' : score > 0.2 ? 'C' : 'D';
  const rec: TrainRecord = { y: ctx.date.year, w: ctx.date.week, m: menu.id, ...(evalMark !== '—' ? { e: evalMark } : {}) };
  const next: Life = { ...life, dev, fatigue, mental, fitness, train: [rec, ...(life.train ?? [])].slice(0, TRAIN_HISTORY) };
  let injured: string | undefined;
  if (!life.injury && rng.chance(trainRisk(menu, life, ctx.health, ctx.age))) {
    let r = rng.next();
    const kind = TRAIN_INJURIES.find((k) => (r -= k.share) <= 0) ?? TRAIN_INJURIES[0];
    next.injury = { name: kind.name, severity: kind.severity, weeksLeft: rng.int(kind.weeks[0], kind.weeks[1]), loss: rng.range(kind.loss[0], kind.loss[1]) };
    injured = kind.name;
  }
  return { life: next, injured, eval: evalMark, gains };
}

/**
 * 厩舎（調教師）の調教計画（自動）。馬の状態を見て決める：
 * - 故障中・疲労が大きい → 休養、前走の翌週・疲れ気味 → 軽め
 * - 疲れが抜けて仕上がりが低い（休み明け）→ 坂路・ウッドで乗り込む
 * - 仕上がってきたら、3〜4週に1回は強めの追い切り（疲労が小さいときだけ）
 * - それ以外は、馬の弱いところを鍛えるメニュー（例：スタミナが低ければウッド）とキャンターを交互に
 */
export function npcPlan(life: Life, weeksSinceRace: number, weakest: GrowthKey, seed: string): MenuId {
  const rng = new Rng(`plan:${seed}`);
  if (life.injury) return 'rest';
  if (life.fatigue > 45) return 'rest';
  if (weeksSinceRace <= 1 || life.fatigue > 28 || life.mental > 50) return 'light';
  const fit = life.fitness ?? 50;
  const lastStrong = (life.train ?? []).findIndex((r) => r.m === 'strong');
  if (fit >= 48 && life.fatigue < 15 && (lastStrong < 0 || lastStrong >= 3) && rng.chance(0.7)) return 'strong';
  if (fit < 40) return rng.chance(0.5) ? 'hill' : 'wood';
  const forWeak: Record<GrowthKey, MenuId> = { speed: 'turf', accel: 'hill', power: 'hill', stamina: 'wood', sustain: 'wood' };
  const last = life.train?.[0]?.m;
  if (last === 'canter' || last === 'light') return rng.chance(0.75) ? forWeak[weakest] : rng.pick(['hill', 'wood', 'dirt'] as MenuId[]);
  return 'canter';
}

/** 調教の評価（A〜D）の説明 */
export const EVAL_LABEL: Record<string, string> = { A: '好時計・抜群の動き', B: '上々の動き', C: '平凡', D: '動きが重い' };
