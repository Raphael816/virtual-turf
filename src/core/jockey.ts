/**
 * 騎手（第9段階）。騎手は「能力の補正値ひとつ」ではなく、8つの技術がレースの別々の場面に効く：
 *
 * | 技術 | 効く場面（sim.ts） |
 * |---|---|
 * | スタート技術 start | ゲートの反応の遅れ・出遅れの確率 |
 * | 位置取り position | 狙った位置を取れるか（位置取りのばらつき）、外にいるとき前の馬の後ろへ入る判断 |
 * | ペース判断 pace | 道中で脚を溜める効率 |
 * | 折り合い settle | 掛かる確率 |
 * | 仕掛けの判断 timing | 仕掛けの地点のばらつき |
 * | コーナリング corner | コーナーで外を回る距離損・コーナーでの減速 |
 * | 追う技術 drive | 末脚の伸び・叩き合いの強さ |
 * | 判断の安定性 steady | その日の騎乗の出来のばらつき |
 *
 * さらに、得意な競馬場・距離・芝ダート（適性）と、馬との相性（決まった相性＋乗り慣れ＋脚質の合い方）で、その日の技術が少し上下する。
 * 効果の大きさは、同じ馬に上手な騎手と下手な騎手が乗ったときに 1〜2馬身ほどの差になる程度（推定。馬の能力・展開を覆さない）。
 *
 * 減量（JRA 公式。https://www.jra.go.jp/kouza/yougo/w574.html ）：特別競走・ハンデキャップ競走以外で、
 * 男性の見習騎手は 30勝以下 3kg（▲）・31〜50勝 2kg（△）・51〜100勝 1kg（☆）、
 * 女性騎手は 見習で50勝以下 4kg（★）・51〜100勝 3kg（◆）、見習でなければ 2kg（◇）。
 * 見習騎手は免許を受けてから5年未満の騎手（筆者の知識による。公式ページでは確認していない）。
 *
 * 登場する騎手はすべて架空。
 */
import type { RunningStyle } from '../data/roster';
import type { VenueId } from '../data/venues';
import { VENUE_IDS } from '../data/venues';
import { Rng } from './rng';

export const SKILL_KEYS = ['start', 'position', 'pace', 'settle', 'timing', 'corner', 'drive', 'steady'] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];
export type Skills = Record<SkillKey, number>;
export const SKILL_LABEL: Record<SkillKey, string> = {
  start: 'スタート技術',
  position: '位置取り',
  pace: 'ペース判断',
  settle: '折り合い',
  timing: '仕掛けの判断',
  corner: 'コーナリング',
  drive: '追う技術',
  steady: '判断の安定性',
};
export const SKILL_HELP: Record<SkillKey, string> = {
  start: 'ゲートを速く出す。出遅れが少ない',
  position: '狙った位置を取る。外枠でもうまく内へ入れる',
  pace: '道中で無駄な脚を使わず、脚を溜める',
  settle: '行きたがる馬をなだめる（掛かりにくい）',
  timing: 'ちょうどよい地点で仕掛ける',
  corner: 'コーナーを小さく回り、距離の損を抑える',
  drive: '直線で馬を伸ばす。叩き合いに強い',
  steady: '騎乗の出来が安定している',
};

export type DistBand = 'sprint' | 'mile' | 'middle' | 'long';
export function bandOf(distance: number): DistBand {
  return distance < 1400 ? 'sprint' : distance < 1800 ? 'mile' : distance <= 2200 ? 'middle' : 'long';
}
export const BAND_LABEL: Record<DistBand, string> = { sprint: '短距離', mile: 'マイル', middle: '中距離', long: '長距離' };

export interface Jockey {
  id: string;
  name: string;
  sex: '男' | '女';
  /** 免許を受けてからの年数（ゲーム開始時点） */
  years: number;
  /** 技術（0〜100） */
  skills: Skills;
  /** 得意な競馬場（2場）・距離・芝ダート・脚質 */
  venues: VenueId[];
  band: DistBand;
  surface: 'turf' | 'dirt' | 'both';
  style: 'front' | 'closer' | 'any';
  /** ゲーム開始時点の通算勝利数（減量の判定に使う） */
  baseWins: number;
}

