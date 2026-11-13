/**
 * JRA 10場のコースデータ（第6段階）。
 *
 * 出典：JRA 公式サイト「コース紹介」（https://www.jra.go.jp/facilities/race/<場>/course/ 。2026年11月に確認）。
 * - 回り・1周距離（芝は Aコース）・直線距離・幅員（Aコースの最小値）・高低差・発走距離は公式の値
 * - コースの形（ゴールから1コーナーまでの距離・コーナーの半径・外回りの分かれ方）は推定。1周距離と直線距離が公式の値になるように形を決める
 * - 起伏の形は公式のコース紹介の文章（どこが上り・下りか、坂の位置と高さ）から作った推定。全体の高低差は公式の値にそろえる
 * - スパイラルカーブ、ポケット（コースの外に張り出した発走地点）、新潟の直線1000mは再現していない（docs/11-venues.md）
 *
 * 競馬場の名前は実在（利用者の選択）。図面・写真・ロゴは使っていない。
 */

export type VenueId = 'sapporo' | 'hakodate' | 'fukushima' | 'niigata' | 'tokyo' | 'nakayama' | 'chukyo' | 'kyoto' | 'hanshin' | 'kokura';
export type Layout = 'inner' | 'outer';

/** 起伏のキー点を決めるときの目印（u は4コーナー出口＝直線の入口からの距離） */
export interface Landmarks {
  /** 1周の距離 */
  C: number;
  /** ゴールの u（＝直線距離） */
  S: number;
  /** 1コーナー入口・2コーナー出口（向正面の始まり）・3コーナー入口（向正面の終わり） */
  c1: number;
  c2: number;
  c3: number;
  /** ゴールまで残り r m の地点の u */
  rem: (r: number) => number;
}
/** [u, 相対的な高さ]。高低差が公式の値になるよう、あとで拡大・縮小する */
export type ElevationKeys = (lm: Landmarks) => [number, number][];

export interface CourseSpec {
  /** 1周の距離 (m) */
  circumference: number;
  /** 直線距離（4コーナー出口からゴールまで） */
  straight: number;
  /** 幅員 (m) */
  width: number;
  /** 高低差 (m) */
  elevation: number;
  /** 起伏の形（推定） */
  keys: ElevationKeys;
}

export interface VenueSpec {
  id: VenueId;
  name: string;
  /** 1 = 右回り、-1 = 左回り（公式） */
  hand: 1 | -1;
  /** 芝の種類（北海道は洋芝） */
  grass: '野芝' | '洋芝';
  /** ゴールから1コーナー入口までの距離（推定。コースの縦横比を決める） */
  goalToTurn: number;
  turf: CourseSpec;
  /** 外回り（中山・京都・阪神・新潟） */
  outer?: CourseSpec;
  dirt: CourseSpec;
  /** 発走距離（公式。3,600m を超える距離と、新潟の直線1000mは除く） */
  distances: { turf: { d: number; layout?: Layout }[]; dirt: number[] };
}

const lin = (...pairs: [number, number][]) => pairs;

/** 平坦に近いコース（札幌・新潟内回り）：ゆるやかな起伏 */
const gentle: ElevationKeys = (l) => lin([l.S, 0.4], [l.c1, 0.6], [l.c2, 1.0], [(l.c2 + l.c3) / 2, 0.7], [l.c3, 0.3], [0, 0.0]);

