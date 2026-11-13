/**
 * 2D 上空図（3D が使えない環境、または利用者が選んだ場合の代替表示）。
 * Canvas にコース全体と各馬の位置を描く。
 */
import type { RaceCard } from '../core/meeting';
import { type Course, type CourseId, courseBounds, courseFor, pointAt, raceU, venueCourses } from '../core/track';
import { DEFAULT_VENUE, type VenueId } from '../data/venues';
import { GATE_COLORS } from '../data/roster';
import type { CameraMode, HorseFrame, RaceViewer } from './types';

export class Viewer2D implements RaceViewer {
  readonly kind = '2d' as const;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private card: RaceCard | null = null;
  private venue: VenueId = DEFAULT_VENUE;
  private courses: Record<CourseId, Course> = venueCourses(DEFAULT_VENUE);
  private course: Course = this.courses.turf;
  private bounds = courseBounds(DEFAULT_VENUE);
  private container: HTMLElement | null = null;
  private baseScale = 1;
  private scale = 1;
  private dpr = 1;
  private follow = -1;
  private mode: CameraMode = 'overview';
  private center = { x: 0, z: 0 };
  private get mid() {
    const b = this.bounds;
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  }

  mount(container: HTMLElement): void {
    this.container = container;
    this.canvas.className = 'viewer-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'コースの上空図。各馬の位置を表示しています');
    container.appendChild(this.canvas);
    this.resize();
  }

  setRace(card: RaceCard): void {
    this.card = card;
    const v = card.conditions.venue ?? DEFAULT_VENUE;
    if (v !== this.venue) {
      this.venue = v;
      this.courses = venueCourses(v);
      this.bounds = courseBounds(v);
      this.resize();
    }
    this.course = courseFor(card.conditions.surface, card.conditions.layout, v);
  }

  /** 全景以外のカメラでは、先頭（または注目馬）を中心に拡大する */
  setCamera(mode: CameraMode, followIndex?: number): void {
    this.mode = mode;
    this.follow = followIndex ?? -1;
  }

  resize(): void {
    if (!this.container) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // 全コースの外ラチまで収まるように縮尺を決める（スタンドの分も少し余白を取る）
    const halfW = (this.bounds.maxX - this.bounds.minX) / 2 + 20;
    const halfH = (this.bounds.maxZ - this.bounds.minZ) / 2 + 30;
    this.baseScale = Math.min(this.canvas.width / (2 * halfW), this.canvas.height / (2 * halfH));
    this.scale = this.baseScale;
  }

  private toScreen(x: number, z: number): [number, number] {
    return [
      this.canvas.width / 2 + (x - this.center.x) * this.scale,
      this.canvas.height / 2 + (z - this.center.z) * this.scale,
    ];
  }

  private band(course: Course, color: string, from = 0, to = course.circumference) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = course.width * this.scale;
    ctx.beginPath();
    const closed = from === 0 && to >= course.circumference;
    for (let u = from; u <= to; u += 8) {
      const p = pointAt(course, u, course.width / 2);
      const [sx, sy] = this.toScreen(p.x, p.z);
      if (u === from) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  render(_time: number, horses: HorseFrame[]): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const active = this.course;
    const D = this.card?.conditions.distance ?? 1600;

    // カメラ：全景は固定、それ以外は対象を中心に3.5倍
    if (this.mode === 'overview' || horses.length === 0) {
      this.scale = this.baseScale;
      this.center = { ...this.mid };
    } else {
      const target =
        horses.find((h) => h.index === this.follow && this.mode === 'follow') ??
        horses.reduce((a, b) => (b.rank < a.rank ? b : a));
      const p = pointAt(active, raceU(active, D, target.x), target.lane);
      const k = 0.12; // 追従の滑らかさ
      this.center = { x: this.center.x + (p.x - this.center.x) * k, z: this.center.z + (p.z - this.center.z) * k };
      this.scale = this.baseScale * 3.5;
    }

    ctx.fillStyle = '#16301f';
    ctx.fillRect(0, 0, width, height);
    const on = (c: Course) => c.id === active.id;
    const cs = this.courses;
    if (cs.turfOuter !== cs.turf) this.band(cs.turfOuter, on(cs.turfOuter) ? '#4f9f5f' : '#2f6b3c');
    this.band(cs.turf, on(cs.turf) || on(cs.turfOuter) ? '#3f8f4f' : '#2f6b3c');
    this.band(cs.dirt, on(cs.dirt) ? '#a07a52' : '#6b5640');

    // ゴール板
    const f0 = pointAt(active, active.finishU, 0);
    const f1 = pointAt(active, active.finishU, active.width);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, 2 * this.scale);
    ctx.beginPath();
    ctx.moveTo(...this.toScreen(f0.x, f0.z));
    ctx.lineTo(...this.toScreen(f1.x, f1.z));
    ctx.stroke();
    // スタート地点
    const s0 = pointAt(active, raceU(active, D, 0), 0);
    const s1 = pointAt(active, raceU(active, D, 0), active.width);
    ctx.strokeStyle = '#f2cc1f';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(...this.toScreen(s0.x, s0.z));
    ctx.lineTo(...this.toScreen(s1.x, s1.z));
    ctx.stroke();
    ctx.setLineDash([]);

    // スタンド（ホームストレッチ側）
    ctx.fillStyle = '#3a4a5a';
    const fin = pointAt(cs.turf, cs.turf.finishU, 0);
    const [gx, gy] = this.toScreen(fin.x + 40 * cs.turf.hand - 190, fin.z + cs.turf.width + 22);
    ctx.fillRect(gx, gy, 380 * this.scale, 14 * this.scale);

    // 馬（後ろの順位から描いて、先頭を上に重ねる）
    const r = Math.max(7 * this.dpr, 1.1 * this.scale);
    const sorted = [...horses].sort((a, b) => b.rank - a.rank);
    ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const h of sorted) {
      const p = pointAt(active, raceU(active, D, h.x), h.lane);
      const [sx, sy] = this.toScreen(p.x, p.z);
      const c = GATE_COLORS[(h.frame - 1) % 8];
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = c.bg;
      ctx.fill();
      ctx.lineWidth = h.index === this.follow ? 3 : 1.2;
      ctx.strokeStyle = h.index === this.follow ? '#ffd166' : '#0b1622';
      ctx.stroke();
      ctx.fillStyle = c.fg;
      ctx.fillText(String(h.number), sx, sy + 0.5);
    }
  }

  dispose(): void {
    this.canvas.remove();
    this.container = null;
  }
}
