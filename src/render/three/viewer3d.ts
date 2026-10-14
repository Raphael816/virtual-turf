/**
 * three.js による3D観戦ビューア（RaceViewer の実装）。
 *
 * 画質：
 * - 低（軽量）：影なし（接地影のみ）・簡略モデル・ポストプロセスなし。スマートフォン向け
 * - 中：影あり・標準モデル
 * - 高：高解像度の影・詳細モデル・毛並みの光沢・モーションブラー・被写界深度
 * - 自動：タッチ端末は低、それ以外は中から開始し、FPS が低ければ段階的に下げる
 *
 * 映像は走行ログを再生するだけで、結果には影響しない。馬同士が重なって見えないよう、
 * 表示上だけ横方向にわずかに離す（シミュレーションの位置は変えない）。
 */
import * as THREE from 'three';
import type { RaceCard } from '../../core/meeting';
import type { SimResult } from '../../core/sim';
import { COURSES, type Course, pointAt, raceU } from '../../core/track';
import { GATE_COLORS, HORSE_BY_ID } from '../../data/roster';
import type { CameraMode, HorseFrame, RaceViewer } from '../types';
import { CameraDirector, type DirectorHorse } from './camera';
import { ClodSystem, DustSystem, HoofPrints, RainSystem } from './effects';
import { Environment } from './environment';
import { type Detail, HorseModel } from './horseModel';
import { PostFX } from './post';

export type Quality = 'auto' | 'low' | 'medium' | 'high';
type Level = 'low' | 'medium' | 'high';

interface Profile {
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowSize: number;
  crowd: number;
  trees: number;
  detail: Detail;
  dust: number;
  clods: number;
  prints: number;
  rain: number;
  post: boolean;
  physical: boolean;
}

const PROFILES: Record<Level, Profile> = {
  low: { pixelRatio: 1, antialias: false, shadows: false, shadowSize: 0, crowd: 1800, trees: 160, detail: 'low', dust: 400, clods: 120, prints: 200, rain: 600, post: false, physical: false },
  medium: { pixelRatio: 1.5, antialias: true, shadows: true, shadowSize: 2048, crowd: 6000, trees: 330, detail: 'medium', dust: 1200, clods: 300, prints: 500, rain: 1200, post: false, physical: false },
  high: { pixelRatio: 2, antialias: false, shadows: true, shadowSize: 4096, crowd: 14000, trees: 600, detail: 'high', dust: 2500, clods: 600, prints: 900, rain: 2000, post: true, physical: true },
};

export interface Viewer3DOptions {
  quality: Quality;
  reducedMotion: boolean;
  onFail: (reason: string) => void;
  onQualityChange?: (label: string) => void;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

export class Viewer3D implements RaceViewer {
  readonly kind = '3d' as const;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 1.0, 6000);
  private director = new CameraDirector(this.camera);
  private env!: Environment;
  private dust!: DustSystem;
  private clods!: ClodSystem;
  private prints!: HoofPrints;
  private rain!: RainSystem;
  private post: PostFX | null = null;
  private horses: HorseModel[] = [];
  private lateral: number[] = [];
  private gate: THREE.Group | null = null;
  private container: HTMLElement | null = null;
  private card: RaceCard | null = null;
  private course: Course = COURSES.turf;
  private level: Level;
  private profile: Profile;
  private pixelRatio: number;
  private emitScale = 1;
  private lastTime = 0;
  private lastWall = 0;
  private followIndex = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private downgrades = 0;
  private failed = false;
  private wet = false;
  private dustColor = new THREE.Color();
  private clodColor = new THREE.Color();
  private tmp = new THREE.Color();
  private lastShot = '';
  private width = 1;
  private height = 1;

  /** 開発時の確認用：カメラの状態 */
  debugInfo() {
    const c = this.camera;
    return { shot: this.director.shot, fov: c.fov, pos: c.position.toArray().map((v) => Math.round(v)), focus: this.director.focus.toArray().map((v) => Math.round(v)), radius: this.director.subjectRadius, focusDistance: Math.round(this.director.focusDistance) };
  }

