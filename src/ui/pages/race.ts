/**
 * レース詳細・観戦画面：映像、出馬表、オッズ、投票、実況、結果を1画面で扱う。
 * スマートフォンでは映像の下をタブで切り替え、PC では右側に投票パネルを常時表示する。
 */
import { BET_TYPES, BET_TYPE_BY_ID, type BetTypeId, parseKey } from '../../core/bettypes';
import { type CommentaryLine, buildCommentary } from '../../core/commentary';
import { runRace, verifyRace } from '../../core/meeting';
import { type OddsBook, payout, popularity } from '../../core/pool';
import { closeRace, currentOddsBook, finishRace } from '../../core/raceflow';
import { PACE_LABEL, type SimResult, formatTime } from '../../core/sim';
import { placeBet, quoteBet } from '../../core/state';
import { STYLE_LABEL } from '../../data/roster';
import { createViewer } from '../../render';
import { Playback, gateFrames } from '../../render/playback';
import { CAMERA_LABEL, type CameraMode, type RaceViewer } from '../../render/types';
import {
  type Page,
  conditionText,
  horseOf,
  raceTitle,
  runtimeOf,
  statusChip,
  statusOf,
  surfaceChip,
  timingText,
} from '../common';
import { store } from '../store';
import { $, coins, countdown, esc, numBadge, openDialog, toast } from '../util';

type Tab = 'card' | 'bet' | 'odds' | 'feed' | 'result';
const TAB_LABEL: Record<Tab, string> = { card: '出馬表', bet: '投票', odds: 'オッズ', feed: '実況', result: '結果' };

