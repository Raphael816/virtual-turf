import { type RaceCard, type RaceEntry, entryHorse } from '../core/meeting';
import { type RaceRuntime, type RaceStatus, STATUS_LABEL, raceStatus } from '../core/raceflow';
import { GOING_LABEL, SURFACE_LABEL, TIME_LABEL, WEATHER_LABEL, courseShort } from '../core/sim';
import type { Horse } from '../data/roster';
import { type RunRecord, dateLabel, findHorse } from '../core/world';
import { MENU_BY_ID, type MenuId } from '../core/training';
import { store } from './store';
import { countdown, esc } from './util';

export interface Page {
  title: string;
  render(el: HTMLElement): void;
  /** state: 状態変化 / tick: 1秒ごと / probs: 確率推定の完了 */
  update?(reason: 'state' | 'tick' | 'probs'): void;
  dispose?(): void;
}

export const horseOf = (e: RaceEntry): Horse => entryHorse(e);

export function runtimeOf(card: RaceCard): RaceRuntime {
  return store.state.meeting!.runtime[card.id];
}

export function statusOf(card: RaceCard): RaceStatus {
  return raceStatus(runtimeOf(card), store.now());
}

export function statusChip(status: RaceStatus): string {
  return `<span class="chip chip-${status}">${STATUS_LABEL[status]}</span>`;
}

export function surfaceChip(card: RaceCard): string {
  const c = card.conditions;
  return `<span class="chip chip-${c.surface}">${courseShort(c)}</span>`;
}

export function conditionText(card: RaceCard): string {
  const c = card.conditions;
  return `${WEATHER_LABEL[c.weather]}・${SURFACE_LABEL[c.surface]}${GOING_LABEL[c.going]}・${TIME_LABEL[c.timeOfDay]}・${card.entries.length}頭`;
}

/** 状態に応じた時刻表示（締切まで／発走まで／確定） */
export function timingText(card: RaceCard): string {
  const rt = runtimeOf(card);
  const now = store.now();
  switch (raceStatus(rt, now)) {
    case 'open':
      return `締切まで <b class="tnum">${countdown(rt.closesAt - now)}</b>`;
    case 'closed':
      return rt.startsAt ? `発走まで <b class="tnum">${countdown(rt.startsAt - now)}</b>` : '締切処理中';
    case 'running':
      return '<b>レース中</b>';
    case 'finished':
      return '確定';
  }
}

export function raceTitle(card: RaceCard): string {
  return `${card.no}R ${esc(card.name)}`;
}

export function nextOpenRace(): RaceCard | undefined {
  const m = store.state.meeting;
  if (!m) return undefined;
  const now = store.now();
  return (
    m.cards.find((c) => ['running', 'closed'].includes(raceStatus(m.runtime[c.id], now))) ??
    m.cards.find((c) => raceStatus(m.runtime[c.id], now) === 'open')
  );
}

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  races: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/></svg>',
  guide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};

/** ゲーム内の日付（年・月・週） */
export function gameDateText(): string {
  return dateLabel(store.state.world.date);
}

/** 出走表の馬の近走（このレースより前の走、新しい順） */
export function recentRuns(e: RaceEntry, raceId: string, n = 5): RunRecord[] {
  return (findHorse(store.state.world, e.horseId)?.history ?? []).filter((r) => r.r !== raceId).slice(0, n);
}

/** 近走の着順を小さな枠で表す（1〜3着は色付き）。title に詳細 */
export function formBadges(runs: RunRecord[]): string {
  if (!runs.length) return '<span class="muted" style="font-size:.8rem">初出走</span>';
  return `<span class="form">${runs
    .map((r) => {
      const cls = r.rk === 1 ? 'f1' : r.rk === 2 ? 'f2' : r.rk === 3 ? 'f3' : '';
      return `<span class="fb ${cls}" title="${r.y}年 第${r.w}週 ${esc(r.n)} ${esc(r.c)}・${esc(r.g)} ${r.f}頭${r.no}番 ${r.rk}着">${r.rk}</span>`;
    })
    .join('')}</span>`;
}

/** 前走からの間隔の表記（中N週・休み明け・初出走） */
export function intervalText(runs: RunRecord[]): string {
  const prev = runs[0];
  if (!prev) return '初出走';
  const d = store.state.world.date;
  const weeks = (d.year - prev.y) * 52 + (d.week - prev.w);
  if (weeks >= 10) return `休み明け（${weeks}週）`;
  return weeks <= 1 ? '連闘' : `中${weeks - 1}週`;
}

/** 直近の調教（評価のついたもの）。例「坂路B」 */
export function lastWorkText(horseId: string): string {
  const h = findHorse(store.state.world, horseId);
  const r = h?.life.train?.find((x) => x.e);
  if (!r) return '';
  return `${MENU_BY_ID[r.m as MenuId]?.label ?? r.m}${r.e}`;
}
