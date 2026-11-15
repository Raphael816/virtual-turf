/**
 * 騎手のページ：一覧（リーディング）と、騎手ごとの技術・適性・成績。
 */
import {
  BAND_LABEL,
  JOCKEY_BY_ID,
  JOCKEY_LIST,
  SKILL_HELP,
  SKILL_KEYS,
  SKILL_LABEL,
  type Jockey,
  allowanceOf,
  careerWins,
  isApprentice,
  rating,
  yearsOf,
} from '../../core/jockey';
import { START_YEAR } from '../../core/world';
import { VENUES } from '../../data/venues';
import type { Page } from '../common';
import { store } from '../store';
import { esc } from '../util';

const SURFACE_LABEL = { turf: '芝', dirt: 'ダート', both: '芝・ダートどちらも' } as const;
const STYLE_LABEL = { front: '前に行く馬（逃げ・先行）', closer: '後ろから行く馬（差し・追込）', any: '脚質を選ばない' } as const;

function statsOf(j: Jockey) {
  const w = store.state.world;
  const t = w.jockeys?.[j.id] ?? { rides: 0, wins: 0, seconds: 0, thirds: 0, yRides: 0, yWins: 0, prize: 0 };
  const years = yearsOf(j, START_YEAR, w.date.year);
  const wins = careerWins(j, w.jockeys);
  // 一般競走での減量（特別競走・ハンデキャップ競走では減量なし）
  const allow = allowanceOf(j.sex, years, wins, false, false);
  return { t, years, wins, allow };
}

const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');

/** 騎手の名前（減量の印つき・ページへのリンク） */
export function jockeyLink(name: string, id?: string, mark?: string): string {
  const label = `${mark ?? ''}${esc(name)}`;
  return id ? `<a href="#/jockey/${id}">${label}</a>` : label;
}

export function jockeysPage(): Page {
  return {
    title: '騎手リーディング',
    render(el) {
      const rows = JOCKEY_LIST.map((j) => ({ j, ...statsOf(j) })).sort((a, b) => b.t.yWins - a.t.yWins || b.t.wins - a.t.wins || rating(b.j) - rating(a.j));
      el.innerHTML = `
        <h1>騎手リーディング</h1>
        <p class="muted">${store.state.world.date.year}年の勝利数の順です。登場する騎手はすべて架空です。名前を選ぶと、技術と得意な条件が見られます。</p>
        <div class="table-wrap"><table class="table nowrap">
          <caption class="sr-only">騎手リーディング</caption>
          <thead><tr><th class="r">順位</th><th>騎手</th><th class="r">今年の勝利</th><th class="r">今年の騎乗</th><th class="r">勝率</th><th class="r">通算勝利</th><th class="r">年数</th><th>減量</th><th class="r" title="8つの技術の平均">技術</th></tr></thead>
          <tbody>${rows
            .map(
              (r, i) => `<tr><td class="r tnum">${i + 1}</td><td>${jockeyLink(r.j.name, r.j.id)}</td>
                <td class="r tnum"><b>${r.t.yWins}</b></td><td class="r tnum">${r.t.yRides}</td><td class="r tnum">${pct(r.t.yWins, r.t.yRides)}</td>
                <td class="r tnum">${r.wins}</td><td class="r tnum">${r.years}年目</td>
                <td>${r.allow.kg ? `${r.allow.mark} ${r.allow.kg}kg` : '—'}</td><td class="r tnum">${rating(r.j).toFixed(0)}</td></tr>`,
            )
            .join('')}</tbody></table></div>
        <p class="muted" style="font-size:.82rem">減量は、見習騎手（免許を受けてから5年未満・通算100勝以下）と女性騎手が、特別競走とハンデキャップ競走以外で受ける負担重量の軽減です（JRA の制度と同じ：男性の見習 ▲3kg・△2kg・☆1kg、女性 ★4kg・◆3kg・◇2kg）。</p>`;
    },
  };
}