export function racePage(raceId: string): Page {
  const card = store.state.meeting?.cards.find((c) => c.id === raceId);
  if (!card) {
    return {
      title: 'レースが見つかりません',
      render: (el) =>
        (el.innerHTML = `<h1>レースが見つかりません</h1><p>開催が新しくなった可能性があります。<a href="#/races">レース一覧へ</a></p>`),
    };
  }
  const numbers = card.entries.map((e) => e.number);
  const wideMq = matchMedia('(min-width: 1024px)');

  let el: HTMLElement;
  let tab: Tab = statusOf(card) === 'finished' ? 'result' : 'card';
  let betType: BetTypeId = 'win';
  let selection: number[] = [];
  let stake = 100;
  let viewer: RaceViewer | null = null;
  let playback: Playback | null = null;
  let result: SimResult | null = null;
  let commentary: CommentaryLine[] = [];
  let raf = 0;
  let lastStatus = statusOf(card);
  let lastOddsKey = '';
  let camera: CameraMode = 'auto';
  let followIndex = 0;
  let lastOverlay = 0;
  let lastLive = 0;
  let lastFeedCount = -1;
  let verifyHtml = '';
  const resizeObs = new ResizeObserver(() => viewer?.resize());

  const isWide = () => wideMq.matches;
  const tabs = (): Tab[] => (isWide() ? ['card', 'odds', 'feed', 'result'] : ['card', 'bet', 'odds', 'feed', 'result']);

  // ---- データ ----
  const probs = () => store.getProbs(card.id);
  const book = (): OddsBook | null => {
    const p = probs();
    return p ? currentOddsBook(store.state, card, p, store.now()) : null;
  };
  const ensureResult = (): SimResult | null => {
    // 結果は締切後にだけ計算する（発売中に画面から結果が分からないように）
    if (result || statusOf(card) === 'open') return result;
    result = runRace(card, card.seed);
    playback = new Playback(card, result);
    playback.speed = store.prefs.speed;
    commentary = buildCommentary(card, result);
    viewer?.setRace(card, result);
    return result;
  };
  const restriction = (): string | null => {
    const s = store.state;
    const now = store.now();
    if ((s.selfExcludedUntil ?? 0) > now) return '自己排除の期間中のため、投票できません。';
    if ((s.breakUntil ?? 0) > now) return '休止期間中のため、投票できません。';
    return null;
  };

  // ---- 部分テンプレート ----
  const oddsText = (b: OddsBook | null, type: BetTypeId, key: string): string => {
    if (!b) return '—';
    if (type === 'place') {
      const r = b.placeRange[key];
      return r ? `${r[0].toFixed(1)}–${r[1].toFixed(1)}` : '—';
    }
    const o = b.odds[type][key];
    return o === null || o === undefined ? '—' : o.toFixed(1);
  };

  const oddsStateHtml = () => {
    const st = statusOf(card);
    if (st === 'open') return `<span class="odds-state"><i class="dot live" aria-hidden="true"></i>変動中（10秒ごとに更新）</span>`;
    return `<span class="odds-state"><i class="dot" aria-hidden="true"></i>確定（締切時点）</span>`;
  };

  const cardTab = () => {
    const b = book();
    const pop = b ? popularity(b, 'win') : [];
    const fin = runtimeOf(card).order;
    return `
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">${raceTitle(card)} 出馬表</caption>
        <thead><tr><th>馬番</th><th>馬名・騎手</th><th>脚質</th><th>適性</th><th class="r">単勝</th><th class="r">人気</th>${fin ? '<th class="r">着順</th>' : ''}</tr></thead>
        <tbody>${card.entries
          .map((e) => {
            const h = horseOf(e);
            const key = String(e.number);
            const surf = card.conditions.surface === 'turf' ? h.turf : h.dirt;
            return `<tr class="${selection.includes(e.number) ? 'is-selected' : ''}">
              <td>${numBadge(e.number, e.frame, 'lg')}</td>
              <td class="entry-name"><a href="#/horse/${h.id}">${esc(h.name)}</a><div class="entry-sub">${h.sex}${h.age}・${esc(e.jockey)}・${h.coat}</div></td>
              <td>${STYLE_LABEL[h.style]}</td>
              <td><span class="entry-sub">${card.conditions.surface === 'turf' ? '芝' : 'ダ'}</span> <span class="grade grade-${surf}">${surf}</span> <span class="entry-sub">${h.bestDistance}m</span></td>
              <td class="r tnum" data-odds="win:${key}">${oddsText(b, 'win', key)}</td>
              <td class="r tnum" data-pop="${key}">${pop.indexOf(key) >= 0 ? pop.indexOf(key) + 1 : '—'}</td>
              ${fin ? `<td class="r"><b>${fin.indexOf(e.number) + 1}</b></td>` : ''}
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="muted" style="font-size:.82rem">馬名を選ぶと能力値と適性の詳細が見られます。適性はA（得意）〜D（苦手）。</p>`;
  };

  const oddsTab = () => {
    const b = book();
    if (!b) return `<p class="loading">オッズを集計しています…</p>`;
    const top = (t: BetTypeId) =>
      popularity(b, t)
        .slice(0, 12)
        .map((k) => {
          const parts = parseKey(k);
          const sep = BET_TYPE_BY_ID[t].ordered ? '→' : '-';
          return `<li><span>${parts.map((n) => numBadge(n, card.entries.find((e) => e.number === n)!.frame)).join(sep)}</span> <b class="tnum">${oddsText(b, t, k)}</b></li>`;
        })
        .join('');
    return `
      <p>${oddsStateHtml()}</p>
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">単勝・複勝オッズ</caption>
        <thead><tr><th>馬番</th><th>馬名</th><th class="r">単勝</th><th class="r">複勝（幅）</th></tr></thead>
        <tbody>${card.entries
          .map((e) => {
            const k = String(e.number);
            return `<tr><td>${numBadge(e.number, e.frame)}</td><td>${esc(horseOf(e).name)}</td>
              <td class="r tnum" data-odds="win:${k}">${oddsText(b, 'win', k)}</td>
              <td class="r tnum" data-odds="place:${k}">${oddsText(b, 'place', k)}</td></tr>`;
          })
          .join('')}</tbody></table></div>
      <div class="grid grid-2" style="margin-top:12px">
        <div><h3>馬連 人気上位</h3><ol class="feed" style="max-height:none">${top('quinella')}</ol></div>
        <div><h3>馬単 人気上位</h3><ol class="feed" style="max-height:none">${top('exacta')}</ol></div>
      </div>
      <p class="muted" style="font-size:.82rem">票数（デモ）: ${BET_TYPES.map((t) => `${t.label} ${coins(b.totals[t.id])}`).join('／')}。
      オッズ＝票数の合計×(1−控除率)÷その組み合わせの票数。<a href="#/guide">仕組みを詳しく</a></p>`;
  };

  const myTickets = () => {
    const mine = store.state.tickets.filter((t) => t.raceId === card.id);
    if (!mine.length) return '<p class="muted" style="font-size:.85rem">このレースの購入はまだありません。</p>';
    return `<ul class="feed" style="max-height:none">${mine
      .map((t) => {
        const type = BET_TYPE_BY_ID[t.betType];
        const status =
          t.status === 'open'
            ? '<span class="chip chip-open">発売・未確定</span>'
            : t.status === 'won'
              ? `<span class="chip chip-open">的中 ${coins(t.payout!)}（${t.finalOdds!.toFixed(1)}倍）</span>`
              : '<span class="chip chip-finished">不的中</span>';
        return `<li><time>${type.label}</time><span>${t.selection.join(type.ordered ? '→' : '-')}・${coins(t.stake)}コイン ${status}</span></li>`;
      })
      .join('')}</ul>`;
  };

  const betPanel = () => {
    const st = statusOf(card);
    const type = BET_TYPE_BY_ID[betType];
    const b = book();
    const restricted = restriction();
    const head = `<h2>投票（デモコイン）</h2>`;
    if (st !== 'open') {
      return `${head}<p class="notice notice-info">このレースの発売は締め切られました。</p><h3 style="margin-top:12px">購入した券</h3>${myTickets()}`;
    }
    if (restricted) {
      return `${head}<p class="notice">${restricted}</p><p><a href="#/account">設定を確認</a></p><h3>購入した券</h3>${myTickets()}`;
    }
    const picks = card.entries
      .map((e) => {
        const idx = selection.indexOf(e.number);
        const orderBadge = type.ordered && idx >= 0 ? `<span class="pick-order">${idx + 1}着</span>` : '';
        const oddsKey = type.picks === 1 ? String(e.number) : '';
        return `<button type="button" class="pick" data-pick="${e.number}" aria-pressed="${idx >= 0}">
          ${numBadge(e.number, e.frame)}<span class="nm">${esc(horseOf(e).name)}</span>${orderBadge}
          <span class="odds" ${oddsKey ? `data-odds="${betType}:${oddsKey}"` : ''}>${oddsKey ? oddsText(b, betType, oddsKey) : ''}</span>
        </button>`;
      })
      .join('');
    return `${head}
      <div class="seg" role="group" aria-label="券種">${BET_TYPES.map(
        (t) => `<button type="button" data-type="${t.id}" aria-pressed="${t.id === betType}">${t.label}</button>`,
      ).join('')}</div>
      <p class="muted" style="font-size:.85rem;margin:8px 0">${type.description}${type.ordered ? '（1着→2着の順に選択）' : ''}</p>
      <div class="picker" role="group" aria-label="馬を選択">${picks}</div>
      <div class="betbar">
        <label class="field" style="margin-bottom:8px"><span>賭け金（100コイン単位）</span>
          <input type="number" inputmode="numeric" min="100" step="100" value="${stake}" data-stake aria-describedby="quote-msg"></label>
        <div class="btn-row" style="margin-bottom:8px">
          ${[100, 500, 1000].map((v) => `<button type="button" class="btn btn-sm" data-add="${v}">+${v}</button>`).join('')}
          <button type="button" class="btn btn-sm" data-add="0">リセット</button>
        </div>
        <div data-quote></div>
        <button type="button" class="btn btn-primary btn-block" data-confirm>購入内容を確認</button>
      </div>
      <h3 style="margin-top:16px">購入した券</h3>${myTickets()}`;
  };

  const quoteHtml = () => {
    const b = book();
    if (!b) return '<p class="muted" id="quote-msg">オッズを集計しています…</p>';
    const type = BET_TYPE_BY_ID[betType];
    if (selection.length < type.picks) {
      return `<p class="muted" id="quote-msg">あと${type.picks - selection.length}頭を選んでください。</p>`;
    }
    const q = quoteBet(store.state, { raceId: card.id, betType, selection, stake }, numbers, b, store.now(), true);
    const est = q.estPayout ? (q.estPayout[0] === q.estPayout[1] ? coins(q.estPayout[0]) : `${coins(q.estPayout[0])}〜${coins(q.estPayout[1])}`) : '—';
    const msg = q.selectionError ?? (q.check.ok ? '' : q.check.message);
    return `<dl class="quote">
        <dt>${type.label}</dt><dd>${selection.join(type.ordered ? '→' : '-')}</dd>
        <dt>現在のオッズ</dt><dd>${oddsText(b, betType, q.key)}倍</dd>
        <dt>想定払戻</dt><dd>${est}</dd>
        <dt>購入後の残高</dt><dd>${coins(q.balanceAfter)}</dd>
      </dl>
      <p id="quote-msg" class="${msg ? 'neg' : 'muted'}" style="font-size:.85rem;margin:0 0 8px">${esc(msg || 'オッズは締切まで変動します。払戻は確定オッズで計算されます。')}</p>`;
  };

  const feedTab = () => {
    if (statusOf(card) === 'open') return '<p class="muted">発走後に実況が表示されます。</p>';
    ensureResult();
    const t = currentTime();
    const lines = commentary.filter((l) => l.t <= t);
    if (!lines.length) return '<p class="muted">まもなく発走です。</p>';
    return `<ol class="feed" aria-label="実況">${[...lines]
      .reverse()
      .map((l) => `<li><time>${formatTime(l.t)}</time><span>${esc(l.text)}</span></li>`)
      .join('')}</ol>`;
  };

  const resultTab = () => {
    const rt = runtimeOf(card);
    if (!rt.order || !rt.payoutOdds) return '<p class="muted">レース確定後に結果が表示されます。</p>';
    const res = ensureResult()!;
    // 締切後は確定プールから計算されるため、確定オッズ・確定人気になる
    const winOdds = rt.finalPools ? currentOddsBook(store.state, card, probs() ?? store.probsSync(card), store.now()) : null;
    const finalPop = winOdds ? popularity(winOdds, 'win') : [];
    const rows = res.order
      .map((i, rank) => {
        const e = card.entries[i];
        const h = horseOf(e);
        return `<tr><td><b>${rank + 1}</b></td><td>${numBadge(e.number, e.frame)}</td>
          <td class="entry-name"><a href="#/horse/${h.id}">${esc(h.name)}</a><div class="entry-sub">${esc(e.jockey)}・${STYLE_LABEL[h.style]}</div></td>
          <td class="tnum">${formatTime(res.finishTimes[i])}</td><td class="tnum">${res.margins[i]}</td>
          <td class="r tnum hide-sm">${res.last3F[i].toFixed(1)}</td>
          <td class="r tnum">${winOdds ? oddsText(winOdds, 'win', String(e.number)) : '—'}</td>
          <td class="r hide-sm">${finalPop.indexOf(String(e.number)) + 1 || '—'}</td></tr>`;
      })
      .join('');
    const payouts = BET_TYPES.flatMap((t) =>
      Object.entries(rt.payoutOdds![t.id]).map(
        ([k, o]) =>
          `<tr><td>${t.label}</td><td>${k.replace('>', '→')}</td><td class="r tnum">${coins(payout(100, o))}</td><td class="r tnum">${o.toFixed(1)}倍</td></tr>`,
      ),
    ).join('');
    const mine = store.state.tickets.filter((t) => t.raceId === card.id);
    const stakeSum = mine.reduce((a, t) => a + t.stake, 0);
    const paySum = mine.reduce((a, t) => a + (t.payout ?? 0), 0);
    return `
      <h2>確定 — ${PACE_LABEL[res.pace]}</h2>
      <p class="muted" style="font-size:.85rem">前半3F ${res.first3F.toFixed(1)}／後半3F ${res.final3F.toFixed(1)}／ラップ ${res.splits.map((s) => s.toFixed(1)).join('-')}</p>
      <div class="table-wrap"><table class="table">
        <caption class="sr-only">着順</caption>
        <thead><tr><th>着</th><th>馬番</th><th>馬名</th><th>タイム</th><th>着差</th><th class="r hide-sm">上がり3F</th><th class="r">単勝</th><th class="r hide-sm">人気</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="muted" style="font-size:.85rem">通過順：${res.cornerOrders.map((c) => `${c.corner}角 ${c.order.map((i) => card.entries[i].number).join('-')}`).join('／')}</p>
      <h3>払戻（100コインあたり）</h3>
      <div class="table-wrap"><table class="table"><thead><tr><th>券種</th><th>組番</th><th class="r">払戻</th><th class="r">オッズ</th></tr></thead><tbody>${payouts}</tbody></table></div>
      ${
        mine.length
          ? `<h3 style="margin-top:12px">あなたの結果</h3>
             <p>投票 ${coins(stakeSum)}・払戻 ${coins(paySum)}・収支 <b class="${paySum - stakeSum >= 0 ? 'pos' : 'neg'}">${paySum - stakeSum >= 0 ? '+' : '−'}${coins(Math.abs(paySum - stakeSum))}</b></p>${myTickets()}`
          : ''
      }
      <h3 style="margin-top:12px">公正性の検証</h3>
      <p style="font-size:.85rem;word-break:break-all">発売前に公開したハッシュ: <code>${card.commit}</code><br>公開された seed: <code>${card.seed}</code></p>
      <button class="btn btn-sm" data-verify>この seed で結果を再計算する</button>
      <div data-verify-out aria-live="polite">${verifyHtml}</div>`;
  };

  // ---- 映像 ----
  const currentTime = (): number => {
    const rt = runtimeOf(card);
    const st = statusOf(card);
    if (st === 'running' && rt.startsAt) return Math.max(0, (store.now() - rt.startsAt) / 1000);
    if (st === 'finished' && playback) return playback.time;
    return 0;
  };

  const stageHtml = () => `
    <div class="stage" data-stage>
      <div class="ov ov-tl"><div class="ov-box"><b>${card.no}R</b> ${esc(card.name)}<br>${card.conditions.surface === 'turf' ? '芝' : 'ダート'}${card.conditions.distance}m</div></div>
      <div class="ov ov-tr"><div class="ov-box" data-ov-tr></div></div>
      <div class="ov ov-center" data-ov-center></div>
      <div class="ov ov-bottom"><div class="ticker" data-ticker aria-hidden="true"></div><div class="progress"><i data-progress></i></div></div>
    </div>
    <div class="stage-controls" data-controls></div>
    <div class="sr-only" aria-live="polite" data-live></div>`;

  const controlsHtml = () => {
    const st = statusOf(card);
    const cams = (Object.keys(CAMERA_LABEL) as CameraMode[])
      .map((c) => `<button type="button" data-cam="${c}" aria-pressed="${c === camera}">${CAMERA_LABEL[c]}</button>`)
      .join('');
    const follow = `<label class="sr-only" for="follow-sel">注目馬</label><select id="follow-sel" data-follow style="width:auto;min-height:36px">${card.entries
      .map((e, i) => `<option value="${i}" ${i === followIndex ? 'selected' : ''}>${e.number} ${esc(horseOf(e).name)}</option>`)
      .join('')}</select>`;
    let extra = '';
    if (st === 'open') extra = `<button class="btn btn-sm" data-close-now>今すぐ締切して発走（デモ）</button>`;
    if (st === 'running') extra = `<span class="chip chip-running">LIVE</span><button class="btn btn-sm" data-skip>結果へスキップ</button>`;
    if (st === 'finished' && playback) {
      extra = `<button class="btn btn-sm" data-play aria-label="${playback.paused ? '再生' : '一時停止'}">${playback.paused ? '▶ 再生' : '❚❚ 停止'}</button>
        <div class="seg" role="group" aria-label="再生速度">${[1, 2, 4].map((v) => `<button type="button" data-speed="${v}" aria-pressed="${playback!.speed === v}">${v}x</button>`).join('')}</div>
        <input type="range" min="0" max="${playback.duration.toFixed(1)}" step="0.1" value="${playback.time.toFixed(1)}" data-seek aria-label="再生位置" style="flex:1;min-width:120px">`;
    }
    return `<div class="seg" role="group" aria-label="カメラ">${cams}</div>${follow}${extra}
      <span class="muted" style="font-size:.8rem;margin-left:auto">${viewer?.kind === '3d' ? '3D' : '2D 上空図'}</span>`;
  };

  const mountViewer = () => {
    const stage = el.querySelector<HTMLElement>('[data-stage]');
    if (!stage) return;
    viewer?.dispose();
    viewer = createViewer(store.prefs.viewer);
    viewer.mount(stage);
    viewer.setRace(card, ensureResult());
    viewer.setCamera?.(camera, followIndex);
    resizeObs.disconnect();
    resizeObs.observe(stage);
  };

  const frame = (wall: number) => {
    raf = requestAnimationFrame(frame);
    if (!viewer) return;
    const st = statusOf(card);
    let t = 0;
    let horses = gateFrames(card);
    if (playback && st !== 'open') {
      t = st === 'finished' ? playback.replayClock(wall) : currentTime();
      t = Math.min(t, playback.duration);
      horses = playback.at(t);
    }
    viewer.render(t, horses);

    if (wall - lastOverlay < 200) return;
    lastOverlay = wall;
    updateOverlay(st, t, horses);
  };

  const updateOverlay = (st: ReturnType<typeof statusOf>, t: number, horses: ReturnType<typeof gateFrames>) => {
    const tr = el.querySelector('[data-ov-tr]');
    const center = el.querySelector('[data-ov-center]');
    const ticker = el.querySelector('[data-ticker]');
    const prog = el.querySelector<HTMLElement>('[data-progress]');
    if (!tr || !center || !ticker || !prog) return;
    const rt = runtimeOf(card);
    const D = card.conditions.distance;
    if (st === 'open') {
      tr.innerHTML = `締切まで <b>${countdown(rt.closesAt - store.now())}</b>`;
      center.innerHTML = '';
      ticker.innerHTML = `<span class="ov-box">発売中 — 締切後にゲートインします</span>`;
    } else if (st === 'closed') {
      tr.innerHTML = rt.startsAt ? `発走まで <b>${countdown(rt.startsAt - store.now())}</b>` : '締切';
      center.innerHTML = '';
      ticker.innerHTML = `<span class="ov-box">ゲートイン中…まもなく発走</span>`;
    } else if (playback) {
      const rem = playback.leaderRemaining(horses);
      tr.innerHTML = `${rem > 0 ? `残り <b>${Math.ceil(rem)}m</b>` : '<b>ゴール</b>'}<br><span class="tnum">${formatTime(t)}</span>`;
      center.innerHTML =
        st === 'finished' && playback.time >= playback.duration - 0.05
          ? `<div class="ov-box">確定<br>${result!.order
              .slice(0, 3)
              .map((i, r) => `${r + 1}着 ${numBadge(card.entries[i].number, card.entries[i].frame)} ${esc(horseOf(card.entries[i]).name)}`)
              .join('<br>')}</div>`
          : '';
      prog.style.width = `${Math.min(100, ((D - rem) / D) * 100)}%`;
    }
    const ranked = [...horses].sort((a, b) => a.rank - b.rank);
    if (st !== 'open' && st !== 'closed') ticker.innerHTML = ranked.map((h) => numBadge(h.number, h.frame)).join('');

    // スクリーンリーダー向けの順位読み上げ（8秒ごと）
    if (st === 'running' && performance.now() - lastLive > 8000) {
      lastLive = performance.now();
      const live = el.querySelector('[data-live]');
      const rem = playback ? Math.ceil(playback.leaderRemaining(horses)) : 0;
      if (live)
        live.textContent = `残り${rem}メートル。${ranked
          .slice(0, 3)
          .map((h, i) => `${i + 1}番手 ${h.number}番 ${horseOf(card.entries[h.index]).name}`)
          .join('、')}`;
    }
    // 実況タブは新しい行があるときだけ更新
    if (tab === 'feed' && st !== 'open') {
      const count = commentary.filter((l) => l.t <= t).length;
      if (count !== lastFeedCount) {
        lastFeedCount = count;
        const panel = el.querySelector('[data-panel]');
        if (panel) panel.innerHTML = feedTab();
      }
    }
  };

  // ---- 描画 ----
  const tabPanelHtml = () => {
    switch (tab) {
      case 'card':
        return cardTab();
      case 'bet':
        return betPanel();
      case 'odds':
        return oddsTab();
      case 'feed':
        return feedTab();
      case 'result':
        return resultTab();
    }
  };

  const renderPanels = () => {
    if (!tabs().includes(tab)) tab = 'card';
    $(el, '[data-tabs]').innerHTML = tabs()
      .map(
        (t) =>
          `<button role="tab" id="tab-${t}" aria-controls="panel" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}" data-tab="${t}">${TAB_LABEL[t]}</button>`,
      )
      .join('');
    $(el, '[data-panel]').innerHTML = tabPanelHtml();
    $(el, '[data-panel]').setAttribute('aria-labelledby', `tab-${tab}`);
    const side = el.querySelector<HTMLElement>('[data-side]');
    if (side) {
      side.hidden = !isWide();
      side.innerHTML = isWide() ? `<div class="card">${betPanel()}</div>` : '';
    }
    refreshQuote();
    $(el, '[data-controls]').innerHTML = controlsHtml();
    $(el, '[data-head-status]').innerHTML = `${statusChip(statusOf(card))} <span data-timing>${timingText(card)}</span>`;
    lastFeedCount = -1;
  };

  const refreshQuote = () => {
    el.querySelectorAll('[data-quote]').forEach((q) => (q.innerHTML = quoteHtml()));
  };

  const refreshOdds = () => {
    const b = book();
    el.querySelectorAll<HTMLElement>('[data-odds]').forEach((n) => {
      const [type, key] = n.dataset.odds!.split(':');
      n.textContent = oddsText(b, type as BetTypeId, key);
    });
    if (b) {
      const pop = popularity(b, 'win');
      el.querySelectorAll<HTMLElement>('[data-pop]').forEach((n) => {
        const i = pop.indexOf(n.dataset.pop!);
        n.textContent = i >= 0 ? String(i + 1) : '—';
      });
    }
    refreshQuote();
  };

  const draw = () => {
    el.innerHTML = `
      <nav aria-label="パンくず" class="muted" style="font-size:.85rem;margin-bottom:4px"><a href="#/races">レース一覧</a> › ${card.no}R</nav>
      <div class="race-head"><h1>${raceTitle(card)}</h1><span data-head-status></span></div>
      <p class="race-meta" style="margin-bottom:12px">${surfaceChip(card)} ${conditionText(card)}</p>
      <div class="race-layout">
        <div>
          ${stageHtml()}
          <div class="tabs" role="tablist" aria-label="レース情報" data-tabs></div>
          <div id="panel" role="tabpanel" data-panel></div>
        </div>
        <aside class="race-side" data-side aria-label="投票"></aside>
      </div>`;
    mountViewer();
    renderPanels();
  };

  // ---- 操作 ----
  const confirmPurchase = () => {
    const b = book();
    if (!b) return;
    const type = BET_TYPE_BY_ID[betType];
    const req = { raceId: card.id, betType, selection: [...selection], stake };
    const q = quoteBet(store.state, req, numbers, b, store.now(), statusOf(card) === 'open');
    if (q.selectionError || !q.check.ok) {
      toast(q.selectionError ?? (q.check.ok ? '' : q.check.message), 'warn');
      return;
    }
    const names = selection.map((n) => `${n}番 ${horseOf(card.entries.find((e) => e.number === n)!).name}`).join(type.ordered ? ' → ' : '、');
    const est = q.estPayout![0] === q.estPayout![1] ? coins(q.estPayout![0]) : `${coins(q.estPayout![0])}〜${coins(q.estPayout![1])}`;
    const dlg = openDialog(
      `<div class="dialog-body">
        <h2>購入内容の確認</h2>
        <dl>
          <dt>レース</dt><dd>${raceTitle(card)}</dd>
          <dt>券種</dt><dd>${type.label}</dd>
          <dt>選択</dt><dd>${esc(names)}</dd>
          <dt>賭け金</dt><dd>${coins(stake)} コイン</dd>
          <dt>現在のオッズ</dt><dd>${oddsText(b, betType, q.key)}倍（変動中）</dd>
          <dt>想定払戻</dt><dd>${est} コイン</dd>
          <dt>購入後の残高</dt><dd>${coins(q.balanceAfter)} コイン</dd>
        </dl>
        <p class="muted" style="font-size:.85rem">オッズは締切まで変動し、払戻は締切時点の確定オッズで計算されます。
        購入後の取り消しはできません。デモコインに金銭的な価値はありません。</p>
      </div>
      <div class="dialog-actions">
        <button class="btn" data-close>戻る</button>
        <button class="btn btn-primary" data-buy>購入する</button>
      </div>`,
      { label: '購入内容の確認' },
    );
    dlg.querySelector<HTMLButtonElement>('[data-buy]')!.addEventListener('click', async (ev) => {
      (ev.currentTarget as HTMLButtonElement).disabled = true;
      const r = await placeBet(store.state, req, numbers, book()!, store.now(), statusOf(card) === 'open');
      dlg.close();
      if (!r.ok) return toast(r.message, 'warn');
      selection = [];
      store.set(r.state);
      toast(`${type.label} ${req.selection.join(type.ordered ? '→' : '-')} を ${coins(req.stake)}コインで購入しました。`);
    });
  };

  const onClick = async (ev: Event) => {
    const t = ev.target as HTMLElement;
    const tabBtn = t.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab as Tab;
      renderPanels();
      el.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
      return;
    }
    const typeBtn = t.closest<HTMLElement>('[data-type]');
    if (typeBtn) {
      betType = typeBtn.dataset.type as BetTypeId;
      selection = selection.slice(0, BET_TYPE_BY_ID[betType].picks);
      return renderPanels();
    }
    const pick = t.closest<HTMLElement>('[data-pick]');
    if (pick) {
      const n = Number(pick.dataset.pick);
      const type = BET_TYPE_BY_ID[betType];
      if (selection.includes(n)) selection = selection.filter((x) => x !== n);
      else if (type.picks === 1) selection = [n];
      else selection = [...selection, n].slice(-type.picks);
      renderPanels();
      el.querySelector<HTMLElement>(`[data-pick="${n}"]`)?.focus();
      return;
    }
    const add = t.closest<HTMLElement>('[data-add]');
    if (add) {
      const v = Number(add.dataset.add);
      stake = v === 0 ? 100 : stake + v;
      el.querySelectorAll<HTMLInputElement>('[data-stake]').forEach((i) => (i.value = String(stake)));
      return refreshQuote();
    }
    if (t.closest('[data-confirm]')) return confirmPurchase();
    const cam = t.closest<HTMLElement>('[data-cam]');
    if (cam) {
      camera = cam.dataset.cam as CameraMode;
      viewer?.setCamera?.(camera, followIndex);
      $(el, '[data-controls]').innerHTML = controlsHtml();
      return;
    }
    if (t.closest('[data-close-now]')) {
      store.set(await closeRace(store.state, card.id, store.probsSync(card), store.now()));
      return;
    }
    if (t.closest('[data-skip]')) {
      store.set(await finishRace(store.state, card.id, store.now()));
      return;
    }
    if (t.closest('[data-play]') && playback) {
      if (playback.time >= playback.duration - 0.05) playback.seek(0);
      playback.paused = !playback.paused;
      $(el, '[data-controls]').innerHTML = controlsHtml();
      return;
    }
    const sp = t.closest<HTMLElement>('[data-speed]');
    if (sp && playback) {
      playback.speed = Number(sp.dataset.speed);
      store.setPrefs({ speed: playback.speed });
      return;
    }
    if (t.closest('[data-verify]')) {
      const v = await verifyRace(card, card.seed);
      const official = runtimeOf(card).order!;
      const same = v.order.join('-') === official.join('-');
      verifyHtml = `<p class="${v.hashOk && same ? 'pos' : 'neg'}" style="font-size:.9rem">
        ハッシュ ${v.hashOk ? '一致 ✓' : '不一致 ✗'}／再計算した着順 ${v.order.join('-')}（公式結果と${same ? '一致 ✓' : '不一致 ✗'}）</p>`;
      el.querySelector('[data-verify-out]')!.innerHTML = verifyHtml;
    }
  };

  const onInput = (ev: Event) => {
    const t = ev.target as HTMLInputElement;
    if (t.matches('[data-stake]')) {
      stake = Math.max(0, Math.floor(Number(t.value) || 0));
      refreshQuote();
    } else if (t.matches('[data-seek]') && playback) {
      playback.seek(Number(t.value));
    }
  };

  const onChange = (ev: Event) => {
    const t = ev.target as HTMLSelectElement;
    if (t.matches('[data-follow]')) {
      followIndex = Number(t.value);
      if (camera !== 'follow') camera = 'follow';
      viewer?.setCamera?.(camera, followIndex);
      $(el, '[data-controls]').innerHTML = controlsHtml();
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    // タブのキーボード操作（左右キーで移動）
    const t = ev.target as HTMLElement;
    if (!t.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const list = tabs();
    const i = list.indexOf(tab);
    tab = list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
    renderPanels();
    el.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
    ev.preventDefault();
  };

  const onMq = () => renderPanels();

  return {
    title: `${card.no}R ${card.name}`,
    render(root) {
      el = root;
      void store.requestProbs(card);
      draw();
      el.addEventListener('click', onClick);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
      el.addEventListener('keydown', onKey);
      wideMq.addEventListener('change', onMq);
      if (statusOf(card) === 'finished') {
        ensureResult();
        playback!.seek(playback!.duration);
        playback!.paused = true;
        $(el, '[data-controls]').innerHTML = controlsHtml();
      }
      raf = requestAnimationFrame(frame);
    },
    update(reason) {
      const st = statusOf(card);
      if (st !== lastStatus) {
        // 発走・確定などの状態遷移
        if (st !== 'open') ensureResult();
        if (st === 'finished' && playback) {
          playback.seek(playback.duration);
          playback.paused = true;
          tab = 'result';
        }
        if (st === 'running' && tab === 'card') tab = 'feed';
        lastStatus = st;
        return renderPanels();
      }
      if (reason === 'state' || reason === 'probs') return renderPanels();
      // tick: 時刻表示とオッズ（10秒ごと）
      const timing = el.querySelector('[data-timing]');
      if (timing) timing.innerHTML = timingText(card);
      const rt = runtimeOf(card);
      const key = `${Math.floor((Math.min(store.now(), rt.closesAt) - rt.openedAt) / 10000)}:${rt.closedAt ?? ''}`;
      if (key !== lastOddsKey) {
        lastOddsKey = key;
        refreshOdds();
      }
      if (st === 'finished' && playback && !playback.paused) {
        const seek = el.querySelector<HTMLInputElement>('[data-seek]');
        if (seek && document.activeElement !== seek) seek.value = playback.time.toFixed(1);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      resizeObs.disconnect();
      viewer?.dispose();
      wideMq.removeEventListener('change', onMq);
    },
  };
}

