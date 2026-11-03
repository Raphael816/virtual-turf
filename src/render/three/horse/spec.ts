/**
 * 馬ごとの見た目と走り方の仕様（HorseSpec）。
 *
 * 骨格・リグ・走行アニメーション・メッシュの品質は全馬で共通にし、ここで決める値だけを馬ごとに変える：
 * 毛色・模様（白斑・靴下）・体格（体型・寸法）・走り方（ピッチ・接地時間・手前・脚の上げ方・頭の高さ）・馬具。
 *
 * REFERENCE_HORSE は品質の基準として作り込んだ1頭（仮の馬名）。他の馬は specFromLook() で、
 * 基準と同じ範囲の中で個体差をつける。
 */
import type { GaitTraits } from '../gait';
import { seededRandom } from '../noise';
import type { BuildType } from './anatomy';

export interface CoatSpec {
  /** 毛色名（鹿毛・黒鹿毛・青鹿毛・栗毛・栃栗毛・芦毛） */
  name: string;
  base: string;
  /** 脚先・たてがみ・尾の色 */
  points: string;
  mane: string;
  /** 背の濃さ（0〜0.2） */
  darkTop: number;
  /** 芦毛の連銭の強さ（0〜1） */
  dapple: number;
  /** 毛並みの光沢（0〜1） */
  gloss: number;
}

export interface Markings {
  face: 'none' | 'star' | 'stripe' | 'blaze';
  /** 白い靴下の高さ (m)。[左前, 右前, 左後, 右後] */
  socks: [number, number, number, number];
}

export interface BuildSpec {
  type: BuildType;
  /** 体長・体高・幅の倍率 */
  length: number;
  height: number;
  width: number;
}

export interface GaitSpec extends GaitTraits {
  /** 頭の高さの癖（ラジアン、正で高い） */
  headCarriage: number;
  /** 完歩の位相の初期値 */
  phase: number;
  /** 首の振りの大きさ */
  nod: number;
}

export interface TackSpec {
  number: number;
  /** 騎手の勝負服 [主色, 副色, 柄] と帽子の色 */
  silks: [string, string, number];
  cap: string;
  /** 鞍下ゼッケンの色 */
  cloth: string;
  /** メンコ（耳覆い）を着けるか */
  hood: boolean;
}

export interface HorseSpec {
  id: string;
  name: string;
  coat: CoatSpec;
  markings: Markings;
  build: BuildSpec;
  gait: GaitSpec;
  tack: TackSpec;
}

const COATS: Record<string, Omit<CoatSpec, 'name' | 'base'>> = {
  鹿毛: { points: '#121010', mane: '#141110', darkTop: 0.12, dapple: 0, gloss: 0.8 },
  黒鹿毛: { points: '#0e0c0b', mane: '#0f0d0c', darkTop: 0.2, dapple: 0, gloss: 0.85 },
  青鹿毛: { points: '#0b0a0a', mane: '#0c0b0b', darkTop: 0.1, dapple: 0, gloss: 0.9 },
  栗毛: { points: '#7a3e1c', mane: '#a35a2a', darkTop: 0.06, dapple: 0, gloss: 0.75 },
  栃栗毛: { points: '#4a2412', mane: '#5a3420', darkTop: 0.1, dapple: 0, gloss: 0.7 },
  芦毛: { points: '#3c3a38', mane: '#8d8a86', darkTop: 0, dapple: 0.8, gloss: 0.55 },
};

/** 品質の基準となる1頭（仮の馬名・架空） */
export const REFERENCE_HORSE: HorseSpec = {
  id: 'reference',
  name: 'アカツキベイ（仮）',
  coat: { name: '鹿毛', base: '#6e3d1f', ...COATS['鹿毛'] },
  markings: { face: 'star', socks: [0, 0, 0.16, 0] },
  build: { type: 'standard', length: 1, height: 1, width: 1 },
  gait: { freqScale: 1, dutyOffset: 0, lead: 'right', lift: 1, headCarriage: 0, phase: 0.1, nod: 1 },
  tack: { number: 7, silks: ['#0d47a1', '#fafafa', 1], cap: '#f2cc1f', cloth: '#f3f2ee', hood: false },
};

/** 既存の出走馬の情報から、基準と同じ範囲の中で個体差をつけた仕様を作る */
export function specFromLook(look: { id: string; name?: string; coat: string; coatColor: string; number: number; capColor: string }): HorseSpec {
  const rnd = seededRandom(`horse:${look.id}`);
  const coatBase = COATS[look.coat] ?? COATS['鹿毛'];
  const builds: BuildType[] = ['lean', 'standard', 'standard', 'muscular'];
  const faces: Markings['face'][] = ['none', 'none', 'star', 'stripe', 'blaze'];
  const sock = () => (rnd() < 0.22 ? 0.08 + rnd() * 0.22 : 0);
  const silkRnd = seededRandom(`silks:${look.id}`);
  const SILK = ['#b71c1c', '#0d47a1', '#1b5e20', '#f9a825', '#4a148c', '#e65100', '#006064', '#880e4f', '#263238', '#fafafa', '#3e2723', '#1a237e'];
  const silk = SILK[Math.floor(silkRnd() * SILK.length)];
  let silk2 = SILK[Math.floor(silkRnd() * SILK.length)];
  if (silk2 === silk) silk2 = SILK[(SILK.indexOf(silk) + 5) % SILK.length];
  return {
    id: look.id,
    name: look.name ?? look.id,
    coat: { name: look.coat, base: look.coatColor, ...coatBase, gloss: coatBase.gloss * (0.9 + rnd() * 0.2) },
    markings: { face: faces[Math.floor(rnd() * faces.length)], socks: [sock(), sock(), sock(), sock()] },
    build: {
      type: builds[Math.floor(rnd() * builds.length)],
      length: 0.97 + rnd() * 0.06,
      height: 0.97 + rnd() * 0.06,
      width: 0.96 + rnd() * 0.08,
    },
    gait: {
      freqScale: 0.96 + rnd() * 0.08,
      dutyOffset: (rnd() - 0.5) * 0.04,
      lead: rnd() < 0.5 ? 'left' : 'right',
      lift: 0.88 + rnd() * 0.24,
      headCarriage: (rnd() - 0.5) * 0.12,
      phase: rnd(),
      nod: 0.85 + rnd() * 0.3,
    },
    tack: { number: look.number, silks: [silk, silk2, Math.floor(silkRnd() * 6)], cap: look.capColor, cloth: '#f3f2ee', hood: rnd() < 0.2 },
  };
}