export function jockeyPage(id: string): Page {
  const j = JOCKEY_BY_ID.get(id);
  return {
    title: j ? `${j.name}（騎手）` : '騎手が見つかりません',
    render(el) {
      if (!j) {
        el.innerHTML = '<h1>騎手が見つかりません</h1><p><a href="#/jockeys">騎手リーディングへ</a></p>';
        return;
      }
      const { t, years, wins, allow } = statsOf(j);
      // この騎手が乗った、現役馬の直近の成績（各馬の戦績から）
      const rides = store.state.world.horses
        .flatMap((h) => h.history.filter((r) => r.j === j.name).map((r) => ({ h, r })))
        .sort((a, b) => b.r.y * 100 + b.r.w - (a.r.y * 100 + a.r.w))
        .slice(0, 12);
      el.innerHTML = `
        <p style="margin-bottom:4px"><a class="btn btn-sm" href="#/jockeys">← 騎手リーディング</a></p>
        <h1>${esc(j.name)}</h1>
        <p class="muted">騎手（架空）・${j.sex}性・${years}年目${isApprentice(years) && wins <= 100 ? '・見習騎手' : ''}${allow.kg ? `・一般競走で ${allow.mark} ${allow.kg}kg 減` : ''}</p>
        <p>通算 <b>${wins}勝</b>（このゲームで ${t.rides}戦 ${t.wins}勝・2着 ${t.seconds}・3着 ${t.thirds}、勝率 ${pct(t.wins, t.rides)}）・今年 ${t.yRides}戦 ${t.yWins}勝・獲得本賞金 ${t.prize.toLocaleString()}万円</p>
        <div class="grid grid-2">
          <section class="card" aria-labelledby="sk-h"><h2 id="sk-h">技術</h2>
            <table class="table"><tbody>${SKILL_KEYS.map(
              (k) => `<tr><th scope="row" style="white-space:nowrap">${SKILL_LABEL[k]}</th>
                <td style="width:40%"><div class="bar" aria-hidden="true"><i style="width:${j.skills[k]}%"></i></div></td>
                <td class="r tnum"><b>${j.skills[k]}</b></td><td class="muted" style="font-size:.82rem">${SKILL_HELP[k]}</td></tr>`,
            ).join('')}</tbody></table>
            <p class="muted" style="font-size:.82rem">技術はレースの別々の場面に効きます（スタート・位置取り・道中・コーナー・直線）。上手な騎手でも、馬の能力や展開を覆して勝てるわけではありません（同じ馬に乗って、最も上手な騎手と最も経験の浅い騎手で 2馬身ほどの差）。</p>
          </section>
          <section class="card" aria-labelledby="ap-h"><h2 id="ap-h">得意な条件</h2>
            <dl class="quote" style="margin:0">
              <dt>競馬場</dt><dd>${j.venues.map((v) => VENUES[v].name).join('・')}</dd>
              <dt>距離</dt><dd>${BAND_LABEL[j.band]}</dd>
              <dt>芝・ダート</dt><dd>${SURFACE_LABEL[j.surface]}</dd>
              <dt>合う馬</dt><dd>${STYLE_LABEL[j.style]}</dd>
            </dl>
            <p class="muted" style="font-size:.82rem;margin-top:8px">得意な条件では技術が少し上がり、苦手な条件では少し下がります。馬との相性（組み合わせごとに決まっている相性と、乗り慣れ）も同じように効きます。出馬表の騎手名の横に、その日の上下を表示します。</p>
          </section>
        </div>
        <section class="card" style="margin-top:12px" aria-labelledby="rd-h"><h2 id="rd-h">最近の騎乗（現役馬の戦績から）</h2>
          ${
            rides.length
              ? `<div class="table-wrap"><table class="table nowrap"><thead><tr><th>日付</th><th>レース</th><th>コース</th><th>馬</th><th class="r">人気</th><th class="r">着順</th></tr></thead>
                 <tbody>${rides
                   .map(
                     ({ h, r }) => `<tr><td class="tnum">${r.y}年${r.w}週</td><td><a href="#/race/${encodeURIComponent(r.r)}">${esc(r.n)}</a></td><td>${esc(r.c)}</td>
                       <td><a href="#/horse/${h.id}">${esc(h.name)}</a></td><td class="r tnum">${r.pop ?? '—'}</td><td class="r"><b>${r.rk}</b></td></tr>`,
                   )
                   .join('')}</tbody></table></div>`
              : '<p class="muted">まだ騎乗の記録がありません。</p>'
          }
        </section>`;
    },
  };
}
