/**
 * 種牡馬のページ：一覧（リーディングサイアー）と、種牡馬ごとの特徴・産駒。
 */
import { CLASS_SHORT, classOfEarnings } from '../../core/raceclass';
import { GENE_MEAN, GENE_SD, LINES, type Pedigree, type Stallion, pedigreeOutlook, sireQuality } from '../../core/pedigree';
import { FOUNDERS } from '../../core/pedigree';
import type { WorldHorse } from '../../core/world';
import type { Page } from '../common';
import { store } from '../store';
import { esc } from '../util';

const studOf = (): Stallion[] => store.state.world.stud ?? FOUNDERS;

/** 産駒の成績（現役の馬と、記録に残っている引退馬から） */
function progeny(name: string): WorldHorse[] {
  return store.state.world.horses.filter((h) => h.ped?.s === name);
}

function statsOf(name: string) {
  const kids = progeny(name);
  return {
    kids,
    active: kids.filter((h) => h.status === 'active').length,
    starts: kids.reduce((a, h) => a + h.career.starts, 0),
    wins: kids.reduce((a, h) => a + h.career.wins, 0),
    prize: kids.reduce((a, h) => a + (h.career.prize ?? 0), 0),
  };
}

/** 父の名前（種牡馬のページがあればリンク） */
export function sireLink(name: string): string {
  const s = studOf().find((x) => x.name === name);
  return s ? `<a href="#/sire/${encodeURIComponent(s.id)}">${esc(name)}</a>` : esc(name);
}

/** 血統の1行表記（新聞用）：父・母父 */
export function pedigreeLine(ped: Pedigree | undefined): string {
  return ped ? `父 ${sireLink(ped.s)}・母父 ${esc(ped.ds)}` : '';
}

const distanceLabel = (d: number) => (d < 1500 ? '短距離' : d < 1900 ? 'マイル' : d < 2300 ? '中距離' : '長距離');
const surfaceLabel = (s: number) => (s > 0.3 ? 'ダート' : s < -0.3 ? '芝' : '芝・ダート');
const growthLabel = (g: number) => (g > 0.25 ? '晩成' : g < -0.25 ? '早熟' : '普通');

/** 馬のページの血統欄 */
export function pedigreeSection(ped: Pedigree | undefined): string {
  if (!ped) return '';
  const stud = studOf();
  const s = stud.find((x) => x.name === ped.s);
  const ds = stud.find((x) => x.name === ped.ds);
  const outlook = pedigreeOutlook(ped, stud);
  return `<section class="card" style="margin-top:12px" aria-labelledby="ped-h"><h2 id="ped-h">血統</h2>
    <div class="grid grid-2">
      <table class="table"><tbody>
        <tr><th scope="row">父</th><td><b>${sireLink(ped.s)}</b>${s?.sire ? `<span class="entry-sub">（その父 ${esc(s.sire)}）</span>` : ''}</td></tr>
        <tr><th scope="row">母</th><td>${esc(ped.d)}</td></tr>
        <tr><th scope="row">母父</th><td>${sireLink(ped.ds)}${ds ? `<span class="entry-sub">（${LINES[ds.line].name}）</span>` : ''}</td></tr>
        <tr><th scope="row">系統</th><td>${LINES[ped.l].name}</td></tr>
      </tbody></table>
      <div>
        <p style="margin:0 0 6px"><b>血統背景</b>：${LINES[ped.l].background}</p>
        ${outlook.length ? `<p style="margin:0 0 6px"><b>血統から見た傾向</b>：${outlook.join('・')}</p>` : ''}
        <p class="muted" style="font-size:.82rem;margin:0">血統は傾向を示すだけで、能力を決めるものではありません。同じ両親の子でも個体差が大きく、父に似ない馬もいます。馬・血統はすべて架空です。</p>
      </div>
    </div>
  </section>`;
}

export function siresPage(): Page {
  return {
    title: '種牡馬',
    render(el) {
      const year = store.state.world.date.year;
      const rows = studOf()
        .map((s) => ({ s, ...statsOf(s.name) }))
        .sort((a, b) => b.prize - a.prize || b.wins - a.wins || sireQuality(b.s) - sireQuality(a.s));
      el.innerHTML = `
        <h1>種牡馬</h1>
        <p class="muted">産駒の獲得本賞金の順です（現役の馬と、記録に残っている引退馬の合計）。種牡馬・系統はすべて架空です。名前を選ぶと、特徴と産駒が見られます。</p>
        <div class="table-wrap"><table class="table nowrap">
          <caption class="sr-only">種牡馬の一覧</caption>
          <thead><tr><th class="r">順位</th><th>種牡馬</th><th>系統</th><th>距離</th><th>芝・ダート</th><th>成長</th><th class="r">産駒</th><th class="r">出走</th><th class="r">勝利</th><th class="r">勝率</th><th class="r">獲得本賞金</th><th>状態</th></tr></thead>
          <tbody>${rows
            .map(
              (r, i) => `<tr><td class="r tnum">${i + 1}</td><td><a href="#/sire/${encodeURIComponent(r.s.id)}">${esc(r.s.name)}</a></td><td>${LINES[r.s.line].name}</td>
                <td>${distanceLabel(r.s.genes.distance)}</td><td>${surfaceLabel(r.s.genes.surface)}</td><td>${growthLabel(r.s.genes.growth)}</td>
                <td class="r tnum">${r.kids.length}</td><td class="r tnum">${r.starts}</td><td class="r tnum"><b>${r.wins}</b></td>
                <td class="r tnum">${r.starts ? `${((100 * r.wins) / r.starts).toFixed(1)}%` : '—'}</td><td class="r tnum">${r.prize.toLocaleString()}万円</td>
                <td>${r.s.until < year ? '引退' : r.s.from > year ? '—' : '現役'}</td></tr>`,
            )
            .join('')}</tbody></table></div>
        <h2 style="margin-top:16px">系統</h2>
        <dl class="quote" style="grid-template-columns:auto 1fr">${(Object.keys(LINES) as (keyof typeof LINES)[]).map((l) => `<dt>${LINES[l].name}</dt><dd style="text-align:left;font-weight:400">${LINES[l].background}</dd>`).join('')}</dl>
        <p class="muted" style="font-size:.82rem">毎年、引退した牡馬のうち成績のよい馬（最大3頭）が種牡馬になり、年を取った種牡馬は引退します。評価の高い種牡馬ほど多くの産駒を出します。</p>`;
    },
  };
}

