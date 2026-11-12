import { raceStatus } from '../../core/raceflow';
import { HORSE_BY_ID, STYLE_LABEL } from '../../data/roster';
import { type DistanceAptitude, GROWTH_LABEL, distanceFit, gradeOf, profileOf } from '../../core/ability';
import { type WorldHorse, ageOf, findHorse, formOf } from '../../core/world';
import { DEV_DEFAULT, GROWTH_KEYS, INJURY_LABEL, bioAge, conditionLabel, maturity } from '../../core/lifecycle';
import { EVAL_LABEL, MENU_BY_ID, type MenuId } from '../../core/training';
import { formatTime } from '../../core/sim';
import { type Page, conditionText, raceTitle, surfaceChip } from '../common';
import { store } from '../store';
import { esc, numBadge } from '../util';

type StatKey = 'speed' | 'stamina' | 'burst' | 'sustain' | 'power' | 'temper' | 'control' | 'start' | 'health';
const STATS: { key: StatKey; label: string; help: string }[] = [
  { key: 'speed', label: 'スピード', help: '最高速度。短距離ほど差が大きく出る' },
  { key: 'stamina', label: 'スタミナ', help: '消耗のしにくさ。長距離ほど差が大きく出る' },
  { key: 'burst', label: '瞬発力', help: '仕掛けたときの加速と末脚の切れ。直線の短いコースで生きる' },
  { key: 'sustain', label: '持続力', help: '高い速度を長く保つ力。スパート中に消耗しにくい' },
  { key: 'power', label: 'パワー', help: 'ダート・重い馬場・坂への強さ' },
  { key: 'temper', label: '気性', help: '高いほど落ち着いていて掛かりにくく、ゲートでも出遅れにくい' },
  { key: 'control', label: '操縦性', help: '騎手の指示への反応。位置取りが正確で、掛かっても早く折り合う' },
  { key: 'start', label: 'ゲート', help: 'スタートの反応と二の脚' },
  { key: 'health', label: '健康', help: '体調の安定（当日の出来のぶれが小さい）・故障のしにくさ・疲労の回復の早さ' },
];

