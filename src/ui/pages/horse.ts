import { raceStatus } from '../../core/raceflow';
import { HORSE_BY_ID, STYLE_LABEL } from '../../data/roster';
import { type Page, conditionText, raceTitle, surfaceChip } from '../common';
import { store } from '../store';
import { esc, numBadge } from '../util';

const STATS: { key: 'speed' | 'stamina' | 'accel' | 'start' | 'temper' | 'power'; label: string; help: string }[] = [
  { key: 'speed', label: 'スピード', help: '最高速度' },
  { key: 'stamina', label: 'スタミナ', help: 'バテにくさ・長距離への強さ' },
  { key: 'accel', label: '加速', help: '末脚の鋭さ' },
  { key: 'start', label: 'ゲート', help: 'スタートの上手さ' },
  { key: 'temper', label: '気性', help: '高いほど落ち着いていて掛かりにくい' },
  { key: 'power', label: 'パワー', help: 'ダート・重い馬場への強さ' },
];

/** 能力値のレーダーチャート（SVG） */
function radar(values: number[], labels: string[]): string {
  const size = 240;
  const c = size / 2;
  const R = 84;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / values.length;
    const r = (R * Math.max(0, v - 30)) / 70; // 30〜100 を 0〜R に対応
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const rings = [50, 70, 90, 100]
    .map((v) => `<polygon points="${values.map((_, i) => pt(i, v).join(',')).join(' ')}" fill="none" stroke="var(--border)"/>`)
    .join('');
  const poly = values.map((v, i) => pt(i, v).join(',')).join(' ');
  const text = labels
    .map((l, i) => {
      const [x, y] = pt(i, 118);
      return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${l} ${values[i]}</text>`;
    })
    .join('');
  return `<svg class="radar" viewBox="-36 -6 ${size + 72} ${size + 12}" width="100%" style="max-width:300px" role="img" aria-label="能力値: ${labels.map((l, i) => `${l}${values[i]}`).join('、')}">
    ${rings}<polygon points="${poly}" fill="rgba(79,191,122,.3)" stroke="var(--turf)" stroke-width="2"/>${text}</svg>`;
}

export function horsePage(horseId: string): Page {
  const h = HORSE_BY_ID.get(horseId);
  if (!h) return { title: '馬が見つかりません', render: (el) => (el.innerHTML = '<h1>馬が見つかりません</h1><p><a href="#/races">レース一覧へ</a></p>') };

  return {
    title: h.name,
    render(el) {
      const m = store.state.meeting!;
      const now = store.now();
      const entries = m.cards
        .map((c) => ({ c, e: c.entries.find((e) => e.horseId === h.id) }))
        .filter((x) => x.e);
      el.innerHTML = `
        <p style="margin-bottom:4px"><button type="button" class="btn btn-sm" data-back>← 戻る</button></p>
        <h1>${esc(h.name)}</h1>
        <p class="muted">${h.sex}${h.age}・${h.coat}・${esc(h.trainer)}（架空）</p>
        <div class="grid grid-2">
          <section class="card" aria-labelledby="ab-h"><h2 id="ab-h">能力値</h2>
            ${radar(STATS.map((s) => h[s.key]), STATS.map((s) => s.label))}
            <dl style="display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;font-size:.88rem;margin:8px 0 0">
              ${STATS.map((s) => `<dt>${s.label}</dt><dd class="muted" style="margin:0">${s.help}</dd><dd style="margin:0;text-align:right" class="tnum"><b>${h[s.key]}</b></dd>`).join('')}
            </dl>
          </section>
          <section class="card" aria-labelledby="apt-h"><h2 id="apt-h">適性・脚質</h2>
            <table class="table"><tbody>
              <tr><th>脚質</th><td><b>${STYLE_LABEL[h.style]}</b></td></tr>
              <tr><th>最適距離</th><td><b>${h.bestDistance}m</b> 前後</td></tr>
              <tr><th>芝</th><td><span class="grade grade-${h.turf}">${h.turf}</span></td></tr>
              <tr><th>ダート</th><td><span class="grade grade-${h.dirt}">${h.dirt}</span></td></tr>
              <tr><th>道悪（重・不良）</th><td><span class="grade grade-${h.heavy}">${h.heavy}</span></td></tr>
            </tbody></table>
            <p style="margin-top:12px">${esc(h.note)}</p>
            <p class="muted" style="font-size:.82rem">脚質の目安 — 逃げ：先頭でレースを進める／先行：前の方につける／差し：中団から伸びる／追込：後方から一気に追い込む。</p>
          </section>
        </div>
        <section class="card" style="margin-top:12px" aria-labelledby="ent-h"><h2 id="ent-h">この開催の出走</h2>
          ${
            entries.length
              ? `<ul class="race-list">${entries
                  .map(({ c, e }) => {
                    const rt = m.runtime[c.id];
                    const fin = raceStatus(rt, now) === 'finished' && rt.order ? `${rt.order.indexOf(e!.number) + 1}着` : '';
                    return `<li class="race-item"><a href="#/race/${encodeURIComponent(c.id)}">
                      <span class="race-no">${c.no}R</span>
                      <span><b>${raceTitle(c)}</b><br><span class="race-meta">${surfaceChip(c)} ${conditionText(c)}・${numBadge(e!.number, e!.frame)} ${esc(e!.jockey)}</span></span>
                      <span><b>${fin}</b></span></a></li>`;
                  })
                  .join('')}</ul>`
              : '<p class="muted">この開催には出走していません。</p>'
          }
        </section>`;
      el.querySelector('[data-back]')?.addEventListener('click', () => history.back());
    },
  };
}
