/**
 * アプリ全体の状態ストア。
 * - 状態の保存と購読
 * - 1秒ごとの進行処理（締切・確定）
 * - 確率推定のキャッシュ（Web Worker で計算）
 * - 表示設定（画質・2D/3D など）
 */
import { type RaceCard, createMeeting } from '../core/meeting';
import { type Probabilities, estimateProbabilities } from '../core/probability';
import { MAX_CATCH_UP, MEETING_SPAN_MS, NEXT_MEETING_DELAY_MS, advance, openMeeting, runUnwatchedMeeting } from '../core/raceflow';
import { advanceWeek } from '../core/world';
import { ENGINE_VERSION } from '../core/sim';
import { type AppState, createInitialState, refundRaces } from '../core/state';
import { type KV, clearState, defaultKV, loadState, saveState } from '../core/storage';
import { prefersReducedMotion } from './util';

export type Quality = 'auto' | 'low' | 'medium' | 'high';
export interface Prefs {
  quality: Quality;
  viewer: '3d' | '2d';
  reducedMotion: boolean;
  /** 観戦時の再生速度（リプレイ用） */
  speed: number;
}

const PREFS_KEY = 'virtual-turf:prefs';
type Listener = (reason: 'state' | 'tick' | 'probs') => void;

class Store {
  state!: AppState;
  prefs: Prefs;
  readonly kv: KV;
  private listeners = new Set<Listener>();
  private probs = new Map<string, Probabilities>();
  private pending = new Map<string, Promise<Probabilities>>();
  private worker: Worker | null = null;
  private workerWaiters = new Map<string, (p: Probabilities) => void>();
  private busy = false;
  readonly sessionStart = Date.now();
  lastReminder: number | null = null;
  /** 起動時にエンジン更新で開催を作り直したか（お知らせ表示用） */
  engineMigrated = false;

  constructor() {
    this.kv = defaultKV();
    this.prefs = { quality: 'auto', viewer: '3d', reducedMotion: prefersReducedMotion(), speed: 1 };
    try {
      const raw = this.kv.getItem(PREFS_KEY);
      if (raw) this.prefs = { ...this.prefs, ...JSON.parse(raw) };
    } catch {
      /* 既定値を使う */
    }
  }

  now(): number {
    return Date.now();
  }

  async init(): Promise<void> {
    this.state = loadState(this.kv) ?? (await createInitialState(this.now()));
    // シミュレーションのエンジンが更新された場合、保存済みの開催は同じ結果で再現できないため、
    // 未確定の券を返還して新しい開催にする
    const m = this.state.meeting;
    if (m && m.cards.some((c) => c.engineVersion !== ENGINE_VERSION)) {
      this.state = await refundRaces(this.state, m.cards.map((c) => c.id), this.now(), `engine ${m.cards[0].engineVersion} → ${ENGINE_VERSION}`);
      this.state = { ...this.state, meeting: undefined };
      this.engineMigrated = true;
    }
    // 締切・確定の時刻を過ぎたレースを処理する（ここでは次の開催日を自動で始めない）
    await this.tick(false);
    // 画面を閉じていた間の開催日を、結果だけ計算して進める（ゲーム内の時間は現実の時刻で進む）
    const last = this.lastFinishedAt();
    if (last !== null) {
      const missed = Math.min(MAX_CATCH_UP, Math.floor((this.now() - last) / MEETING_SPAN_MS));
      let w = this.state.world;
      for (let i = 0; i < missed; i++) w = await runUnwatchedMeeting(w, `U${w.date.year}-${w.date.week + 1}-${i}`);
      if (missed > 0) this.state = { ...this.state, world: w, meeting: undefined };
    }
    if (!this.state.meeting) await this.newMeeting(false);
    await this.tick();
    this.save();
    setInterval(() => void this.tick(), 1000);
    // 現在の開催の確率を順に裏で計算しておく
    for (const c of this.state.meeting!.cards) void this.requestProbs(c);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(reason: 'state' | 'tick' | 'probs') {
    this.listeners.forEach((fn) => fn(reason));
  }

  save() {
    saveState(this.kv, this.state);
  }

  set(next: AppState) {
    this.state = next;
    this.save();
    this.emit('state');
  }

  setPrefs(patch: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...patch };
    try {
      this.kv.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* noop */
    }
    this.emit('state');
  }

  /** 開催日のすべてのレースが確定した時刻（未確定があれば null） */
  lastFinishedAt(): number | null {
    const m = this.state.meeting;
    if (!m) return null;
    let last = 0;
    for (const c of m.cards) {
      const f = m.runtime[c.id].finishedAt;
      if (f === undefined) return null;
      last = Math.max(last, f);
    }
    return last;
  }

  /** 新しい開催日を始める（ゲーム内の暦を1週進める） */
  async newMeeting(emit = true) {
    const id = `M${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(this.now() / 1000) % 100000}`;
    const world = advanceWeek(this.state.world);
    const cards = await createMeeting(id, undefined, world);
    const next = await openMeeting({ ...this.state, world }, id, cards, this.now());
    this.state = next;
    this.save();
    for (const c of cards) void this.requestProbs(c);
    if (emit) this.emit('state');
  }

  private async tick(autoNext = true) {
    if (this.busy || !this.state) return;
    this.busy = true;
    try {
      const next = await advance(this.state, this.now(), (c) => this.probsSync(c));
      if (next !== this.state) this.set(next);
      else this.emit('tick');
      // すべて確定して少し経ったら、次の開催日（翌週）を自動で始める
      const last = this.lastFinishedAt();
      if (autoNext && last !== null && this.now() - last > NEXT_MEETING_DELAY_MS) await this.newMeeting();
    } finally {
      this.busy = false;
    }
  }

  // ---- 確率推定 ----
  getProbs(raceId: string): Probabilities | undefined {
    return this.probs.get(raceId);
  }

  /** 締切処理などで今すぐ必要な場合はメインスレッドで計算する */
  probsSync(card: RaceCard): Probabilities {
    let p = this.probs.get(card.id);
    if (!p) {
      p = estimateProbabilities(card);
      this.probs.set(card.id, p);
    }
    return p;
  }

  requestProbs(card: RaceCard): Promise<Probabilities> {
    const have = this.probs.get(card.id);
    if (have) return Promise.resolve(have);
    const pend = this.pending.get(card.id);
    if (pend) return pend;
    const promise = new Promise<Probabilities>((resolve) => {
      const done = (p: Probabilities) => {
        this.probs.set(card.id, p);
        this.pending.delete(card.id);
        resolve(p);
        this.emit('probs');
      };
      const w = this.getWorker();
      if (w) {
        this.workerWaiters.set(card.id, done);
        w.postMessage({ card: { id: card.id, conditions: card.conditions, entries: card.entries } });
      } else {
        setTimeout(() => done(estimateProbabilities(card)), 0);
      }
    });
    this.pending.set(card.id, promise);
    return promise;
  }

  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('../core/prob.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<{ raceId: string; probs: Probabilities }>) => {
        this.workerWaiters.get(ev.data.raceId)?.(ev.data.probs);
        this.workerWaiters.delete(ev.data.raceId);
      };
      return this.worker;
    } catch {
      return null;
    }
  }

  /** 端末内のデータをすべて消去して最初からやり直す（休止・自己排除中は不可） */
  async reset() {
    clearState(this.kv);
    this.probs.clear();
    this.state = await createInitialState(this.now());
    await this.newMeeting(false);
    this.save();
    this.emit('state');
  }
}

export const store = new Store();