/** 距離適性のグラフ（1000〜3600m で能力を発揮できる割合） */
function distanceChart(apt: DistanceAptitude): string {
  const W = 300;
  const H = 90;
  const x = (d: number) => ((d - 1000) / 2600) * (W - 20) + 10;
  const y = (f: number) => H - 18 - f * (H - 30);
  const pts: string[] = [];
  for (let d = 1000; d <= 3600; d += 50) pts.push(`${x(d).toFixed(1)},${y(distanceFit(apt, d)).toFixed(1)}`);
  const ticks = [1200, 1600, 2000, 2400, 3000, 3400]
    .map((d) => `<line x1="${x(d)}" x2="${x(d)}" y1="${H - 18}" y2="${H - 14}" stroke="var(--muted)"/><text x="${x(d)}" y="${H - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${d}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:360px" role="img" aria-label="距離適性：中心${apt.center}m、短い側の幅${apt.short}m、長い側の幅${apt.long}m">
    <line x1="10" x2="${W - 10}" y1="${H - 18}" y2="${H - 18}" stroke="var(--border)"/>${ticks}
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--turf)" stroke-width="2.5"/>
    <line x1="${x(apt.center)}" x2="${x(apt.center)}" y1="${y(1)}" y2="${H - 18}" stroke="var(--turf)" stroke-dasharray="3 3"/></svg>`;
}

/** 成長曲線（スピードの、ピーク時に対する割合。2〜9歳）と現在の位置 */
function growthChart(h: WorldHorse, now: number): string {
  const W = 300;
  const H = 100;
  const x = (a: number) => ((a - 1.7) / 7.6) * (W - 20) + 10;
  const y = (f: number) => H - 18 - ((f - 0.6) / 0.42) * (H - 30);
  const curve = (k: (typeof GROWTH_KEYS)[number], color: string) => {
    const pts: string[] = [];
    for (let a = 1.7; a <= 9.3; a += 0.1) pts.push(`${x(a).toFixed(1)},${y(maturity(h.growthType ?? 'normal', h.growth ?? 60, a, k, h.life.peakShift)).toFixed(1)}`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };
  const ticks = [2, 3, 4, 5, 6, 7, 8, 9].map((a) => `<text x="${x(a - 0.3)}" y="${H - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${a}歳</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:360px" role="img" aria-label="成長曲線">
    <line x1="10" x2="${W - 10}" y1="${H - 18}" y2="${H - 18}" stroke="var(--border)"/>${ticks}
    ${curve('stamina', '#7aa7d6')}${curve('speed', 'var(--turf)')}
    <line x1="${x(now)}" x2="${x(now)}" y1="8" y2="${H - 18}" stroke="#ffd166" stroke-dasharray="3 3"/>
    <text x="${x(now) + 4}" y="16" font-size="10" fill="#ffd166">現在</text></svg>
    <p class="muted" style="font-size:.78rem;margin:0">緑：スピード　青：スタミナ（ピーク時を上端とした割合の目安）</p>`;
}

const bar = (v: number, warn: number) =>
  `<span style="display:inline-block;width:120px;height:8px;background:var(--border);border-radius:4px;vertical-align:middle"><span style="display:block;width:${Math.min(100, v)}%;height:100%;border-radius:4px;background:${v >= warn ? '#e07a5f' : 'var(--turf)'}"></span></span> <span class="tnum">${Math.round(v)}</span>`;

function lifeSection(h: WorldHorse, date: { year: number; week: number }): string {
  const age = bioAge(h.birthYear, date);
  const m = maturity(h.growthType ?? 'normal', h.growth ?? 60, age, 'speed', h.life.peakShift);
  const next = maturity(h.growthType ?? 'normal', h.growth ?? 60, age + 0.5, 'speed', h.life.peakShift);
  const stage = m >= 0.995 ? (next < m - 0.005 ? 'ピーク（そろそろ下り坂）' : 'ピーク') : next > m ? '成長中' : '下り坂';
  const f = formOf(h, date);
  const inj = h.life.injury;
  return `<section class="card" style="margin-top:12px" aria-labelledby="life-h"><h2 id="life-h">状態と成長</h2>
    ${h.status === 'retired' ? `<p class="notice">${h.retiredAt?.year}年に引退（${esc(h.retireReason ?? '')}）</p>` : ''}
    <div class="grid grid-2">
      <div>
        <table class="table"><tbody>
          <tr><th>調子</th><td><b>${conditionLabel(f.condition)}</b></td></tr>
          <tr><th>身体的疲労</th><td>${bar(f.fatigue, 30)}</td></tr>
          <tr><th>精神的疲労</th><td>${bar(f.mental, 40)}</td></tr>
          <tr><th>故障</th><td>${inj ? `<b class="neg">${esc(inj.name)}（${INJURY_LABEL[inj.severity]}）</b> 復帰まで約${inj.weeksLeft}週` : 'なし'}</td></tr>
          <tr><th>仕上がり</th><td>${bar(h.life.fitness ?? 50, 101)}</td></tr>
          <tr><th>成長の段階</th><td><b>${stage}</b>（成長型：${{ early: '早熟', normal: '普通', late: '晩成' }[h.growthType ?? 'normal']}）</td></tr>
        </tbody></table>
        <p class="muted" style="font-size:.8rem">疲労はレースで増え、休養で抜けます（1600mで約5週）。疲労が残っている馬は出走を見送ります。調子には周期的な波があり、疲労・休み明けでも下がります。</p>
      </div>
      <div>${growthChart(h, age)}</div>
    </div>
    <h3 style="margin-top:12px">調教</h3>
    <div class="grid grid-2">
      <div>${trainTable(h)}</div>
      <div>
        <table class="table"><caption class="sr-only">鍛え具合</caption><tbody>
          ${GROWTH_KEYS.map((k) => `<tr><th>${{ speed: 'スピード', stamina: 'スタミナ', accel: '瞬発力', sustain: '持続力', power: 'パワー' }[k]}</th><td>${bar((h.life.dev?.[k] ?? DEV_DEFAULT) * 100, 101)}</td></tr>`).join('')}
        </tbody></table>
        <p class="muted" style="font-size:.8rem">鍛え具合：調教で上がり、鍛えないと少しずつ落ちます。能力への影響は成長曲線の −3%〜＋2%（上限に近いほど伸びにくい）。</p>
      </div>
    </div>
  </section>`;
}

function trainTable(h: WorldHorse): string {
  const rows = h.life.train ?? [];
  if (!rows.length) return '<p class="muted">調教の記録はまだありません。</p>';
  return `<div class="table-wrap"><table class="table"><caption class="sr-only">調教履歴</caption>
    <thead><tr><th>日付</th><th>メニュー</th><th>評価</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const m = MENU_BY_ID[r.m as MenuId];
        return `<tr><td class="tnum">${r.y}年${r.w}週</td><td title="${esc(m?.description ?? '')}">${esc(m?.label ?? r.m)}</td><td>${r.e ? `<b>${r.e}</b> <span class="muted" style="font-size:.8rem">${EVAL_LABEL[r.e]}</span>` : '—'}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
}

const aptRow = (label: string, v: number, help: string) =>
  `<tr><th>${label}</th><td><span class="grade grade-${gradeOf(v)}">${gradeOf(v)}</span> <span class="tnum muted">${v}</span></td><td class="muted" style="font-size:.82rem">${help}</td></tr>`;

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
  const wh = findHorse(store.state.world, horseId);
  const h = wh ?? HORSE_BY_ID.get(horseId);
  if (!h) return { title: '馬が見つかりません', render: (el) => (el.innerHTML = '<h1>馬が見つかりません</h1><p><a href="#/races">レース一覧へ</a></p>') };

  const p = profileOf(h);
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
        <p class="muted">${h.sex}${wh ? ageOf(wh, store.state.world.date) : h.age}・${h.coat}・${esc(h.trainer)}（架空）</p>
        ${
          wh
            ? `<p>通算 <b>${wh.career.starts}戦${wh.career.wins}勝</b>［${wh.career.wins}-${wh.career.seconds}-${wh.career.thirds}-${wh.career.starts - wh.career.wins - wh.career.seconds - wh.career.thirds}］${wh.status === 'retired' ? '・引退' : ''}</p>`
            : ''
        }
        <div class="grid grid-2">
          <section class="card" aria-labelledby="ab-h"><h2 id="ab-h">能力値</h2>
            ${radar(STATS.map((s) => p[s.key]), STATS.map((s) => s.label))}
            <dl style="display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;font-size:.88rem;margin:8px 0 0">
              ${STATS.map((s) => `<dt>${s.label}</dt><dd class="muted" style="margin:0">${s.help}</dd><dd style="margin:0;text-align:right" class="tnum"><b>${p[s.key]}</b></dd>`).join('')}
              <dt>成長型</dt><dd class="muted" style="margin:0">能力がピークを迎える時期（早熟：3歳前後、普通：4〜5歳、晩成：5〜6歳）</dd><dd style="margin:0;text-align:right"><b>${GROWTH_LABEL[p.growthType]}</b></dd>
            </dl>
          </section>
          <section class="card" aria-labelledby="apt-h"><h2 id="apt-h">適性・脚質</h2>
            <p style="margin:0 0 4px"><b>脚質</b>：${STYLE_LABEL[h.style]}（目安。実際の位置取りは出走メンバーと展開で変わります）</p>
            <p style="margin:8px 0 0"><b>距離適性</b>：得意 ${p.apt.distance.center}m（短い側の幅 ${p.apt.distance.short}m・長い側の幅 ${p.apt.distance.long}m）</p>
            ${distanceChart(p.apt.distance)}
            <table class="table" style="margin-top:8px"><tbody>
              ${aptRow('芝', p.apt.turf, '')}
              ${aptRow('ダート', p.apt.dirt, '')}
              ${aptRow('道悪（重・不良）', p.apt.going, '雨で渋った馬場')}
              ${aptRow('右回り', p.apt.right, '')}
              ${aptRow('左回り', p.apt.left, '')}
              ${aptRow('坂', p.apt.slope, 'ゴール前の上り坂')}
              ${aptRow('小回り', p.apt.tight, 'コーナーのきついコース')}
              ${aptRow('長い直線', p.apt.longStraight, '直線の長いコース')}
              ${aptRow('暑さ', p.apt.heat, '真夏')}
              ${aptRow('寒さ', p.apt.cold, '真冬')}
            </tbody></table>
            <p style="margin-top:12px">${esc(h.note)}</p>
            <p class="muted" style="font-size:.82rem">脚質の目安 — 逃げ：先頭でレースを進める／先行：前の方につける／差し：中団から伸びる／追込：後方から一気に追い込む。</p>
          </section>
        </div>
        ${wh ? lifeSection(wh, store.state.world.date) : ''}
        <section class="card" style="margin-top:12px" aria-labelledby="hist-h"><h2 id="hist-h">競走成績（直近10走）</h2>
          ${
            wh && wh.history.length
              ? `<div class="table-wrap"><table class="table nowrap">
                  <caption class="sr-only">競走成績</caption>
                  <thead><tr><th>日付</th><th>レース</th><th>コース</th><th>馬場</th><th class="r">頭数</th><th class="r">馬番</th><th class="r">着順</th><th class="r">タイム</th><th>着差</th><th class="r">上がり</th><th>通過</th><th>騎手</th><th class="r">人気</th></tr></thead>
                  <tbody>${wh.history
                    .map(
                      (r) => `<tr><td class="tnum">${r.y}年${r.w}週</td><td><a href="#/race/${encodeURIComponent(r.r)}">${esc(r.n)}</a></td><td>${esc(r.c)}</td><td>${esc(r.g)}</td>
                        <td class="r tnum">${r.f}</td><td class="r tnum">${r.no}</td><td class="r"><b>${r.rk}</b></td><td class="r tnum">${formatTime(r.t)}</td><td>${esc(r.m || '—')}</td>
                        <td class="r tnum">${r.l3.toFixed(1)}</td><td class="tnum">${esc(r.p)}</td><td>${esc(r.j)}</td><td class="r tnum">${r.pop ?? '—'}</td></tr>`,
                    )
                    .join('')}</tbody></table></div>
                 <p class="muted" style="font-size:.8rem">画面を閉じていた間の開催日の成績（観戦しなかったレース）には、人気・オッズがありません。</p>`
              : '<p class="muted">まだ出走していません。</p>'
          }
        </section>
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
