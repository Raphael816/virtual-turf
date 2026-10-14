/**
 * 走行ログとイベントから実況テキストを生成する（時刻つき）。
 * 映像と同じ走行ログから作るため、実況と映像・結果が食い違うことはない。
 */
import { HORSE_BY_ID } from '../data/roster';
import type { RaceCard } from './meeting';
import type { SimResult } from './sim';

export interface CommentaryLine {
  t: number;
  text: string;
  kind: 'start' | 'pos' | 'event' | 'finish';
}

export function buildCommentary(card: RaceCard, res: SimResult): CommentaryLine[] {
  const name = (i: number) => `${card.entries[i].number}番${HORSE_BY_ID.get(card.entries[i].horseId)!.name}`;
  const D = card.conditions.distance;
  const lines: CommentaryLine[] = [{ t: 0, text: 'ゲートが開いて、各馬いっせいにスタート！', kind: 'start' }];

  for (const e of res.events) {
    switch (e.type) {
      case 'late_start':
        lines.push({ t: 0.8, text: `${name(e.runner)}は出遅れました。`, kind: 'event' });
        break;
      case 'kakari':
        lines.push({ t: e.t, text: `${name(e.runner)}、少し掛かり気味です。`, kind: 'event' });
        break;
      case 'duel':
        lines.push({ t: e.t, text: `${name(e.runner)}と${name(e.other!)}がハナを争います。`, kind: 'event' });
        break;
      case 'lead':
        lines.push({ t: e.t, text: `先頭は${name(e.runner)}に替わりました。`, kind: 'event' });
        break;
      case 'blocked':
        lines.push({ t: e.t, text: `${name(e.runner)}、前が壁になっています。`, kind: 'event' });
        break;
      case 'fade':
        lines.push({ t: e.t, text: `${name(e.runner)}は苦しくなりました。`, kind: 'event' });
        break;
      default:
        break;
    }
  }

  // 残り距離ごとの隊列
  if (res.data) {
    const n = res.n;
    const marks = [1000, 600, 400, 200].filter((m) => m < D - 200);
    let mi = 0;
    for (let f = 0; f < res.frames && mi < marks.length; f++) {
      let lead = 0;
      for (let i = 1; i < n; i++) if (res.data[(f * n + i) * 3] > res.data[(f * n + lead) * 3]) lead = i;
      if (res.data[(f * n + lead) * 3] >= D - marks[mi]) {
        const order = Array.from({ length: n }, (_, i) => i).sort(
          (a, b) => res.data![(f * n + b) * 3] - res.data![(f * n + a) * 3],
        );
        const t = f * res.dt;
        const m = marks[mi];
        const text =
          m >= 600
            ? `残り${m}m。先頭は${name(order[0])}、2番手${name(order[1])}、3番手${name(order[2])}。`
            : `残り${m}m！ ${name(order[0])}が先頭、${name(order[1])}が追う！`;
        lines.push({ t, text, kind: 'pos' });
        mi++;
      }
    }
  }

  res.order.slice(0, 3).forEach((i, rank) => {
    lines.push({
      t: res.finishTimes[i] + rank * 0.01,
      text: rank === 0 ? `${name(i)}、1着でゴールイン！` : `${rank + 1}着は${name(i)}。`,
      kind: 'finish',
    });
  });
  return lines.sort((a, b) => a.t - b.t);
}
