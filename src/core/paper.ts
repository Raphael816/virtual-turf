/**
 * 競馬新聞（馬柱）のための集計（第10段階）。
 *
 * 各馬の戦績（直近 HISTORY_LIMIT 走）から、条件別の成績と短評を作る。
 * 短評は事実（前走との違い・間隔・状態）だけを並べ、予想の印や投票を勧める表現は出さない。
 */
import { type VenueId, VENUES } from '../data/venues';
import { conditionLabel } from './lifecycle';
import { CLASS_RANK, type ClassId } from './raceclass';
import type { RunRecord } from './world';

export interface CourseParts {
  venue?: VenueId;
  surface: 'turf' | 'dirt';
  distance: number;
}

/** 戦績のコース表記（「東京芝1600m」「ダ1800m」）を分解する */
export function splitCourse(c: string): CourseParts {
  const venue = (Object.keys(VENUES) as VenueId[]).find((v) => c.startsWith(VENUES[v].name));
  const m = /(\d+)m/.exec(c);
  return { ...(venue ? { venue } : {}), surface: c.includes('ダ') ? 'dirt' : 'turf', distance: m ? Number(m[1]) : 0 };
}

/** [1着, 2着, 3着, 着外] */
export type Tally = [number, number, number, number];

export function tally(runs: RunRecord[]): Tally {
  const t: Tally = [0, 0, 0, 0];
  for (const r of runs) t[Math.min(r.rk, 4) - 1]++;
  return t;
}

export const tallyText = (t: Tally) => (t[0] + t[1] + t[2] + t[3] === 0 ? '—' : t.join('-'));

export interface PaperTallies {
  venue: Tally;
  surface: Tally;
  distance: Tally;
  /** 重・不良 */
  soft: Tally;
}

/** 今回の条件（競馬場・芝ダート・距離 ±200m）と道悪での成績（戦績に残っている走の中で） */
export function talliesFor(history: RunRecord[], now: CourseParts): PaperTallies {
  const parts = history.map((r) => ({ r, p: splitCourse(r.c) }));
  return {
    venue: tally(parts.filter((x) => now.venue && x.p.venue === now.venue).map((x) => x.r)),
    surface: tally(parts.filter((x) => x.p.surface === now.surface).map((x) => x.r)),
    distance: tally(parts.filter((x) => x.p.surface === now.surface && Math.abs(x.p.distance - now.distance) <= 200).map((x) => x.r)),
    soft: tally(history.filter((r) => r.g === '重' || r.g === '不良')),
  };
}

export interface PaperContext {
  course: CourseParts;
  cls?: ClassId;
  /** 今回の負担重量・騎手・馬体重の増減・調子（−1〜1） */
  weight?: number;
  jockey: string;
  bodyDiff?: number;
  condition?: number;
  /** 前走からの週数（前走がないときは undefined） */
  weeksSince?: number;
  firstRun: boolean;
}

/** 短評：前走との違いと状態を、事実だけ並べる（最大5件） */
export function paperNotes(history: RunRecord[], ctx: PaperContext): string[] {
  const out: string[] = [];
  if (ctx.firstRun) return ['初出走'];
  const prev = history[0];
  if (ctx.weeksSince !== undefined && ctx.weeksSince >= 10) out.push(`休み明け（${ctx.weeksSince}週）`);
  if (prev) {
    const pp = splitCourse(prev.c);
    if (ctx.cls && prev.k && CLASS_RANK[ctx.cls] > CLASS_RANK[prev.k] && prev.rk === 1) out.push('昇級戦');
    if (pp.surface !== ctx.course.surface) out.push(ctx.course.surface === 'dirt' ? 'ダート替わり' : '芝替わり');
    else if (pp.distance && ctx.course.distance - pp.distance >= 200) out.push(`距離延長（前走 ${pp.distance}m）`);
    else if (pp.distance && pp.distance - ctx.course.distance >= 200) out.push(`距離短縮（前走 ${pp.distance}m）`);
    if (prev.rk > 1 && prev.tb !== undefined && prev.tb <= 0.2) out.push(`前走は ${prev.tb.toFixed(1)}秒差の${prev.rk}着`);
    else if (prev.rk === 1) out.push('前走1着');
    if (ctx.weight !== undefined && prev.kg !== undefined && Math.abs(ctx.weight - prev.kg) >= 2) out.push(`斤量 ${Math.abs(ctx.weight - prev.kg)}kg ${ctx.weight > prev.kg ? '増' : '減'}`);
    if (prev.j !== ctx.jockey) out.push('乗り替わり');
  }
  if (ctx.bodyDiff !== undefined && Math.abs(ctx.bodyDiff) >= 10) out.push(`馬体重 ${ctx.bodyDiff > 0 ? '+' : '−'}${Math.abs(ctx.bodyDiff)}kg`);
  if (ctx.condition !== undefined && Math.abs(ctx.condition) > 0.2) out.push(`調子 ${conditionLabel(ctx.condition)}`);
  const here = talliesFor(history, ctx.course).venue;
  if (here[0] > 0) out.push(`この競馬場で ${here[0]}勝`);
  return out.slice(0, 5);
}