/** [名前, 性別, 年数, 技術の基準（0〜100）] */
const SEEDS: [string, Jockey['sex'], number, number][] = [
  ['早川 蓮', '男', 18, 88],
  ['黒澤 誠司', '男', 24, 86],
  ['藤堂 隼人', '男', 15, 84],
  ['久遠 拓海', '男', 12, 82],
  ['水城 葵', '女', 11, 80],
  ['佐伯 透', '男', 21, 80],
  ['朝比奈 健', '男', 16, 78],
  ['鷹野 翔', '男', 9, 78],
  ['霧島 湊', '男', 13, 76],
  ['真壁 律', '男', 19, 75],
  ['天野 陽', '男', 8, 75],
  ['南條 結衣', '女', 9, 74],
  ['神楽 蒼真', '男', 14, 73],
  ['氷室 迅', '男', 7, 73],
  ['白石 楓', '女', 7, 72],
  ['東雲 樹', '男', 22, 71],
  ['桐谷 悠', '男', 10, 70],
  ['相馬 大地', '男', 17, 69],
  ['岬 ひより', '女', 6, 69],
  ['葛城 航', '男', 6, 68],
  ['篠宮 岳', '男', 26, 67],
  ['柚木 玲奈', '女', 5, 66],
  ['鳴海 颯', '男', 4, 66],
  ['日向 さくら', '女', 3, 63],
  ['伊吹 翼', '男', 3, 62],
  ['七瀬 光', '男', 2, 60],
  ['結城 凛', '女', 2, 59],
  ['橘 小春', '女', 1, 56],
  ['雨宮 遥', '男', 1, 55],
  ['柊 美月', '女', 0, 53],
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function build(i: number, [name, sex, years, base]: (typeof SEEDS)[number]): Jockey {
  const id = `j${String(i + 1).padStart(2, '0')}`;
  const rng = new Rng(`jockey:${id}`);
  const skills = {} as Skills;
  for (const k of SKILL_KEYS) skills[k] = Math.round(clamp(base + rng.normal(0, 7), 35, 97));
  // 経験：年数が長いほどペース判断・判断の安定性が高く、若手は低い
  const exp = clamp((years - 8) * 0.8, -8, 8);
  skills.pace = Math.round(clamp(skills.pace + exp, 35, 97));
  skills.steady = Math.round(clamp(skills.steady + exp, 35, 97));
  const venues = rng.shuffle([...VENUE_IDS]).slice(0, 2);
  const band = rng.pick(['sprint', 'mile', 'middle', 'long'] as DistBand[]);
  const surface = rng.pick(['turf', 'turf', 'dirt', 'both'] as Jockey['surface'][]);
  const style = rng.pick(['front', 'closer', 'any'] as Jockey['style'][]);
  // 通算勝利数（推定）：年に 技術に応じた勝ち数（上位 約90勝、下位 約10勝）を重ねてきたとする。新人は 0
  const perYear = Math.max(4, (base - 50) * 2.3);
  const baseWins = Math.round(years * perYear * (0.8 + rng.next() * 0.4));
  return { id, name, sex, years, skills, venues, band, surface, style, baseWins };
}

export const JOCKEY_LIST: Jockey[] = SEEDS.map((s, i) => build(i, s));
export const JOCKEY_BY_ID = new Map(JOCKEY_LIST.map((j) => [j.id, j]));
export const JOCKEY_BY_NAME = new Map(JOCKEY_LIST.map((j) => [j.name, j]));

/** 技術の平均（総合力） */
export function rating(j: Pick<Jockey, 'skills'>): number {
  return SKILL_KEYS.reduce((a, k) => a + j.skills[k], 0) / SKILL_KEYS.length;
}

// ---------------------------------------------------------------- 減量

export interface Allowance {
  kg: number;
  mark: string;
}
/** 見習騎手：免許を受けてから5年未満 */
export function isApprentice(years: number): boolean {
  return years < 5;
}
/** 減量（JRA 公式の表）。special：特別競走、handicap：ハンデキャップ競走（どちらも減量なし） */
export function allowanceOf(sex: Jockey['sex'], years: number, wins: number, special: boolean, handicap: boolean): Allowance {
  if (special || handicap) return { kg: 0, mark: '' };
  const app = isApprentice(years) && wins <= 100;
  if (sex === '女') {
    if (app) return wins <= 50 ? { kg: 4, mark: '★' } : { kg: 3, mark: '◆' };
    return { kg: 2, mark: '◇' };
  }
  if (!app) return { kg: 0, mark: '' };
  return wins <= 30 ? { kg: 3, mark: '▲' } : wins <= 50 ? { kg: 2, mark: '△' } : { kg: 1, mark: '☆' };
}

// ---------------------------------------------------------------- 適性・相性

/** 馬との決まった相性（−1〜1。馬と騎手の組み合わせごとに一定） */
export function chemistry(horseId: string, jockeyId: string): number {
  return clamp(new Rng(`chem:${horseId}:${jockeyId}`).normal(0, 0.5), -1, 1);
}

export interface RideContext {
  venue?: VenueId;
  surface: 'turf' | 'dirt';
  distance: number;
  horseId: string;
  horseStyle: RunningStyle;
  /** この馬にこれまで乗った回数（直近の戦績から） */
  ridesTogether: number;
}

export interface RideBonus {
  /** 適性（競馬場・距離・芝ダート）・相性（決まった相性・乗り慣れ・脚質）による技術の上下（0〜100 の単位） */
  venue: number;
  band: number;
  surface: number;
  chemistry: number;
  familiar: number;
  style: number;
  total: number;
}

/**
 * その日の技術の上下（推定）：得意な競馬場 +4、得意な距離 +3（隣の区分は 0、離れた区分 −2）、芝ダート 得意 +2・不得意 −3、
 * 決まった相性 ±4、乗り慣れ 1回につき +1（3回まで）、脚質が合う +2・合わない −2
 */
export function rideBonus(j: Jockey, c: RideContext): RideBonus {
  const venue = c.venue && j.venues.includes(c.venue) ? 4 : 0;
  const bands: DistBand[] = ['sprint', 'mile', 'middle', 'long'];
  const d = Math.abs(bands.indexOf(bandOf(c.distance)) - bands.indexOf(j.band));
  const band = d === 0 ? 3 : d === 1 ? 0 : -2;
  const surface = j.surface === 'both' ? 0 : j.surface === c.surface ? 2 : -3;
  const chem = Math.round(chemistry(c.horseId, j.id) * 4 * 10) / 10;
  const familiar = Math.min(3, c.ridesTogether);
  const front = c.horseStyle === 'nige' || c.horseStyle === 'senko';
  const style = j.style === 'any' ? 0 : (j.style === 'front') === front ? 2 : -2;
  return { venue, band, surface, chemistry: chem, familiar, style, total: venue + band + surface + chem + familiar + style };
}

/** 出走表に写す、その日の騎乗（レースの計算・検証に使う） */
export interface Ride {
  id: string;
  /** その日の技術（0〜1。適性・相性を加えたあと） */
  skills: Skills;
  /** 適性・相性による上下の合計（表示用） */
  bonus: number;
  /** 減量 (kg) と印 */
  allowance: number;
  mark: string;
}

export function makeRide(j: Jockey, c: RideContext, allowance: Allowance): Ride {
  const b = rideBonus(j, c);
  const skills = {} as Skills;
  for (const k of SKILL_KEYS) skills[k] = Math.round(clamp(j.skills[k] + b.total, 20, 100)) / 100;
  return { id: j.id, skills, bonus: Math.round(b.total * 10) / 10, allowance: allowance.kg, mark: allowance.mark };
}

/** 技術の基準（この値の騎手は補正なし。出走する騎手のおおよその平均） */
export const SKILL_NEUTRAL = 0.72;

// ---------------------------------------------------------------- 成績

export interface JockeyStats {
  rides: number;
  wins: number;
  seconds: number;
  thirds: number;
  /** 今年 */
  yRides: number;
  yWins: number;
  /** 獲得した本賞金の合計（万円） */
  prize: number;
}
export type JockeyTable = Record<string, JockeyStats>;

export function initialJockeyTable(): JockeyTable {
  return Object.fromEntries(JOCKEY_LIST.map((j) => [j.id, { rides: 0, wins: 0, seconds: 0, thirds: 0, yRides: 0, yWins: 0, prize: 0 }]));
}

/** 通算勝利数（ゲーム開始前の分を含む）と、免許を受けてからの年数 */
export function careerWins(j: Jockey, table: JockeyTable | undefined): number {
  return j.baseWins + (table?.[j.id]?.wins ?? 0);
}
export function yearsOf(j: Jockey, startYear: number, year: number): number {
  return j.years + (year - startYear);
}
