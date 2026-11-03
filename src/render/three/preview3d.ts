/**
 * 馬モデルのプレビュー：基準モデル（または個体差をつけた馬）を、スタジオの照明で正面・側面・斜め前・斜め後ろから確認する。
 * 馬はその場で走り（ルームランナーのように地面の目盛りが流れる）、蹄が滑っていないかも分かる。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Detail } from './horse/mesh';
import { RaceHorse } from './horse/racehorse';
import type { HorseSpec } from './horse/spec';

export type PreviewView = 'side' | 'front' | 'frontq' | 'rearq' | 'head' | 'legs';

const VIEWS: Record<PreviewView, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  side: { pos: [0.2, 1.3, 8.5], look: [0.2, 1.05, 0], fov: 30 },
  front: { pos: [7, 1.6, 0.3], look: [0, 1.1, 0], fov: 26 },
  frontq: { pos: [5, 1.9, 5], look: [0.1, 1.1, 0], fov: 28 },
  rearq: { pos: [-5, 2.1, 4.8], look: [0, 1.1, 0], fov: 28 },
  head: { pos: [2.6, 1.9, 2.2], look: [1.35, 1.65, 0], fov: 24 },
  legs: { pos: [0.2, 0.55, 4.6], look: [0.05, 0.5, 0], fov: 28 },
};

export class HorsePreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
  private sun = new THREE.DirectionalLight('#fff3e0', 2.4);
  private rim = new THREE.DirectionalLight('#cfe0ff', 1.5);
  private grid: THREE.Group;
  private horse: RaceHorse | null = null;
  private raf = 0;
  private last = 0;
  private x = 0;
  private token = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  speed = 16;
  view: PreviewView = 'side';
  jockey = true;

  constructor(
    private container: HTMLElement,
    private detail: Detail,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.className = 'viewer-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '競走馬の3Dモデルのプレビュー');
    container.appendChild(canvas);
    this.scene.background = new THREE.Color('#16181b');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
    this.scene.add(this.sun, this.sun.target, this.rim, this.rim.target);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 1 }));
    ground.receiveShadow = true;
    this.scene.add(ground);
    // 1m ごとの目盛り（走る速さで流れる。蹄が目盛りに対して止まって見えれば滑っていない）
    this.grid = new THREE.Group();
    const lineMat = new THREE.MeshBasicMaterial({ color: '#3d4046' });
    for (let i = -12; i <= 12; i++) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 4).rotateX(-Math.PI / 2), lineMat);
      l.position.set(i, 0.003, 0);
      this.grid.add(l);
    }
    this.scene.add(this.grid);
    this.resize();
  }

  async setSpec(spec: HorseSpec): Promise<void> {
    const t = ++this.token;
    const h = await RaceHorse.create(spec, this.detail, { shadows: true, physical: this.detail !== 'low' });
    if (t !== this.token) return h.dispose();
    if (this.horse) {
      this.scene.remove(this.horse.root);
      this.horse.dispose();
    }
    this.horse = h;
    h.setJockeyVisible(this.jockey);
    this.scene.add(h.root);
  }

  setJockey(on: boolean) {
    this.jockey = on;
    this.horse?.setJockeyVisible(on);
  }

  start() {
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
      this.last = now;
      this.renderFrame(dt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** 1フレーム進める（テスト用に外からも呼べる） */
  renderFrame(dt: number) {
    // 馬はその場で走らせ、地面の目盛りを後ろへ流す
    this.x += this.speed * dt;
    this.grid.position.x = -(this.x % 1);
    this.horse?.update(0, 0, 0, 0, 0, this.speed, dt, this.speed > 14 ? 0.6 : 0);
    const v = VIEWS[this.view];
    this.camPos.lerp(new THREE.Vector3(...v.pos), dt > 0 ? Math.min(1, dt * 4) : 1);
    this.camLook.lerp(new THREE.Vector3(...v.look), dt > 0 ? Math.min(1, dt * 4) : 1);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (this.camera.fov !== v.fov) {
      this.camera.fov += (v.fov - this.camera.fov) * (dt > 0 ? Math.min(1, dt * 4) : 1);
      this.camera.updateProjectionMatrix();
    }
    this.sun.position.set(4, 7, 6);
    this.rim.position.set(-6, 4, -5);
    this.rim.target.position.set(0, 1, 0);
    this.renderer.render(this.scene, this.camera);
  }

  snapView(view: PreviewView) {
    this.view = view;
    const v = VIEWS[view];
    this.camPos.set(...v.pos);
    this.camLook.set(...v.look);
    this.camera.fov = v.fov;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.token++;
    cancelAnimationFrame(this.raf);
    this.horse?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
