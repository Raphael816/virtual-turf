/**
 * 競馬場の近くの気象官署の平年値（1991〜2020年）。気象庁「過去の気象データ検索」の平年値（年・月ごとの値）から。
 * https://www.data.jma.go.jp/stats/etrn/ （2026年11月に取得）。
 * - prec：月の降水量 (mm)、d1：降水量1mm以上の日数、d10：10mm以上の日数、temp：月平均気温 (℃)、sun：日照時間 (h)
 * - 地点：札幌・函館・福島・新潟・東京・千葉（中山）・名古屋（中京）・京都・神戸（阪神）・八幡（小倉。アメダス。降水日数は福岡の値を降水量の比で補正した推定）
 */
import type { VenueId } from './venues';

export interface MonthClimate {
  prec: number;
  d1: number;
  d10: number;
  temp: number;
  sun: number;
}

/** 平年値の地点名 */
export const CLIMATE_STATION: Record<VenueId, string> = {sapporo: '札幌', hakodate: '函館', fukushima: '福島', niigata: '新潟', tokyo: '東京', nakayama: '千葉', chukyo: '名古屋', kyoto: '京都', hanshin: '神戸', kokura: '八幡（降水日数は福岡）'};

/** [1月, …, 12月] */
export const CLIMATE: Record<VenueId, MonthClimate[]> = {
  sapporo: [
    { prec: 108.4, d1: 18.3, d10: 3.3, temp: -3.2, sun: 90.4 },
    { prec: 91.9, d1: 16, d10: 2.5, temp: -2.7, sun: 103.5 },
    { prec: 77.6, d1: 13.9, d10: 2.1, temp: 1.1, sun: 144.7 },
    { prec: 54.6, d1: 9.6, d10: 1.6, temp: 7.3, sun: 175.8 },
    { prec: 55.5, d1: 8.5, d10: 1.8, temp: 13, sun: 200.4 },
    { prec: 60.4, d1: 7.5, d10: 2, temp: 17, sun: 180 },
    { prec: 90.7, d1: 7.7, d10: 2.9, temp: 21.1, sun: 168 },
    { prec: 126.8, d1: 9.5, d10: 4.1, temp: 22.3, sun: 168.1 },
    { prec: 142.2, d1: 10.2, d10: 4.1, temp: 18.6, sun: 159.3 },
    { prec: 109.9, d1: 11.6, d10: 3.3, temp: 12.1, sun: 145.9 },
    { prec: 113.8, d1: 14.6, d10: 3.7, temp: 5.2, sun: 99.1 },
    { prec: 114.5, d1: 16, d10: 3.7, temp: -0.9, sun: 82.7 },
  ],
  hakodate: [
    { prec: 77.4, d1: 15, d10: 1.7, temp: -2.4, sun: 103.1 },
    { prec: 64.5, d1: 12.7, d10: 1.5, temp: -1.8, sun: 117.9 },
    { prec: 64.1, d1: 12.4, d10: 1.8, temp: 1.9, sun: 158.7 },
    { prec: 71.9, d1: 9.5, d10: 2.2, temp: 7.3, sun: 186.1 },
    { prec: 88.9, d1: 9.5, d10: 3, temp: 12.3, sun: 198.5 },
    { prec: 79.8, d1: 7.3, d10: 2.5, temp: 16.2, sun: 172.6 },
    { prec: 123.6, d1: 8.8, d10: 4.1, temp: 20.3, sun: 134.4 },
    { prec: 156.5, d1: 9.1, d10: 4.4, temp: 22.1, sun: 148 },
    { prec: 150.5, d1: 10.2, d10: 5.1, temp: 18.8, sun: 160.8 },
    { prec: 105.6, d1: 11.3, d10: 3.4, temp: 12.5, sun: 163.9 },
    { prec: 110.8, d1: 13.6, d10: 3.7, temp: 6, sun: 109.4 },
    { prec: 94.6, d1: 15.8, d10: 2.7, temp: -0.1, sun: 91.5 },
  ],
  fukushima: [
    { prec: 56.2, d1: 8, d10: 1.7, temp: 1.9, sun: 132.2 },
    { prec: 41.1, d1: 6.8, d10: 1.2, temp: 2.5, sun: 144.8 },
    { prec: 75.7, d1: 7.8, d10: 2.6, temp: 5.9, sun: 175.1 },
    { prec: 81.8, d1: 7.1, d10: 2.9, temp: 11.7, sun: 189.7 },
    { prec: 88.5, d1: 8.2, d10: 2.7, temp: 17.2, sun: 193.2 },
    { prec: 121.2, d1: 10.1, d10: 3.9, temp: 20.7, sun: 141.4 },
    { prec: 177.7, d1: 13.2, d10: 5.2, temp: 24.3, sun: 125.2 },
    { prec: 151.3, d1: 11, d10: 4.4, temp: 25.5, sun: 148.7 },
    { prec: 167.6, d1: 10.5, d10: 4.4, temp: 21.6, sun: 122.9 },
    { prec: 138.7, d1: 8.2, d10: 3.5, temp: 15.6, sun: 133.7 },
    { prec: 58.4, d1: 6.1, d10: 1.9, temp: 9.5, sun: 128.3 },
    { prec: 48.9, d1: 8.1, d10: 1.4, temp: 4.3, sun: 118.7 },
  ],
  niigata: [
    { prec: 180.9, d1: 21.1, d10: 6.8, temp: 2.5, sun: 56.4 },
    { prec: 115.8, d1: 16.8, d10: 3.9, temp: 3.1, sun: 74.3 },
    { prec: 112, d1: 15.5, d10: 4, temp: 6.2, sun: 136.8 },
    { prec: 97.2, d1: 11.5, d10: 3.6, temp: 11.3, sun: 177.7 },
    { prec: 94.4, d1: 10.1, d10: 3.1, temp: 16.7, sun: 202.8 },
    { prec: 121.1, d1: 9.5, d10: 3.9, temp: 20.9, sun: 179.2 },
    { prec: 222.3, d1: 12.5, d10: 6.1, temp: 24.9, sun: 162.1 },
    { prec: 163.4, d1: 10, d10: 4.4, temp: 26.5, sun: 205.2 },
    { prec: 151.9, d1: 11.8, d10: 4.8, temp: 22.5, sun: 156.2 },
    { prec: 157.7, d1: 13.6, d10: 5.6, temp: 16.7, sun: 138.2 },
    { prec: 203.5, d1: 17.7, d10: 8, temp: 10.5, sun: 91.5 },
    { prec: 225.9, d1: 21.5, d10: 8.5, temp: 5.3, sun: 62.9 },
  ],
  tokyo: [
    { prec: 59.7, d1: 4.5, d10: 1.9, temp: 5.4, sun: 192.6 },
    { prec: 56.5, d1: 5.2, d10: 2, temp: 6.1, sun: 170.4 },
    { prec: 116, d1: 9.2, d10: 4, temp: 9.4, sun: 175.3 },
    { prec: 133.7, d1: 9.5, d10: 4, temp: 14.3, sun: 178.8 },
    { prec: 139.7, d1: 10.1, d10: 4.4, temp: 18.8, sun: 179.6 },
    { prec: 167.8, d1: 11.6, d10: 5.4, temp: 21.9, sun: 124.2 },
    { prec: 156.2, d1: 10.5, d10: 4.2, temp: 25.7, sun: 151.4 },
    { prec: 154.7, d1: 7.9, d10: 3.8, temp: 26.9, sun: 174.2 },
    { prec: 224.9, d1: 11, d10: 5.6, temp: 23.3, sun: 126.7 },
    { prec: 234.8, d1: 10.5, d10: 5.3, temp: 18, sun: 129.4 },
    { prec: 96.3, d1: 7.4, d10: 2.6, temp: 12.5, sun: 149.8 },
    { prec: 57.9, d1: 5.2, d10: 1.8, temp: 7.7, sun: 174.4 },
  ],
  nakayama: [
    { prec: 67.5, d1: 5.4, d10: 2.3, temp: 6.1, sun: 191.6 },
    { prec: 59.1, d1: 5.9, d10: 1.8, temp: 6.6, sun: 165.3 },
    { prec: 111.3, d1: 10.2, d10: 4.2, temp: 9.6, sun: 167.5 },
    { prec: 110.4, d1: 9.8, d10: 3.7, temp: 14.5, sun: 177 },
    { prec: 122.3, d1: 10.1, d10: 4.3, temp: 18.9, sun: 180.5 },
    { prec: 150.9, d1: 10.9, d10: 4.8, temp: 21.9, sun: 126.9 },
    { prec: 136.5, d1: 9, d10: 3.8, temp: 25.7, sun: 162.7 },
    { prec: 115.7, d1: 7.7, d10: 2.9, temp: 27.1, sun: 189.4 },
    { prec: 204.7, d1: 10.8, d10: 5.1, temp: 23.8, sun: 134.6 },
    { prec: 225.7, d1: 10.5, d10: 5.5, temp: 18.6, sun: 131.6 },
    { prec: 94.1, d1: 7.9, d10: 3, temp: 13.4, sun: 143.6 },
    { prec: 56.8, d1: 5.9, d10: 1.8, temp: 8.6, sun: 174.8 },
  ],
  chukyo: [
    { prec: 50.8, d1: 5.2, d10: 2, temp: 4.8, sun: 174.5 },
    { prec: 64.7, d1: 6.2, d10: 2.3, temp: 5.5, sun: 175.5 },
    { prec: 116.2, d1: 8.8, d10: 4.3, temp: 9.2, sun: 199.7 },
    { prec: 127.5, d1: 9.4, d10: 4.5, temp: 14.6, sun: 200.2 },
    { prec: 150.3, d1: 9.7, d10: 5.1, temp: 19.4, sun: 205.5 },
    { prec: 186.5, d1: 11.6, d10: 5.9, temp: 23, sun: 151.8 },
    { prec: 211.4, d1: 12, d10: 6, temp: 26.9, sun: 166 },
    { prec: 139.5, d1: 8.5, d10: 3.7, temp: 28.2, sun: 201.3 },
    { prec: 231.6, d1: 10.5, d10: 5.6, temp: 24.5, sun: 159.6 },
    { prec: 164.7, d1: 9, d10: 4.4, temp: 18.6, sun: 168.9 },
    { prec: 79.1, d1: 6.1, d10: 2.7, temp: 12.6, sun: 167.1 },
    { prec: 56.6, d1: 6.2, d10: 1.9, temp: 7.2, sun: 170.3 },
  ],
  kyoto: [
    { prec: 53.3, d1: 6.4, d10: 1.9, temp: 4.8, sun: 123.5 },
    { prec: 65.1, d1: 7.3, d10: 2.5, temp: 5.4, sun: 122.2 },
    { prec: 106.2, d1: 9.5, d10: 4, temp: 8.8, sun: 155.4 },
    { prec: 117, d1: 9.4, d10: 3.8, temp: 14.4, sun: 177.3 },
    { prec: 151.4, d1: 9.7, d10: 4.7, temp: 19.5, sun: 182.4 },
    { prec: 199.7, d1: 11.5, d10: 6, temp: 23.3, sun: 133.1 },
    { prec: 223.6, d1: 11.6, d10: 5.9, temp: 27.3, sun: 142.7 },
    { prec: 153.8, d1: 8.3, d10: 4, temp: 28.5, sun: 182.7 },
    { prec: 178.5, d1: 9.8, d10: 4.9, temp: 24.4, sun: 142.7 },
    { prec: 143.2, d1: 8.2, d10: 4.1, temp: 18.4, sun: 156 },
    { prec: 73.9, d1: 6.3, d10: 2.5, temp: 12.5, sun: 140.7 },
    { prec: 57.3, d1: 6.6, d10: 1.8, temp: 7.2, sun: 134.4 },
  ],
  hanshin: [
    { prec: 38.4, d1: 4.7, d10: 1.3, temp: 6.2, sun: 145.8 },
    { prec: 55.6, d1: 6, d10: 1.9, temp: 6.5, sun: 142.4 },
    { prec: 94.2, d1: 8.9, d10: 3.6, temp: 9.8, sun: 175.8 },
    { prec: 100.6, d1: 9, d10: 3.6, temp: 15, sun: 194.8 },
    { prec: 134.7, d1: 9.1, d10: 3.9, temp: 19.8, sun: 202.6 },
    { prec: 176.7, d1: 10.7, d10: 5.4, temp: 23.4, sun: 164 },
    { prec: 187.9, d1: 10, d10: 4.9, temp: 27.1, sun: 189.4 },
    { prec: 103.4, d1: 6.5, d10: 2.7, temp: 28.6, sun: 229.6 },
    { prec: 157.2, d1: 9.3, d10: 4.2, temp: 25.4, sun: 163.9 },
    { prec: 118, d1: 7.8, d10: 3.6, temp: 19.8, sun: 169.8 },
    { prec: 62.4, d1: 5.6, d10: 2.2, temp: 14.2, sun: 152.2 },
    { prec: 48.7, d1: 5.7, d10: 1.6, temp: 8.8, sun: 153.2 },
  ],
  kokura: [
    { prec: 87.9, d1: 10.7, d10: 2.8, temp: 6.2, sun: 101.8 },
    { prec: 79.2, d1: 10, d10: 2.7, temp: 6.9, sun: 113.2 },
    { prec: 114.2, d1: 11.1, d10: 4.5, temp: 10, sun: 159.5 },
    { prec: 125.4, d1: 10.3, d10: 4.1, temp: 14.7, sun: 188.6 },
    { prec: 142.9, d1: 9.2, d10: 4.2, temp: 19.3, sun: 205 },
    { prec: 239.5, d1: 11.1, d10: 5.9, temp: 22.7, sun: 139.2 },
    { prec: 314.6, d1: 11.6, d10: 6.3, temp: 26.8, sun: 167.6 },
    { prec: 198.1, d1: 9.2, d10: 4.7, temp: 27.8, sun: 196.2 },
    { prec: 165.9, d1: 9.2, d10: 4.4, temp: 24, sun: 159.8 },
    { prec: 85.2, d1: 6.1, d10: 2.5, temp: 18.8, sun: 170.5 },
    { prec: 91.8, d1: 8.5, d10: 2.9, temp: 13.3, sun: 131.5 },
    { prec: 75.9, d1: 9.6, d10: 2.6, temp: 8.3, sun: 102.9 },
  ],
};
