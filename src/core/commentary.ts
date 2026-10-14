/**
 * 走行ログとイベントから実況テキストを生成する（時刻つき）。
 * 映像と同じ走行ログから作るため、実況と映像・結果が食い違うことはない。
 * 言い回しはレースIDから決まる乱数で選ぶ（同じレースなら毎回同じ実況）。
 */
import { HORSE_BY_ID } from '../data/roster';
import type { RaceCard } from './meeting';
import { Rng } from './rng';
import { type SimResult, formatTime, marginText } from './sim';
import { cornersOnRoute, COURSES } from './track';

export interface CommentaryLine {
  t: number;
  text: string;
  kind: 'start' | 'pos' | 'event' | 'finish';
}

export function buildCommentary(card: RaceCard, res: SimResult): CommentaryLine[] {
  const rng = new Rng(`commentary:${card.id}`);
  const say = (...variants: string[]) => rng.pick(variants);
  const name = (i: number) => `${card.entries[i].number}番${HORSE_BY_ID.get(card.entries[i].horseId)!.name}`;
  const D = card.conditions.distance;
  const n = res.n;
  /** tag は重複整理用（出力には含めない） */
  type Tagged = CommentaryLine & { tag?: 'lead' | 'split' | 'mark' | 'corner' | 'hana' };
  const lines: Tagged[] = [];
  const data = res.data;

  /** 時刻 t の隊列（runner index を前から順に） */
  const orderAt = (t: number): number[] => {
    if (!data) return res.order;
    const f = Math.min(res.frames - 1, Math.max(0, Math.round(t / res.dt)));
    return Array.from({ length: n }, (_, i) => i).sort((a, b) => data[(f * n + b) * 3] - data[(f * n + a) * 3]);
  };
  /** 先頭が走破距離 x に達した時刻 */
  const leaderReaches = (x: number): number | null => {
    if (!data) return null;
    for (let f = 0; f < res.frames; f++) {
      for (let i = 0; i < n; i++) if (data[(f * n + i) * 3] >= x) return f * res.dt;
    }
    return null;
  };

  lines.push({ t: 0, text: say('ゲートが開いて、各馬いっせいにスタート！', 'スタートしました！ きれいなスタート。'), kind: 'start' });

  // 序盤の先手争い
  const t200 = leaderReaches(Math.min(250, D * 0.15));
  if (t200 !== null) {
    const o = orderAt(t200);
    lines.push({ t: t200, text: say(`ハナを切ったのは${name(o[0])}。${name(o[1])}が続きます。`, `先手を取ったのは${name(o[0])}、2番手に${name(o[1])}。`), kind: 'pos', tag: 'hana' });
  }

  for (const e of res.events) {
    // 道中のトラブルは、そのとき前方（5番手以内）にいた馬か、最終的に上位に来た馬に絞る
    const nearFront = () => orderAt(e.t).indexOf(e.runner) < 5;
    switch (e.type) {
      case 'late_start':
        lines.push({ t: 0.8, text: say(`${name(e.runner)}は出遅れました。`, `あっと、${name(e.runner)}はスタートで後手を踏みました。`), kind: 'event' });
        break;
      case 'kakari':
        lines.push({ t: e.t, text: say(`${name(e.runner)}、少し掛かり気味です。`, `${name(e.runner)}は行きたがっています。騎手がなだめます。`), kind: 'event' });
        break;
      case 'duel':
        lines.push({ t: e.t, text: `${name(e.runner)}と${name(e.other!)}がハナを争います。ペースが上がりそうです。`, kind: 'event' });
        break;
      case 'lead':
        lines.push({ t: e.t, text: say(`先頭が替わって${name(e.runner)}。`, `${name(e.runner)}が先頭に立ちました。`), kind: 'event', tag: 'lead' });
        break;
      case 'blocked':
        if (nearFront() || res.order.indexOf(e.runner) < 3)
          lines.push({ t: e.t, text: say(`${name(e.runner)}、前が壁になっています！`, `${name(e.runner)}は進路がありません！`), kind: 'event' });
        break;
      case 'fade':
        if (nearFront()) lines.push({ t: e.t, text: say(`${name(e.runner)}は苦しくなりました。`, `${name(e.runner)}、ここで脚色が鈍ります。`), kind: 'event' });
        break;
      default:
        break;
    }
  }

  // 1000m 通過タイム
  if (D >= 1600 && res.splits.length >= 5) {
    const t1000 = res.splits.slice(0, 5).reduce((a, b) => a + b, 0);
    const flow = res.paceRatio >= 1.0 ? '速い流れです' : res.paceRatio <= 0.99 ? 'ゆったりとした流れ' : '平均的なペース';
    lines.push({ t: t1000, text: `1000mの通過は${t1000.toFixed(1)}秒、${flow}。`, kind: 'pos', tag: 'split' });
  }

  // コーナー（3角・4角）での隊列
  const course = COURSES[card.conditions.surface];
  for (const c of cornersOnRoute(course, D)) {
    if (c.corner < 3) continue;
    const t = leaderReaches(c.at);
    if (t === null) continue;
    const o = orderAt(t);
    lines.push({
      t,
      text:
        c.corner === 3
          ? `3コーナー。先頭${name(o[0])}、2番手${name(o[1])}、その後ろに${name(o[2])}。`
          : say(`4コーナーを回って最後の直線！ 先頭は${name(o[0])}！`, `さあ直線コース！ ${name(o[0])}が先頭、${name(o[1])}が並びかける！`),
      kind: 'pos',
      tag: 'corner',
    });
  }

  // 残り距離ごとの攻防
  for (const m of [600, 400, 200].filter((x) => x < D - 300)) {
    const t = leaderReaches(D - m);
    if (t === null) continue;
    const o = orderAt(t);
    lines.push({
      t,
      text:
        m === 600
          ? `残り600m。${name(o[0])}が先頭、${name(o[1])}、${name(o[2])}が続きます。`
          : m === 400
            ? say(`残り400m！ ${name(o[0])}、${name(o[1])}、外から${name(o[3] ?? o[2])}も来る！`, `残り400m！ ${name(o[0])}粘る、${name(o[1])}が迫る！`)
            : say(`残り200m！ ${name(o[0])}か、${name(o[1])}か！`, `残り200m！ ${name(o[0])}先頭、${name(o[1])}が追う！`),
      kind: 'pos',
      tag: 'mark',
    });
  }

  // ゴール前の叩き合い
  const [w, s2, s3] = res.order;
  const tight = ['ハナ', 'アタマ', 'クビ'].includes(res.margins[s2]);
  if (tight) {
    lines.push({ t: res.finishTimes[w] - 3, text: `${name(w)}と${name(s2)}、激しい叩き合い！`, kind: 'pos' });
  }
  lines.push({
    t: res.finishTimes[w],
    text: res.margins[s2] === 'ハナ' ? `${name(w)}と${name(s2)}、並んでゴールイン！ 写真判定です……${name(w)}がハナ差で先着！` : `${name(w)}、1着でゴールイン！`,
    kind: 'finish',
  });
  lines.push({ t: res.finishTimes[s2] + 0.01, text: `2着は${name(s2)}（${marginText(res.margins[s2])}）。`, kind: 'finish' });
  if (s3 !== undefined) lines.push({ t: res.finishTimes[s3] + 0.02, text: `3着は${name(s3)}。`, kind: 'finish' });
  const fastest = Array.from({ length: n }, (_, i) => i).sort((a, b) => res.last3F[a] - res.last3F[b])[0];
  lines.push({
    t: res.finishTimes[res.order[n - 1]] + 0.5,
    text: `勝ちタイムは${formatTime(res.finishTimes[w])}。上がり最速は${name(fastest)}の${res.last3F[fastest].toFixed(1)}秒でした。`,
    kind: 'finish',
  });

  // 道中で実況が途切れる区間には、隊列と差を伝える実況を入れる
  if (data) {
    const end = res.finishTimes[w] - 25;
    for (let t = 20; t < end; t += 4) {
      if (lines.some((l) => Math.abs(l.t - t) < 14)) continue;
      const f = Math.round(t / res.dt);
      const o = orderAt(t);
      const gap = (data[(f * n + o[0]) * 3] - data[(f * n + o[1]) * 3]) / 2.4;
      const gapText = gap < 0.6 ? 'ほぼ並んで' : `${Math.round(gap)}馬身ほど離れて`;
      lines.push({
        t,
        text: say(
          `先頭は${name(o[0])}、${gapText}${name(o[1])}。最後方は${name(o[n - 1])}。`,
          `隊列は${name(o[0])}が先頭、${gapText}${name(o[1])}、${name(o[2])}と続きます。`,
        ),
        kind: 'pos',
      });
    }
  }
  return tidy(lines);
}

