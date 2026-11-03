/**
 * 馬モデルのプレビュー：基準モデルと、同じ制作基準で個体差をつけた例を、複数の角度から確認する画面。
 */
import { HORSE_ROLLOUT } from '../../render/three/horse/rollout';
import { type HorseSpec, REFERENCE_HORSE, specFromLook } from '../../render/three/horse/spec';
import type { HorsePreview, PreviewView } from '../../render/three/preview3d';
import type { Page } from '../common';
import { store } from '../store';
import { esc } from '../util';

const VIEW_LABEL: [PreviewView, string][] = [
  ['side', '側面'],
  ['front', '正面'],
  ['frontq', '斜め前'],
  ['rearq', '斜め後ろ'],
  ['head', '頭部'],
  ['legs', '脚元'],
];
const SPEEDS: [number, string][] = [
  [0, '停止'],
  [9, 'キャンター'],
  [16.5, '全速'],
];
const BUILD_LABEL = { lean: '細身', standard: '標準', muscular: '筋肉質' } as const;
const FACE_LABEL = { none: 'なし', star: '星', stripe: '流星', blaze: '大流星' } as const;

/** 個体差の例（基準と同じ制作基準。毛色・体型・模様・走り方が異なる） */
const EXAMPLES: HorseSpec[] = [
  REFERENCE_HORSE,
  { ...specFromLook({ id: 'example-chestnut', name: '例：栗毛', coat: '栗毛', coatColor: '#a5582a', number: 3, capColor: '#d92b2b' }), name: '個体差の例（栗毛）' },
  { ...specFromLook({ id: 'example-grey', name: '例：芦毛', coat: '芦毛', coatColor: '#b9b4ab', number: 5, capColor: '#2463d1' }), name: '個体差の例（芦毛）' },
  { ...specFromLook({ id: 'example-darkbay', name: '例：黒鹿毛', coat: '黒鹿毛', coatColor: '#3a2416', number: 9, capColor: '#f2cc1f' }), name: '個体差の例（黒鹿毛）' },
];

