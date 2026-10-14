/**
 * レース後の振り返り解説。
 * シミュレーションが記録した要素（ペース・位置取り・上がり・ロス距離・詰まり・掛かり・適性・調子）から、
 * 勝因と人気馬の敗因を短い文章にする。結果を「説明できる」ことが目的で、予想や投票を勧める表現は使わない。
 */
import { HORSE_BY_ID, STYLE_LABEL } from '../data/roster';
import type { RaceCard } from './meeting';
import { GOING_INDEX, PACE_LABEL, type SimResult, marginText } from './sim';

export interface FactorRow {
  number: number;
  name: string;
  rank: number;
  style: string;
  posAtLastCorner: number;
  last3F: number;
  last3FRank: number;
  laneLoss: number;
  blockedTime: number;
  notes: string[];
}

export interface RaceAnalysis {
  headline: string;
  points: string[];
  favoriteNote: string | null;
  rows: FactorRow[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function analyzeRace(card: RaceCard, res: SimResult, favoriteNumber?: number): RaceAnalysis {
  const n = res.n;
  const D = card.conditions.distance;
  const going = GOING_INDEX[card.conditions.going];
  const horse = (i: number) => HORSE_BY_ID.get(card.entries[i].horseId)!;
  const label = (i: number) => `${card.entries[i].number}番${horse(i).name}`;
  const rankOf = (i: number) => res.order.indexOf(i) + 1;
  const last3FOrder = Array.from({ length: n }, (_, i) => i).sort((a, b) => res.last3F[a] - res.last3F[b]);
  const last3FRank = (i: number) => last3FOrder.indexOf(i) + 1;
  const avgLoss = mean(res.factors.map((f) => f.laneLoss));

  const w = res.order[0];
  const f = res.factors[w];
  const h = horse(w);
  const style = STYLE_LABEL[f.style];
  const marginToSecond = res.margins[res.order[1]];
  const front = f.style === 'nige' || f.style === 'senko';
  const pace = PACE_LABEL[res.pace];

  const points: string[] = [];

  // 1. 展開（ペースと脚質の相性）
  if (res.pace === 'high' && !front) {
    points.push(`${pace}で前の馬が消耗し、中団より後ろで脚を溜めた${label(w)}の末脚が生きました。`);
  } else if (res.pace === 'slow' && front) {
    points.push(`${pace}で前の馬が楽に運べる流れ。${style}の${label(w)}がそのまま押し切りました。`);
  } else if (res.pace === 'high' && front) {
    points.push(`${pace}を前の位置で受けながら最後まで粘り切り、地力の高さを示しました。`);
  } else if (res.pace === 'slow' && !front) {
    points.push(`${pace}で前が有利な流れでしたが、${style}から鋭い末脚で差し切りました。`);
  } else {
    points.push(`平均的な流れ（${pace}）の中、4コーナー${f.posAtLastCorner}番手から抜け出しました。`);
  }

  // 2. 位置取りと上がり
  const l3 = last3FRank(w);
  if (l3 === 1) points.push(`上がり3Fはメンバー最速の${res.last3F[w].toFixed(1)}秒。4コーナー${f.posAtLastCorner}番手からの決め手が光りました。`);
  else if (f.posAtLastCorner <= 2) points.push(`4コーナーで${f.posAtLastCorner === 1 ? '先頭' : '2番手'}に立ち、上がり${res.last3F[w].toFixed(1)}秒（${l3}位）でまとめました。`);
  else points.push(`4コーナー${f.posAtLastCorner}番手から、上がり${res.last3F[w].toFixed(1)}秒（${l3}位）で伸びました。`);

  // 3. コース取り・適性・調子
  if (f.laneLoss < avgLoss - 5) points.push(`内ラチ沿いを通り、コーナーでの距離ロスを最小限（約${f.laneLoss.toFixed(0)}m）に抑えました。`);
  else if (f.laneLoss > avgLoss + 8) points.push(`コーナーで外を回るロス（約${f.laneLoss.toFixed(0)}m）がありながらの勝利でした。`);
  if (going >= 2 && h.heavy === 'A') points.push(`${card.conditions.going === 'heavy' ? '不良' : '重'}馬場で、道悪適性Aを生かしました。`);
  if (Math.abs(D - h.bestDistance) <= 200) points.push(`最適距離（${h.bestDistance}m前後）に近い条件も合っていました。`);
  if (f.condition > 0.08) points.push('当日の調子も上向きでした（調子は毎レース少しずつ変動します）。');

  // 4. 着差
  const close = ['ハナ', 'アタマ', 'クビ'].includes(marginToSecond);
  points.push(
    close
      ? `2着の${label(res.order[1])}とは${marginToSecond}差。ゴール前は大接戦でした。`
      : `2着の${label(res.order[1])}に${marginText(marginToSecond)}差をつけました。`,
  );

  // 人気馬の敗因
  let favoriteNote: string | null = null;
  const favIdx = favoriteNumber ? card.entries.findIndex((e) => e.number === favoriteNumber) : -1;
  if (favIdx >= 0 && favIdx !== w) {
    const ff = res.factors[favIdx];
    const fh = horse(favIdx);
    const reasons: string[] = [];
    if (ff.lateStart) reasons.push('出遅れが響き');
    if (ff.kakari) reasons.push('道中で掛かって体力を消耗し');
    if (ff.gaveUpLead) reasons.push('ハナ争いで消耗し');
    if (ff.blockedTime > 2) reasons.push(`直線で約${ff.blockedTime.toFixed(0)}秒間前が詰まり`);
    if (ff.staminaEnd < 0.05 && D > fh.bestDistance + 200) reasons.push('距離が長く最後に脚が上がり');
    if (going >= 2 && (fh.heavy === 'C' || fh.heavy === 'D')) reasons.push('道悪が合わず');
    if (ff.laneLoss > avgLoss + 8) reasons.push(`外を回るロス（約${ff.laneLoss.toFixed(0)}m）があり`);
    if (!reasons.length && res.pace === 'high' && (ff.style === 'nige' || ff.style === 'senko')) reasons.push('速い流れを前で受けて最後に苦しくなり');
    if (!reasons.length && res.pace === 'slow' && (ff.style === 'sashi' || ff.style === 'oikomi')) reasons.push('スローペースで前が止まらず届かず');
    if (!reasons.length && ff.condition < -0.06) reasons.push('当日の調子がいまひとつで');
    const why = reasons.length ? reasons.slice(0, 2).join('、') : '勝ち馬の末脚に屈し';
    favoriteNote = `1番人気の${label(favIdx)}は、${why}${rankOf(favIdx)}着でした。`;
  }

  const rows: FactorRow[] = res.order.map((i) => {
    const fx = res.factors[i];
    const notes: string[] = [];
    if (fx.lateStart) notes.push('出遅れ');
    if (fx.kakari) notes.push('掛かり');
    if (fx.gaveUpLead) notes.push('ハナ争い');
    if (fx.blockedTime > 2) notes.push('詰まり');
    if (fx.staminaEnd < 0.05) notes.push('失速');
    return {
      number: card.entries[i].number,
      name: horse(i).name,
      rank: rankOf(i),
      style: STYLE_LABEL[fx.style],
      posAtLastCorner: fx.posAtLastCorner,
      last3F: res.last3F[i],
      last3FRank: last3FRank(i),
      laneLoss: fx.laneLoss,
      blockedTime: fx.blockedTime,
      notes,
    };
  });

  return {
    headline: `${label(w)}が${style}から${marginText(marginToSecond)}差で勝利（${pace}）`,
    points: points.slice(0, 5),
    favoriteNote,
    rows,
  };
}
