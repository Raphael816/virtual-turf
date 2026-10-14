/**
 * three.js による3D観戦ビューア（RaceViewer の実装）。
 * 画質は 自動/低/中/高。自動では端末の種類で初期値を決め、FPS が低ければ段階的に下げる。
 * WebGL のコンテキストを失った場合は onFail を呼び、呼び出し側で2D表示に切り替える。
 */
import * as THREE from 'three';
import type { RaceCard } from '../../core/meeting';
import type { SimResult } from '../../core/sim';
import { COURSES, type Course, pointAt, raceU } from '../../core/track';
import { GATE_COLORS, HORSE_BY_ID } from '../../data/roster';
import type { CameraMode, HorseFrame, RaceViewer } from '../types';
import { CameraDirector } from './camera';
import { DustSystem, RainSystem } from './effects';
import { Environment } from './environment';
import { HorseGeometry, HorseModel, silksFor } from './horse';

export type Quality = 'auto' | 'low' | 'medium' | 'high';
type Level = 'low' | 'medium' | 'high';

const PROFILES: Record<Level, { pixelRatio: number; antialias: boolean; shadows: boolean; crowd: number; trees: number; dust: number; rain: number; emit: number }> = {
  low: { pixelRatio: 1, antialias: false, shadows: false, crowd: 1500, trees: 160, dust: 600, rain: 700, emit: 0.5 },
  medium: { pixelRatio: 1.5, antialias: true, shadows: true, crowd: 4000, trees: 360, dust: 1600, rain: 1400, emit: 1 },
  high: { pixelRatio: 2, antialias: true, shadows: true, crowd: 8000, trees: 650, dust: 3000, rain: 2200, emit: 1.6 },
};

export interface Viewer3DOptions {
  quality: Quality;
  reducedMotion: boolean;
  onFail: (reason: string) => void;
  /** 自動画質で画質を下げたときの通知 */
  onQualityChange?: (level: string) => void;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export class Viewer3D implements RaceViewer {
  readonly kind = '3d' as const;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 16 / 9, 1.0, 6000);
  private director = new CameraDirector(this.camera);
  private env!: Environment;
  private dust!: DustSystem;
  private rain!: RainSystem;
  private geo = new HorseGeometry();
  private horses: HorseModel[] = [];
  private gate: THREE.Group | null = null;
  private container: HTMLElement | null = null;
  private card: RaceCard | null = null;
  private course: Course = COURSES.turf;
  private level: Level;
  private pixelRatio: number;
  private emitScale: number;
  private lastTime = 0;
  private lastWall = 0;
  private followIndex = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private downgrades = 0;
  private failed = false;
  private dustColor = new THREE.Color();
  private tmp = new THREE.Color();

