import { createMeeting, runRace, verifyRace } from './core/meeting';
import { GOING_LABEL, PACE_LABEL, SURFACE_LABEL, WEATHER_LABEL, formatTime } from './core/sim';
import { HORSE_BY_ID, STYLE_LABEL, TRACK_NAME } from './data/roster';

// Step 2: シミュレーションエンジンのテキストプレビュー。画面は Step 4 で実装する
const app = document.getElementById('app')!;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function render(meetingId: string, raceNo: number) {
  const cards = await createMeeting(meetingId);
  const card = cards[raceNo - 1];
  const res = runRace(card, card.seed);
  const verify = await verifyRace(card, card.seed);
  const c = card.conditions;
  const num = (i: number) => card.entries[i].number;
  const rows = res.order
    .map((i, rank) => {
      const e = card.entries[i];
      const h = HORSE_BY_ID.get(e.horseId)!;
      const f = res.factors[i];
      const notes = [
        f.lateStart && '出遅れ',
        f.kakari && '掛かり',
        f.blockedTime > 2 && `詰まり${f.blockedTime.toFixed(1)}s`,
        f.gaveUpLead && 'ハナ争い負け',
      ].filter(Boolean);
      return `<tr><td>${rank + 1}</td><td>${e.frame}</td><td>${e.number}</td><td>${esc(h.name)}</td>
        <td>${STYLE_LABEL[h.style]}</td><td>${formatTime(res.finishTimes[i])}</td><td>${res.margins[i]}</td>
        <td>${res.last3F[i].toFixed(1)}</td><td>${f.laneLoss.toFixed(1)}m</td><td>${notes.join('・')}</td></tr>`;
    })
    .join('');

  app.innerHTML = `
  <main style="font-family:system-ui,sans-serif;max-width:60rem;margin:1.5rem auto;padding:0 16px;line-height:1.6">
    <h1 style="font-size:1.4rem">Virtual Turf — シミュレーション プレビュー（Step 2）</h1>
    <p>${TRACK_NAME} ${card.no}R ${esc(card.name)}｜${SURFACE_LABEL[c.surface]}${c.distance}m・${WEATHER_LABEL[c.weather]}・${GOING_LABEL[c.going]}・${card.entries.length}頭</p>
    <p>
      <label>レース <select id="race">${cards.map((k) => `<option value="${k.no}" ${k.no === raceNo ? 'selected' : ''}>${k.no}R ${esc(k.name)}</option>`).join('')}</select></label>
      <button id="next">別の開催を生成</button>
    </p>
    <p>ペース: <b>${PACE_LABEL[res.pace]}</b>（前半3F ${res.first3F.toFixed(1)} / 後半3F ${res.final3F.toFixed(1)}）<br>
      ラップ: ${res.splits.map((s) => s.toFixed(1)).join(' - ')}</p>
    <div style="overflow-x:auto"><table style="border-collapse:collapse;white-space:nowrap" border="1" cellpadding="4">
      <thead><tr><th>着</th><th>枠</th><th>馬番</th><th>馬名</th><th>脚質</th><th>タイム</th><th>着差</th><th>上がり3F</th><th>外々ロス</th><th>メモ</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p>通過順: ${res.cornerOrders.map((k) => `${k.corner}角 ${k.order.map(num).join('-')}`).join('｜')}</p>
    <details><summary>公正性の検証（コミット・リビール）</summary>
      <p style="word-break:break-all">コミット（発売前に公開）: <code>${card.commit}</code><br>
      公開 seed: <code>${card.seed}</code><br>
      再計算ハッシュ: <code>${verify.recomputedHash}</code> → ${verify.hashOk ? '✅ 一致' : '❌ 不一致'}<br>
      再計算着順: ${verify.order.join('-')}</p>
    </details>
    <p style="color:#555">デモ専用・架空の馬とレースです。映像・投票画面は今後のステップで実装します。</p>
  </main>`;

  app.querySelector<HTMLSelectElement>('#race')!.onchange = (ev) =>
    render(meetingId, Number((ev.target as HTMLSelectElement).value));
  app.querySelector<HTMLButtonElement>('#next')!.onclick = () => render(`m${Date.now()}`, raceNo);
}

render(`m${new Date().toISOString().slice(0, 10)}`, 8);