const TRAITS = [
  { k: 'speed', label: 'スピード' },
  { k: 'stamina', label: 'スタミナ' },
  { k: 'accel', label: '瞬発力' },
  { k: 'power', label: 'パワー' },
  { k: 'temper', label: '気性' },
] as const;

export function sirePage(id: string): Page {
  const s = studOf().find((x) => x.id === id);
  return {
    title: s ? `${s.name}（種牡馬）` : '種牡馬が見つかりません',
    render(el) {
      if (!s) {
        el.innerHTML = '<h1>種牡馬が見つかりません</h1><p><a href="#/sires">種牡馬の一覧へ</a></p>';
        return;
      }
      const st = statsOf(s.name);
      const kids = [...st.kids].sort((a, b) => (b.career.prize ?? 0) - (a.career.prize ?? 0) || b.earnings - a.earnings).slice(0, 15);
      // 産駒に伝える値を、平均 50・標準偏差の2倍で端になる棒で表す
      const bar = (k: (typeof TRAITS)[number]['k']) => Math.round(Math.max(4, Math.min(100, 50 + ((s.genes[k] - GENE_MEAN[k]) / GENE_SD[k]) * 40)));
      el.innerHTML = `
        <p style="margin-bottom:4px"><a class="btn btn-sm" href="#/sires">← 種牡馬の一覧</a></p>
        <h1>${esc(s.name)}</h1>
        <p class="muted">種牡馬（架空）・${LINES[s.line].name}${s.sire ? `・父 ${sireLink(s.sire)}` : '・系統の祖'}・${s.from}年から${s.horseId ? `（<a href="#/horse/${s.horseId}">競走成績</a>）` : ''}</p>
        <p>産駒 <b>${st.kids.length}頭</b>（現役 ${st.active}頭）・${st.starts}戦 ${st.wins}勝・獲得本賞金 ${st.prize.toLocaleString()}万円</p>
        <div class="grid grid-2">
          <section class="card" aria-labelledby="tr-h"><h2 id="tr-h">産駒に伝える傾向</h2>
            <table class="table"><tbody>${TRAITS.map(
              (t) => `<tr><th scope="row" style="white-space:nowrap">${t.label}</th><td style="width:55%"><div class="bar" aria-hidden="true"><i style="width:${bar(t.k)}%"></i></div></td><td class="r tnum">${s.genes[t.k] - GENE_MEAN[t.k] >= 0 ? '+' : '−'}${Math.abs(s.genes[t.k] - GENE_MEAN[t.k]).toFixed(1)}</td></tr>`,
            ).join('')}
              <tr><th scope="row">距離</th><td colspan="2">${distanceLabel(s.genes.distance)}（${Math.round(s.genes.distance / 100) * 100}m 前後）</td></tr>
              <tr><th scope="row">芝・ダート</th><td colspan="2">${surfaceLabel(s.genes.surface)}</td></tr>
              <tr><th scope="row">成長</th><td colspan="2">${growthLabel(s.genes.growth)}</td></tr>
            </tbody></table>
            <p class="muted" style="font-size:.82rem">数字は、世代の平均と比べて産駒に伝える分（能力値の目盛り）。子に伝わるのは両親の値の中間で、個体差のほうがずっと大きくなります。</p>
          </section>
          <section class="card" aria-labelledby="bg-h"><h2 id="bg-h">血統背景</h2>
            <p>${LINES[s.line].background}</p>
            <p class="muted" style="font-size:.82rem">系統の特徴は産駒の傾向で、すべての産駒に当てはまるわけではありません。</p>
          </section>
        </div>
        <section class="card" style="margin-top:12px" aria-labelledby="kid-h"><h2 id="kid-h">主な産駒（獲得本賞金の順）</h2>
          ${
            kids.length
              ? `<div class="table-wrap"><table class="table nowrap"><thead><tr><th>馬</th><th>性・生年</th><th>母（母父）</th><th>クラス</th><th class="r">成績</th><th class="r">獲得本賞金</th><th>状態</th></tr></thead>
                 <tbody>${kids
                   .map(
                     (h) => `<tr><td><a href="#/horse/${h.id}">${esc(h.name)}</a></td><td>${h.sex}・${h.birthYear}年</td><td>${esc(h.ped?.d ?? '')}（${esc(h.ped?.ds ?? '')}）</td>
                       <td>${CLASS_SHORT[classOfEarnings(h.earnings)]}</td><td class="r tnum">${h.career.starts}戦${h.career.wins}勝</td><td class="r tnum">${(h.career.prize ?? 0).toLocaleString()}万円</td><td>${h.status === 'active' ? '現役' : '引退'}</td></tr>`,
                   )
                   .join('')}</tbody></table></div>`
              : '<p class="muted">まだ産駒がいません（産駒は2歳でデビューします）。</p>'
          }
        </section>`;
    },
  };
}