export function previewPage(): Page {
  let preview: HorsePreview | null = null;
  let el: HTMLElement;
  let specIndex = 0;
  let view: PreviewView = 'side';
  let speed = 16.5;
  let jockey = true;
  const ro = new ResizeObserver(() => preview?.resize());

  const specInfo = (s: HorseSpec) => `
    <dl class="quote" style="margin:0">
      <dt>馬名（仮）</dt><dd>${esc(s.name)}</dd>
      <dt>毛色</dt><dd>${esc(s.coat.name)}</dd>
      <dt>体型</dt><dd>${BUILD_LABEL[s.build.type]}（体長×${s.build.length.toFixed(2)}・体高×${s.build.height.toFixed(2)}）</dd>
      <dt>顔の白斑・靴下</dt><dd>${FACE_LABEL[s.markings.face]}・${s.markings.socks.filter((x) => x > 0).length}本</dd>
      <dt>走り方</dt><dd>ピッチ×${s.gait.freqScale.toFixed(2)}・${s.gait.lead === 'right' ? '右' : '左'}手前・脚の上げ×${s.gait.lift.toFixed(2)}</dd>
    </dl>`;

  const controls = () => `
    <div class="stage-controls">
      <div class="seg" role="group" aria-label="角度">${VIEW_LABEL.map(([v, l]) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${l}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="速さ">${SPEEDS.map(([v, l]) => `<button type="button" data-speed="${v}" aria-pressed="${v === speed}">${l}</button>`).join('')}</div>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-jockey ${jockey ? 'checked' : ''}> 騎手を表示</label>
    </div>
    <div class="stage-controls">
      <label class="sr-only" for="spec-sel">馬</label>
      <select id="spec-sel" data-spec style="width:auto;min-height:36px">${EXAMPLES.map((s, i) => `<option value="${i}" ${i === specIndex ? 'selected' : ''}>${esc(s.name)}${i === 0 ? '（基準モデル）' : ''}</option>`).join('')}</select>
    </div>`;

  const mount = async () => {
    const stage = el.querySelector<HTMLElement>('[data-stage]')!;
    const status = el.querySelector<HTMLElement>('[data-status]')!;
    try {
      const v3d = await import('../../render/three/viewer3d');
      if (!v3d.webglAvailable()) throw new Error('webgl');
      const mod = await import('../../render/three/preview3d');
      const q = store.prefs.quality;
      const detail = q === 'low' ? 'low' : q === 'medium' ? 'medium' : 'high';
      preview = new mod.HorsePreview(stage, detail);
      preview.speed = speed;
      preview.snapView(view);
      status.textContent = 'モデルを生成しています…';
      await preview.setSpec(EXAMPLES[specIndex]);
      status.textContent = '';
      status.hidden = true;
      preview.start();
      ro.observe(stage);
    } catch (e) {
      console.warn(e);
      status.hidden = false;
      status.textContent = 'この端末では3D表示を利用できないため、プレビューを表示できません。';
    }
  };

  const draw = () => {
    el.innerHTML = `
      <h1>馬モデルのプレビュー</h1>
      <p class="muted">品質の基準として作り込んだ1頭（仮の馬名）を、複数の角度から確認できます。地面の目盛り（1m間隔）は走る速さで流れ、蹄が目盛りに対して止まっていれば滑っていません。</p>
      <div class="stage" data-stage style="background:#16181b"><div class="ov ov-tl"><div class="ov-box" data-status aria-live="polite">モデルを生成しています…</div></div></div>
      <div data-controls>${controls()}</div>
      <section class="card" style="margin-top:12px" aria-labelledby="spec-h"><h2 id="spec-h">この馬の仕様</h2><div data-info>${specInfo(EXAMPLES[specIndex])}</div></section>
      <section class="card" style="margin-top:12px"><h2>制作基準と展開</h2>
        <ul>
          <li>骨格・リグ・走行アニメーション・メッシュの品質は全馬で共通です。毛色・模様・体格・走り方・馬具だけを馬ごとに変えます。</li>
          <li>馬体は骨と筋肉の塊をなめらかにつないだ1枚の変形するメッシュで、外部の3Dモデル・写真・モーションデータは使っていません（権利の確認が不要な手続き的な生成）。</li>
          <li>レース映像では、現在は<b>${HORSE_ROLLOUT === 'all' ? '全頭' : '注目馬1頭'}</b>をこのモデルで表示しています（基準モデルの品質確認が終わるまでは全頭には展開しません）。</li>
        </ul>
      </section>`;
    void mount();
  };

  const onClick = async (ev: Event) => {
    const t = ev.target as HTMLElement;
    const v = t.closest<HTMLElement>('[data-view]');
    if (v) {
      view = v.dataset.view as PreviewView;
      if (preview) preview.view = view;
    }
    const s = t.closest<HTMLElement>('[data-speed]');
    if (s) {
      speed = Number(s.dataset.speed);
      if (preview) preview.speed = speed;
    }
    if (v || s) el.querySelector('[data-controls]')!.innerHTML = controls();
  };
  const onChange = async (ev: Event) => {
    const t = ev.target as HTMLInputElement;
    if (t.matches('[data-jockey]')) {
      jockey = t.checked;
      preview?.setJockey(jockey);
    }
    if (t.matches('[data-spec]')) {
      specIndex = Number(t.value);
      el.querySelector('[data-info]')!.innerHTML = specInfo(EXAMPLES[specIndex]);
      const status = el.querySelector<HTMLElement>('[data-status]')!;
      status.hidden = false;
      status.textContent = 'モデルを生成しています…';
      await preview?.setSpec(EXAMPLES[specIndex]);
      status.textContent = '';
      status.hidden = true;
    }
  };

  return {
    title: '馬モデルのプレビュー',
    render(root) {
      el = root;
      draw();
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
    },
    dispose() {
      ro.disconnect();
      preview?.dispose();
      preview = null;
    },
  };
}