export const VENUES: Record<VenueId, VenueSpec> = {
  sapporo: {
    id: 'sapporo',
    name: '札幌',
    hand: 1,
    grass: '洋芝',
    goalToTurn: 60, // 「札幌のゴール板は1コーナー寄り」
    turf: { circumference: 1640.9, straight: 266.1, width: 25, elevation: 0.7, keys: gentle },
    dirt: { circumference: 1487, straight: 264.3, width: 20, elevation: 0.9, keys: gentle },
    distances: { turf: [1000, 1200, 1500, 1800, 2000, 2600].map((d) => ({ d })), dirt: [1000, 1700, 2400] },
  },
  hakodate: {
    id: 'hakodate',
    name: '函館',
    hand: 1,
    grass: '洋芝',
    goalToTurn: 150, // 直線の半ば過ぎにゴール
    // ゴールから2コーナーへゆるやかに下り、4コーナーまでだらだらと上り（3〜4コーナーが丘）、直線へなだらかに下る
    turf: {
      circumference: 1626.6, straight: 262.1, width: 29, elevation: 3.5,
      keys: (l) => lin([l.S, 1.5], [l.c1, 0.9], [l.c2, 0.0], [(l.c2 + l.c3) / 2, 1.3], [l.c3, 2.6], [(l.c3 + l.C) / 2, 3.5], [0, 2.4]),
    },
    dirt: {
      circumference: 1475.8, straight: 260.3, width: 20, elevation: 3.5,
      keys: (l) => lin([l.S, 1.5], [l.c1, 0.9], [l.c2, 0.0], [(l.c2 + l.c3) / 2, 1.3], [l.c3, 2.6], [(l.c3 + l.C) / 2, 3.5], [0, 2.4]),
    },
    distances: { turf: [1000, 1200, 1700, 1800, 2000, 2600].map((d) => ({ d })), dirt: [1000, 1700, 2400] },
  },
  fukushima: {
    id: 'fukushima',
    name: '福島',
    hand: 1,
    grass: '野芝',
    goalToTurn: 100,
    // ゴール〜2コーナー下り（1.7m）、向正面上り（1.3m）、平坦、4コーナー〜残り170m下り、残り170〜50m上り（1.2m）
    turf: {
      circumference: 1600, straight: 292, width: 25, elevation: 1.9,
      keys: (l) => lin([l.S, 1.7], [l.c1, 0.9], [l.c2, 0.0], [(l.c2 + l.c3) / 2, 1.3], [l.c3, 1.3], [(l.c3 + l.C) / 2, 1.1], [0, 0.8], [l.rem(170), 0.4], [l.rem(50), 1.6]),
    },
    dirt: {
      circumference: 1444.6, straight: 295.7, width: 20, elevation: 2.1,
      keys: (l) => lin([l.S, 1.7], [l.c1, 0.9], [l.c2, 0.0], [(l.c2 + l.c3) / 2, 1.3], [l.c3, 1.3], [(l.c3 + l.C) / 2, 1.1], [0, 0.8], [l.rem(170), 0.4], [l.rem(50), 1.6]),
    },
    distances: { turf: [1000, 1200, 1700, 1800, 2000, 2600].map((d) => ({ d })), dirt: [1000, 1150, 1700, 2400] },
  },
  niigata: {
    id: 'niigata',
    name: '新潟',
    hand: -1,
    grass: '野芝',
    goalToTurn: 100,
    turf: { circumference: 1623, straight: 358.7, width: 25, elevation: 0.8, keys: gentle },
    // 外回り：向正面から3コーナーへ上り、4コーナーへ高低差1.6mほど下って直線へ
    outer: {
      circumference: 2223, straight: 658.7, width: 25, elevation: 2.2,
      keys: (l) => lin([l.S, 0.4], [l.c1, 0.5], [l.c2, 0.6], [(l.c2 + l.c3) / 2, 1.4], [l.c3, 2.2], [(l.c3 + l.C) / 2, 1.2], [0, 0.0]),
    },
    dirt: { circumference: 1472.5, straight: 353.9, width: 20, elevation: 0.6, keys: gentle },
    distances: {
      turf: [
        ...[1200, 1400, 2000, 2200, 2400].map((d) => ({ d, layout: 'inner' as const })),
        ...[1400, 1600, 1800, 2000, 3000, 3200].map((d) => ({ d, layout: 'outer' as const })),
      ],
      dirt: [1000, 1200, 1700, 1800, 2500],
    },
  },
  tokyo: {
    id: 'tokyo',
    name: '東京',
    hand: -1,
    grass: '野芝',
    goalToTurn: 120,
    // 1コーナー〜向正面半ばに下り（1.9m）、3コーナー手前に上り（1.5m）、その後下り、4コーナー手前から少し上り、
    // 直線の残り460〜300mに上り坂（約2m）
    turf: {
      circumference: 2083.1, straight: 525.9, width: 31, elevation: 2.7,
      keys: (l) => lin([l.S, 2.6], [l.c1, 2.5], [(l.c2 + l.c3) / 2, 0.6], [l.c3 - 40, 2.1], [l.c3 + 20, 2.1], [(l.c3 + l.C) / 2, 1.0], [0, 1.1], [l.rem(460), 0.6], [l.rem(300), 2.6]),
    },
    // 起伏の構成は芝と同じ。直線の上り坂は2.4m
    dirt: {
      circumference: 1899, straight: 501.6, width: 25, elevation: 2.5,
      keys: (l) => lin([l.S, 2.5], [l.c1, 2.4], [(l.c2 + l.c3) / 2, 0.6], [l.c3 - 40, 2.0], [l.c3 + 20, 2.0], [(l.c3 + l.C) / 2, 0.3], [0, 0.1], [l.rem(460), 0.0], [l.rem(300), 2.4]),
    },
    distances: { turf: [1400, 1600, 1800, 2000, 2300, 2400, 2500, 2600, 3400].map((d) => ({ d })), dirt: [1200, 1300, 1400, 1600, 2100, 2400] },
  },
  nakayama: {
    id: 'nakayama',
    name: '中山',
    hand: 1,
    grass: '野芝',
    goalToTurn: 90,
    // 中山は以前からの形（track.ts の専用の作り方）を使う。keys は使わない
    turf: { circumference: 1667.1, straight: 310, width: 20, elevation: 5.3, keys: () => [] },
    outer: { circumference: 1839.7, straight: 310, width: 24, elevation: 5.3, keys: () => [] },
    dirt: { circumference: 1493, straight: 308, width: 20, elevation: 4.5, keys: () => [] },
    distances: {
      turf: [
        { d: 1200, layout: 'outer' },
        { d: 1600, layout: 'outer' },
        { d: 1800, layout: 'inner' },
        { d: 2000, layout: 'inner' },
        { d: 2200, layout: 'outer' },
        { d: 2500, layout: 'inner' },
        { d: 2600, layout: 'outer' },
        { d: 3600, layout: 'inner' },
      ],
      dirt: [1000, 1200, 1700, 1800, 2400, 2500],
    },
  },
  chukyo: {
    id: 'chukyo',
    name: '中京',
    hand: -1,
    grass: '野芝',
    goalToTurn: 100,
    // ゴールからなだらかに上り、向正面半ばが最も高い。直線入口へ下り、直線に向いてすぐ約2mの急坂、ゴールまで200m余り
    turf: {
      circumference: 1705.9, straight: 412.5, width: 28, elevation: 3.5,
      keys: (l) => lin([l.S, 2.0], [l.c1, 2.5], [l.c2, 3.2], [(l.c2 + l.c3) / 2, 3.5], [l.c3, 2.6], [(l.c3 + l.C) / 2, 1.2], [0, 0.0], [l.rem(370), 0.0], [l.rem(240), 2.0]),
    },
    dirt: {
      circumference: 1530, straight: 410.7, width: 25, elevation: 3.4,
      keys: (l) => lin([l.S, 2.0], [l.c1, 2.5], [l.c2, 3.2], [(l.c2 + l.c3) / 2, 3.4], [l.c3, 2.6], [(l.c3 + l.C) / 2, 1.2], [0, 0.0], [l.rem(370), 0.0], [l.rem(240), 2.0]),
    },
    distances: { turf: [1200, 1300, 1400, 1600, 2000, 2200, 3000].map((d) => ({ d })), dirt: [1200, 1400, 1800, 1900, 2500] },
  },
  kyoto: {
    id: 'kyoto',
    name: '京都',
    hand: 1,
    grass: '野芝',
    goalToTurn: 120,
    // 3コーナーの丘：向正面の半ばから3コーナーへ上り、4コーナーへ一気に下る。それ以外はほぼ平坦（頂上は残り800m付近）
    turf: {
      circumference: 1782.8, straight: 328.4, width: 27, elevation: 3.1,
      keys: (l) => lin([l.S, 0.3], [l.c1, 0.3], [l.c2, 0.2], [(l.c2 + l.c3) / 2, 0.0], [l.rem(800), 3.1], [(l.rem(800) + l.C) / 2, 1.2], [0, 0.3]),
    },
    outer: {
      circumference: 1894.3, straight: 403.7, width: 24, elevation: 4.3,
      // 外回りは内回りと分かれた3コーナーで、内回りより高い所（4.3m）を通る
      keys: (l) => lin([l.S, 0.3], [l.c1, 0.3], [l.c2, 0.2], [(l.c2 + l.c3) / 2, 0.0], [l.c3 + 0.3 * (l.C - l.c3), 4.3], [l.c3 + 0.7 * (l.C - l.c3), 1.5], [0, 0.3]),
    },
    dirt: {
      circumference: 1607.6, straight: 329.1, width: 25, elevation: 3.0,
      keys: (l) => lin([l.S, 0.3], [l.c1, 0.3], [l.c2, 0.2], [(l.c2 + l.c3) / 2, 0.0], [l.rem(800), 3.0], [(l.rem(800) + l.C) / 2, 1.2], [0, 0.3]),
    },
    distances: {
      turf: [
        { d: 1100, layout: 'inner' },
        { d: 1200, layout: 'inner' },
        { d: 1400, layout: 'inner' },
        { d: 1400, layout: 'outer' },
        { d: 1600, layout: 'inner' },
        { d: 1600, layout: 'outer' },
        { d: 1800, layout: 'outer' },
        { d: 2000, layout: 'inner' },
        { d: 2200, layout: 'outer' },
        { d: 2400, layout: 'outer' },
        { d: 3000, layout: 'outer' },
        { d: 3200, layout: 'outer' },
      ],
      dirt: [1000, 1100, 1200, 1400, 1800, 1900, 2600],
    },
  },
  hanshin: {
    id: 'hanshin',
    name: '阪神',
    hand: 1,
    grass: '野芝',
    goalToTurn: 120,
    // 内回りは残り800m、外回りは残り600mから直線の半ばへゆるやかに下り、ゴール前に急坂（高低差1.8m・勾配1.5%）
    turf: {
      circumference: 1689, straight: 356.5, width: 24, elevation: 1.9,
      keys: (l) => lin([l.S, 1.9], [l.c1, 1.9], [l.rem(800), 1.9], [l.rem(200), 0.0], [l.rem(80), 1.8]),
    },
    outer: {
      circumference: 2089, straight: 473.6, width: 24, elevation: 2.4,
      keys: (l) => lin([l.S, 1.9], [l.c1, 1.9], [(l.c2 + l.c3) / 2, 2.4], [l.rem(600), 2.1], [l.rem(200), 0.0], [l.rem(80), 1.8]),
    },
    // ダート：残り900mから直線へゆるやかに下り、残り200mに高低差1.6mの上り坂
    dirt: {
      circumference: 1517.6, straight: 352.7, width: 22, elevation: 1.6,
      keys: (l) => lin([l.S, 1.6], [l.c1, 1.6], [l.rem(900), 1.6], [l.rem(200), 0.0], [l.rem(60), 1.6]),
    },
    distances: {
      turf: [
        { d: 1200, layout: 'inner' },
        { d: 1400, layout: 'inner' },
        { d: 1400, layout: 'outer' },
        { d: 1600, layout: 'outer' },
        { d: 1800, layout: 'outer' },
        { d: 2000, layout: 'inner' },
        { d: 2200, layout: 'inner' },
        { d: 2400, layout: 'outer' },
        { d: 2600, layout: 'outer' },
        { d: 3000, layout: 'inner' },
      ],
      dirt: [1200, 1400, 1800, 2000, 2600],
    },
  },
  kokura: {
    id: 'kokura',
    name: '小倉',
    hand: 1,
    grass: '野芝',
    goalToTurn: 100,
    // ゴールから2コーナーへゆるやかに上り、2コーナーから向正面、3〜4コーナーへ下る（3コーナー手前にわずかな上り）。直線は平坦
    turf: {
      circumference: 1615.1, straight: 293, width: 30, elevation: 3.0,
      keys: (l) => lin([l.S, 0.0], [l.c1, 1.6], [l.c2, 3.0], [(l.c2 + l.c3) / 2, 1.6], [l.c3 - 60, 1.2], [l.c3, 1.5], [(l.c3 + l.C) / 2, 0.6], [0, 0.0]),
    },
    // 2コーナーの丘から4コーナーへ下り、残り400mから直線へゆるやかに上る（0.6m）
    dirt: {
      circumference: 1445.4, straight: 291.3, width: 24, elevation: 2.9,
      keys: (l) => lin([l.S, 0.6], [l.c1, 1.8], [l.c2, 2.9], [l.c3, 1.2], [(l.c3 + l.C) / 2, 0.4], [l.rem(400), 0.0]),
    },
    distances: { turf: [1000, 1200, 1700, 1800, 2000, 2600].map((d) => ({ d })), dirt: [1000, 1700, 2400] },
  },
};

export const VENUE_IDS = Object.keys(VENUES) as VenueId[];
/** 競馬場がない古いレース（第6段階より前）は、以前のコースの元にした中山とする */
export const DEFAULT_VENUE: VenueId = 'nakayama';

export function venueName(id: VenueId | undefined): string {
  return `${VENUES[id ?? DEFAULT_VENUE].name}競馬場`;
}