  constructor(private opts: Viewer3DOptions) {
    if (import.meta.env.DEV) (window as unknown as { __viewer3d: Viewer3D }).__viewer3d = this;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.level = opts.quality === 'auto' ? (coarse ? 'low' : 'medium') : opts.quality;
    this.profile = PROFILES[this.level];
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio);
    this.director.reducedMotion = opts.reducedMotion;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    const p = this.profile;
    this.renderer = new THREE.WebGLRenderer({ antialias: p.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.AgXToneMapping;
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

    this.env = new Environment(this.scene, this.renderer, { level: this.level, crowd: p.crowd, trees: p.trees, shadows: p.shadows, shadowSize: p.shadowSize });
    this.dust = new DustSystem(p.dust);
    this.clods = new ClodSystem(p.clods);
    this.prints = new HoofPrints(p.prints);
    this.rain = new RainSystem(p.rain);
    this.scene.add(this.dust.points, this.clods.mesh, this.prints.mesh, this.rain.lines);
    this.resize();
    if (p.post) {
      try {
        this.post = new PostFX(this.renderer, this.scene, this.camera, this.width, this.height);
      } catch (e) {
        console.warn('post-processing disabled', e);
        this.post = null;
      }
    }
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
    this.horses = card.entries.map((e) => {
      const horse = HORSE_BY_ID.get(e.horseId)!;
      const m = new HorseModel(
        { id: horse.id, coat: horse.coat, coatColor: horse.color, number: e.number, capColor: GATE_COLORS[(e.frame - 1) % 8].bg },
        this.profile.detail,
        { shadows: this.profile.shadows, physical: this.profile.physical },
      );
      this.scene.add(m.root);
      return m;
    });
    this.lateral = card.entries.map(() => 0);
    this.env.applyConditions(c.weather, c.timeOfDay, c.going, [`${card.no}R ${card.name}`, `${c.surface === 'turf' ? '芝' : 'ダート'} ${c.distance}m`]);
    this.rain.setIntensity(c.weather === 'rain' ? 2 : c.weather === 'drizzle' ? 1 : 0);
    this.wet = c.going === 'soft' || c.going === 'heavy';
    if (c.surface === 'dirt') {
      this.dustColor.set(this.wet ? '#5e4c3c' : c.going === 'yielding' ? '#9c8064' : '#c4a27c');
      this.clodColor.set(this.wet ? '#3e3024' : '#7a5e43');
    } else {
      this.dustColor.set('#8a8a6a');
      this.clodColor.set('#4b5f33');
    }
    const s = this.env.sun;
    const light = s.color.clone().multiplyScalar(Math.min(1.15, 0.35 + s.intensity * 0.22));
    this.dust.setLight(c.timeOfDay === 'night' ? light.multiplyScalar(0.8) : light);
    this.buildGate(card);
    this.dust.clear();
    this.clods.clear();
    this.prints.clear();
    this.lastTime = 0;
  }

  /** 発馬機（スタート地点） */
  private buildGate(card: RaceCard) {
    if (this.gate) {
      this.scene.remove(this.gate);
      this.gate.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const g = new THREE.Group();
    const green = new THREE.MeshStandardMaterial({ color: '#2f5f45', roughness: 0.5, metalness: 0.2 });
    const white = new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.5 });
    const n = card.entries.length;
    const width = n * 1.05 + 0.6;
    for (let k = 0; k <= n; k++) {
      const div = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.2, 0.06), k % 2 ? white : green);
      div.position.set(-0.2, 1.5, 0.075 + k * 1.05);
      g.add(div);
    }
    for (const x of [1.25, -1.65]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, width), green);
      beam.position.set(x, 2.75, width / 2);
      g.add(beam);
    }
    const tyre = new THREE.MeshStandardMaterial({ color: '#202020', roughness: 0.8 });
    for (const z of [-0.3, width + 0.1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.9, 0.3), green);
      leg.position.set(-0.2, 1.45, z);
      g.add(leg);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 16).rotateX(Math.PI / 2), tyre);
      wheel.position.set(-0.2, 0.4, z + (z < 0 ? -0.25 : 0.25));
      g.add(wheel);
    }
    g.traverse((o) => ((o as THREE.Mesh).castShadow = this.profile.shadows));
    const u0 = raceU(this.course, card.conditions.distance, 0);
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
    this.renderer.shadowMap.enabled = p.shadows && this.profile.shadows;
    this.env.setShadows(p.shadows);
    this.emitScale = level === 'low' ? 0.5 : 1;
    if (!p.post && this.post) {
      this.post.dispose();
      this.post = null;
    } else if (p.post && !this.post) {
      try {
        this.post = new PostFX(this.renderer, this.scene, this.camera, this.width, this.height);
      } catch {
        this.post = null;
      }
    }
    this.opts.quality = q;
    this.resize();
  }

  resize(): void {
    if (!this.container || !this.renderer) return;
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = `${this.width}px`;
    this.renderer.domElement.style.height = `${this.height}px`;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.dust.setViewportHeight(this.height * this.pixelRatio);
    this.post?.setSize(this.width, this.height);
  }

  /** 表示上の重なりを防ぐ横方向のずらし（ゆっくり変化させる） */
  private separate(frames: HorseFrame[], dt: number) {
    const n = frames.length;
    const target = new Array<number>(n).fill(0);
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = Math.abs(frames[i].x - frames[j].x);
          if (dx > 2.7) continue;
          const li = frames[i].lane + target[i];
          const lj = frames[j].lane + target[j];
          const dl = lj - li;
          const need = 0.95 - Math.abs(dl);
          if (need > 0) {
            const s = dl >= 0 ? 1 : -1;
            const w = (1 - dx / 2.7) * need * 0.5;
            target[i] -= s * w;
            target[j] += s * w;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const t = Math.max(-0.7, Math.min(0.7, target[i]));
      this.lateral[i] += (t - this.lateral[i]) * Math.min(1, dt * 3);
      // 内ラチより内側には出さない
      if (frames[i].lane + this.lateral[i] < 0.45) this.lateral[i] = 0.45 - frames[i].lane;
    }
  }

  render(time: number, frames: HorseFrame[]): void {
    if (this.failed || !this.card) return;
    const wall = performance.now();
    const dtWall = this.lastWall ? Math.min(0.1, (wall - this.lastWall) / 1000) : 0.016;
    this.lastWall = wall;
    let dtRace = time - this.lastTime;
    if (dtRace < 0 || dtRace > 1) {
      // シーク：演出をリセット
      this.dust.clear();
      this.clods.clear();
      this.prints.clear();
      this.post?.resetHistory();
      dtRace = 0;
    }
    this.lastTime = time;

    const D = this.card.conditions.distance;
    const course = this.course;
    const dirt = course.surface === 'dirt';
    const leadX = Math.max(...frames.map((f) => f.x));
    const rem = D - leadX;
    this.separate(frames, dtRace > 0 ? dtRace : 0);

    const inputs: DirectorHorse[] = [];
    frames.forEach((f, i) => {
      const m = this.horses[i];
      if (!m) return;
      const lane = f.lane + this.lateral[i];
      const p = pointAt(course, raceU(course, D, f.x), lane);
      const drive = f.finished ? 0 : Math.max(0, Math.min(1, (420 - (D - f.x)) / 200));
      const landings = m.update(p.x, p.z, p.heading, f.v, dtRace, drive);
      m.setHighlight(this.director.mode === 'follow' && i === this.followIndex);
      inputs.push({ x: f.x, lane, wx: p.x, wz: p.z, heading: p.heading, rank: f.rank, finished: f.finished, v: f.v });
      if (dtRace > 0 && landings.length) this.groundFx(landings, p.heading, f.v, dirt);
    });

    // 発馬機は発走後に撤去する（実際の中継と同じく、カメラカーの視界を遮らない）
    if (this.gate) this.gate.visible = time < 4;
    this.director.update({ time, dt: dtRace, horses: inputs, followIndex: this.followIndex, course, distance: D, started: time > 0, aspect: this.width / this.height });
    if (this.director.shot !== this.lastShot) {
      this.post?.resetHistory();
      this.lastShot = this.director.shot;
    }
    this.env.focusShadow(this.director.focus.x, this.director.focus.z, this.director.subjectRadius * 1.5 + 10);
    this.env.update(wall / 1000, rem < 300 && rem > -60 ? 1 : 0.15);
    const fxDt = dtRace > 0 ? dtWall : 0;
    this.dust.update(fxDt);
    this.clods.update(fxDt);
    this.prints.update(fxDt);
    // 雨はカメラと被写体の中間に降らせる（望遠でも画面全体に細かく見えるように）
    this.rain.update(dtWall, this.camera.position.clone().lerp(this.director.focus, 0.6));

    try {
      if (this.post) this.post.render(dtWall, this.director.focusDistance);
      else this.renderer.render(this.scene, this.camera);
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.monitorFps(wall);
  }

  /** 蹄の着地に合わせて、砂煙・土くれ（芝の塊）・蹄跡を出す */
  private groundFx(landings: { x: number; z: number; fore: boolean }[], heading: number, v: number, dirt: boolean) {
    const fx = Math.cos(heading);
    const fz = Math.sin(heading);
    const k = this.emitScale * Math.min(1, v / 15);
    for (const l of landings) {
      this.prints.add(l.x, l.z, heading, dirt ? 1 : 0.55);
      if (dirt) {
        const puffs = Math.round((this.wet ? 1 : 3) * k + Math.random());
        for (let q = 0; q < puffs; q++) {
          this.tmp.copy(this.dustColor).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
          this.dust.emit(
            l.x - fx * 0.3 + (Math.random() - 0.5) * 0.3,
            0.2,
            l.z - fz * 0.3 + (Math.random() - 0.5) * 0.3,
            -fx * v * 0.18 + (Math.random() - 0.5) * 1.2,
            0.6 + Math.random() * 1.2,
            -fz * v * 0.18 + (Math.random() - 0.5) * 1.2,
            this.wet ? 0.6 : 1.4 + Math.random() * 1.0,
            this.wet ? 0.35 : 0.8 + Math.random() * 0.5,
            this.tmp,
          );
        }
      }
      const chunks = Math.round((dirt ? (this.wet ? 3 : 1) : l.fore ? 1 : 2) * k + Math.random() * 0.6);
      for (let q = 0; q < chunks; q++) {
        this.tmp.copy(this.clodColor).offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
        this.clods.emit(l.x, l.z, -fx * (2 + Math.random() * 3) + (Math.random() - 0.5), 1.5 + Math.random() * 2.5, -fz * (2 + Math.random() * 3) + (Math.random() - 0.5), this.tmp);
      }
    }
  }

  /** 自動画質：3秒平均が 30fps を下回ったら段階的に下げる（レースは最後まで表示を続ける） */
  private monitorFps(wall: number) {
    if (this.opts.quality !== 'auto') return;
    if (!this.fpsStart) this.fpsStart = wall;
    this.fpsFrames++;
    const span = wall - this.fpsStart;
    if (span < 3000) return;
    const fps = (this.fpsFrames * 1000) / span;
    this.fpsFrames = 0;
    this.fpsStart = wall;
    if (fps >= 30 || this.downgrades >= 4) return;
    this.downgrades++;
    if (this.post) {
      this.post.dispose();
      this.post = null;
    } else if (this.downgrades <= 2) {
      this.pixelRatio = Math.max(0.6, this.pixelRatio * 0.75);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    } else if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.env.setShadows(false);
    } else {
      this.emitScale *= 0.4;
    }
    this.opts.onQualityChange?.(`自動調整 ${this.downgrades}/4`);
  }

  dispose(): void {
    // forceContextLoss が webglcontextlost を発火させるため、先に失敗扱いにして2Dへの切替を防ぐ
    this.failed = true;
    this.horses.forEach((h) => h.dispose());
    this.post?.dispose();
    this.dust?.dispose();
    this.clods?.dispose();
    this.prints?.dispose();
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