/**
 * 聞きやすさのための整理：
 * - 先頭交代は序盤の先手争いの後に限り、12秒以内の連続や他の隊列実況と重なるものは省く
 * - 1000m通過や残り距離の実況が、コーナーや他の隊列実況と2.5秒以内に重なる場合は省く
 */
function tidy(lines: (CommentaryLine & { tag?: string })[]): CommentaryLine[] {
  lines.sort((a, b) => a.t - b.t);
  const hanaT = lines.find((l) => l.tag === 'hana')?.t ?? 15;
  const near = (l: { t: number }, tags: string[], sec: number) =>
    lines.some((o) => o !== l && o.tag && tags.includes(o.tag) && Math.abs(o.t - l.t) < sec);
  let lastLead = -Infinity;
  const out: CommentaryLine[] = [];
  for (const l of lines) {
    if (l.tag === 'lead') {
      if (l.t < hanaT + 2 || l.t - lastLead < 12 || near(l, ['corner', 'mark', 'split'], 3)) continue;
      lastLead = l.t;
    }
    if (l.tag === 'split' && near(l, ['corner', 'mark'], 2.5)) continue;
    if (l.tag === 'mark' && near(l, ['corner'], 2.5)) continue;
    out.push({ t: l.t, text: l.text, kind: l.kind });
  }
  return out;
}