  constructor(private opts: Viewer3DOptions) {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.level = opts.quality === 'auto' ? (coarse ? 'low' : 'medium') : opts.quality;
    const p = PROFILES[this.level];
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, p.pixelRatio);
    this.emitScale = p.emit;
    this.director.reducedMotion = opts.reducedMotion;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    const p = PROFILES[this.level];
    this.renderer = new THREE.WebGLRenderer({ antialias: p.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    const canvas = this.renderer.domElement;
    canvas.className = 'viewer-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3Dのレース映像。順位と残り距離は画面上の表示と実況タブでも確認できます');
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.fail('WebGL のコンテキストが失われました');
    });
    container.appendChild(canvas);

    this.env = new Environment(this.scene, { crowd: p.crowd, trees: p.trees, shadows: p.shadows });
    this.dust = new DustSystem(p.dust);
    this.rain = new RainSystem(p.rain);
    this.scene.add(this.dust.points, this.rain.lines);
    this.resize();
  }

  private fail(reason: string) {
    if (this.failed) return;
    this.failed = true;
    this.opts.onFail(reason);
  }

  setRace(card: RaceCard, _result: SimResult | null): void {
    if (this.card?.id === card.id && this.horses.length) return;
    this.card = card;
    const c = card.conditions;
    this.course = COURSES[c.surface];
    this.horses.forEach((h) => {
      this.scene.remove(h.root);
      h.dispose();
    });
    const shadows = PROFILES[this.level].shadows;
    this.horses = card.entries.map((e) => {
      const horse = HORSE_BY_ID.get(e.horseId)!;
      const m = new HorseModel(this.geo, {
        coat: horse.color,
        ...silksFor(horse.id),
        cap: GATE_COLORS[(e.frame - 1) % 8].bg,
        number: e.number,
        shadows,
      });
      this.scene.add(m.root);
      return m;
    });
    this.env.applyConditions(c.weather, c.timeOfDay, c.going, [`${card.no}R ${card.name}`, `${c.surface === 'turf' ? '芝' : 'ダート'} ${c.distance}m`]);
    this.rain.setIntensity(c.weather === 'rain' ? 2 : c.weather === 'drizzle' ? 1 : 0);
    const wet = c.going === 'soft' || c.going === 'heavy';
    this.dustColor.set(c.surface === 'dirt' ? (wet ? '#6e5a48' : '#b8936a') : '#6d8a4c');
    this.buildGate(card);
    this.dust.clear();
    this.lastTime = 0;
  }

  /** 発馬機（スタート地点に設置） */
  private buildGate(card: RaceCard) {
    if (this.gate) {
      this.scene.remove(this.gate);
      this.gate.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const g = new THREE.Group();
    const green = new THREE.MeshStandardMaterial({ color: '#2f6b4a', roughness: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.6 });
    const n = card.entries.length;
    const width = n * 1.05 + 0.6;
    for (let k = 0; k <= n; k++) {
      const div = new THREE.Mesh(new THREE.BoxGeometry(2.8, 2.0, 0.08), k % 2 ? white : green);
      div.position.set(-0.2, 1.4, 0.075 + k * 1.05);
      g.add(div);
    }
    for (const x of [1.15, -1.55]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, width), green);
      beam.position.set(x, 2.55, width / 2);
      g.add(beam);
    }
    for (const z of [-0.3, width + 0.1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(2.8, 2.7, 0.3), green);
      leg.position.set(-0.2, 1.35, z);
      g.add(leg);
    }
    const D = card.conditions.distance;
    const u0 = raceU(this.course, D, 0);
    const p = pointAt(this.course, u0, 0);
    g.position.set(p.x, 0, p.z);
    g.rotation.y = -p.heading;
    this.gate = g;
    this.scene.add(g);
  }

  setCamera(mode: CameraMode, followIndex?: number): void {
    this.director.mode = mode;
    this.followIndex = followIndex ?? this.followIndex;
  }

  setQuality(q: Quality) {
    const level: Level = q === 'auto' ? this.level : q;
    const p = PROFILES[level];
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, p.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows;
    this.env.setShadows(p.shadows);
    this.emitScale = p.emit;
    this.opts.quality = q;
    this.resize();
  }

  resize(): void {
    if (!this.container || !this.renderer) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dust.setViewportHeight(h * this.pixelRatio);
  }

  render(time: number, frames: HorseFrame[]): void {
    if (this.failed || !this.card) return;
    const wall = performance.now();
    const dtWall = this.lastWall ? Math.min(0.1, (wall - this.lastWall) / 1000) : 0.016;
    this.lastWall = wall;
    let dtRace = time - this.lastTime;
    if (dtRace < 0 || dtRace > 1) {
      this.dust.clear(); // シーク時
      dtRace = 0;
    }
    this.lastTime = time;

    const D = this.card.conditions.distance;
    const course = this.course;
    const dirt = course.surface === 'dirt';
    const inputs: Parameters<CameraDirector['update']>[1]['horses'] = [];
    frames.forEach((f, i) => {
      const m = this.horses[i];
      if (!m) return;
      const p = pointAt(course, raceU(course, D, f.x), f.lane);
      m.place(p.x, p.z, p.heading);
      m.animate(f.v, dtRace);
      m.setHighlight(this.director.mode === 'follow' && i === this.followIndex);
      inputs.push({ x: f.x, lane: f.lane, wx: p.x, wz: p.z, heading: p.heading, rank: f.rank, finished: f.finished });

      // 蹄で巻き上がる砂・芝
      if (dtRace > 0 && f.v > 4) {
        const rate = (dirt ? 45 : 14) * this.emitScale * Math.min(1, f.v / 15);
        let count = Math.floor(rate * dtRace + Math.random());
        const fx = Math.cos(p.heading);
        const fz = Math.sin(p.heading);
        while (count-- > 0) {
          const side = (Math.random() - 0.5) * 0.6;
          this.tmp.copy(this.dustColor).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
          this.dust.emit(
            p.x - fx * 1.0 - fz * side,
            0.15,
            p.z - fz * 1.0 + fx * side,
            -fx * f.v * 0.12 + (Math.random() - 0.5) * 1.5,
            dirt ? 0.8 + Math.random() * 1.6 : 0.6 + Math.random() * 1.0,
            -fz * f.v * 0.12 + (Math.random() - 0.5) * 1.5,
            dirt ? 1.2 + Math.random() * 0.8 : 0.6 + Math.random() * 0.4,
            dirt ? 0.9 : 0.35,
            this.tmp,
          );
        }
      }
    });

    this.director.update(dtWall, {
      time,
      horses: inputs,
      followIndex: this.followIndex,
      course,
      distance: D,
      started: time > 0,
    });
    this.env.focusShadow(this.director.focus.x, this.director.focus.z);
    this.dust.update(dtRace > 0 ? dtWall : 0);
    this.rain.update(dtWall, this.camera.position);

    try {
      this.renderer.render(this.scene, this.camera);
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.monitorFps(wall);
  }

  /** 自動画質：3秒間の平均が 30fps を下回ったら段階的に下げる */
  private monitorFps(wall: number) {
    if (this.opts.quality !== 'auto') return;
    if (!this.fpsStart) this.fpsStart = wall;
    this.fpsFrames++;
    const span = wall - this.fpsStart;
    if (span < 3000) return;
    const fps = (this.fpsFrames * 1000) / span;
    this.fpsFrames = 0;
    this.fpsStart = wall;
    if (fps >= 30 || this.downgrades >= 3) return;
    this.downgrades++;
    if (this.downgrades === 1) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio * 0.75);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    } else if (this.downgrades === 2) {
      this.renderer.shadowMap.enabled = false;
      this.env.setShadows(false);
    } else {
      this.emitScale *= 0.4;
    }
    this.opts.onQualityChange?.(`自動調整 ${this.downgrades}/3`);
  }

  dispose(): void {
    // forceContextLoss が webglcontextlost を発火させるため、先に失敗扱いにして2Dへの切替を防ぐ
    this.failed = true;
    this.horses.forEach((h) => h.dispose());
    this.geo.dispose();
    this.dust?.dispose();
    this.rain?.dispose();
    this.env?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.container = null;
  }
}
