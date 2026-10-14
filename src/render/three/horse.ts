/**
 * プロシージャルに組み立てた競走馬（胴・首・頭・脚4本×2関節・尾）と騎手。
 * ギャロップ（回転襲歩）の位相で脚を動かし、速度に応じて歩幅・体の上下動を変える。
 * 馬の正面は +x 方向。
 */
import * as THREE from 'three';
import { numberTexture } from './textures';

/** 全馬で共有するジオメトリ（メモリとドローコールの節約） */
export class HorseGeometry {
  body = new THREE.SphereGeometry(1, 16, 12);
  neck = new THREE.CylinderGeometry(0.2, 0.32, 1.0, 10).translate(0, 0.5, 0);
  head = new THREE.BoxGeometry(0.62, 0.26, 0.26).translate(0.28, 0, 0);
  ear = new THREE.ConeGeometry(0.05, 0.14, 4).translate(0, 0.07, 0);
  upperLeg = new THREE.CylinderGeometry(0.11, 0.08, 0.62, 7).translate(0, -0.31, 0);
  lowerLeg = new THREE.CylinderGeometry(0.065, 0.055, 0.5, 6).translate(0, -0.25, 0);
  hoof = new THREE.CylinderGeometry(0.07, 0.085, 0.09, 6).translate(0, -0.045, 0);
  tail = new THREE.ConeGeometry(0.1, 0.9, 6).translate(0, -0.45, 0);
  cloth = new THREE.BoxGeometry(0.72, 0.5, 0.86);
  torso = new THREE.BoxGeometry(0.55, 0.34, 0.38);
  helmet = new THREE.SphereGeometry(0.15, 10, 8);
  thigh = new THREE.BoxGeometry(0.42, 0.14, 0.14).translate(0.21, 0, 0);
  arm = new THREE.BoxGeometry(0.36, 0.1, 0.1).translate(0.18, 0, 0);
  marker = new THREE.ConeGeometry(0.35, 0.7, 4).rotateX(Math.PI);

  dispose() {
    Object.values(this).forEach((g) => g instanceof THREE.BufferGeometry && g.dispose());
  }
}

interface Leg {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  /** 1完歩の中での着地タイミング（0〜1） */
  offset: number;
  fore: boolean;
}

// 回転襲歩の着地順：左後 → 右後 → 左前 → 右前
const LEG_LAYOUT: { x: number; z: number; offset: number; fore: boolean }[] = [
  { x: -0.72, z: -0.24, offset: 0.0, fore: false },
  { x: -0.72, z: 0.24, offset: 0.12, fore: false },
  { x: 0.78, z: -0.24, offset: 0.42, fore: true },
  { x: 0.78, z: 0.24, offset: 0.54, fore: true },
];

export class HorseModel {
  readonly root = new THREE.Group();
  private bodyGroup = new THREE.Group();
  private neckPivot = new THREE.Group();
  private jockey = new THREE.Group();
  private tailPivot = new THREE.Group();
  private legs: Leg[] = [];
  private marker: THREE.Mesh;
  private phase = Math.random() * Math.PI * 2;
  private materials: THREE.Material[] = [];

  constructor(geo: HorseGeometry, opts: { coat: string; silk: string; silk2: string; cap: string; number: number; shadows: boolean }) {
    const coat = new THREE.MeshStandardMaterial({ color: opts.coat, roughness: 0.55, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: '#1a1410', roughness: 0.7 });
    const silk = new THREE.MeshStandardMaterial({ color: opts.silk, roughness: 0.5 });
    const silk2 = new THREE.MeshStandardMaterial({ color: opts.silk2, roughness: 0.5 });
    const cap = new THREE.MeshStandardMaterial({ color: opts.cap, roughness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.8 });
    const numTex = numberTexture(opts.number);
    const numMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: '#efefea', roughness: 0.7 });
    this.materials = [coat, dark, silk, silk2, cap, white, numMat, pants];

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[]) => {
      const x = new THREE.Mesh(g, m);
      x.castShadow = opts.shadows;
      return x;
    };

    this.root.add(this.bodyGroup);

    // 胴
    const body = mesh(geo.body, coat);
    body.scale.set(1.15, 0.5, 0.4);
    body.position.y = 1.32;
    this.bodyGroup.add(body);

    // 首と頭
    this.neckPivot.position.set(0.95, 1.5, 0);
    this.neckPivot.rotation.z = -0.95; // 前方へ傾ける
    const neck = mesh(geo.neck, coat);
    this.neckPivot.add(neck);
    const head = mesh(geo.head, coat);
    head.position.set(0, 1.0, 0);
    head.rotation.z = -0.55;
    const earL = mesh(geo.ear, coat);
    earL.position.set(0.02, 0.14, -0.07);
    const earR = earL.clone();
    earR.position.z = 0.07;
    head.add(earL, earR);
    this.neckPivot.add(head);
    this.bodyGroup.add(this.neckPivot);

    // 尾
    this.tailPivot.position.set(-1.1, 1.45, 0);
    this.tailPivot.rotation.z = -0.6;
    this.tailPivot.add(mesh(geo.tail, dark));
    this.bodyGroup.add(this.tailPivot);

    // 脚
    for (const l of LEG_LAYOUT) {
      const upper = new THREE.Group();
      upper.position.set(l.x, 1.2, l.z);
      upper.add(mesh(geo.upperLeg, coat));
      const lower = new THREE.Group();
      lower.position.y = -0.62;
      lower.add(mesh(geo.lowerLeg, coat));
      const hoof = mesh(geo.hoof, dark);
      hoof.position.y = -0.5;
      lower.add(hoof);
      upper.add(lower);
      this.bodyGroup.add(upper);
      this.legs.push({ upper, lower, offset: l.offset, fore: l.fore });
    }

    // ゼッケン（左右の面に馬番）
    const cloth = mesh(geo.cloth, [white, white, white, white, numMat, numMat]);
    cloth.position.set(-0.05, 1.6, 0); // 大半は胴に埋まり、脇腹と背にだけ見える
    this.bodyGroup.add(cloth);

    // 騎手（前傾姿勢）
    this.jockey.position.set(0.05, 2.0, 0);
    const torso = mesh(geo.torso, silk);
    torso.rotation.z = -0.35;
    torso.position.set(0.05, 0.12, 0);
    const sleeveL = mesh(geo.arm, silk2);
    sleeveL.position.set(0.15, 0.18, -0.2);
    sleeveL.rotation.z = -0.6;
    const sleeveR = sleeveL.clone();
    sleeveR.position.z = 0.2;
    const helmet = mesh(geo.helmet, cap);
    helmet.position.set(0.36, 0.32, 0);
    const thighL = mesh(geo.thigh, pants);
    thighL.position.set(-0.15, -0.02, -0.2);
    thighL.rotation.z = -0.5;
    const thighR = thighL.clone();
    thighR.position.z = 0.2;
    this.jockey.add(torso, sleeveL, sleeveR, helmet, thighL, thighR);
    this.bodyGroup.add(this.jockey);

    // 注目馬のマーカー
    this.marker = new THREE.Mesh(geo.marker, new THREE.MeshBasicMaterial({ color: '#ffd166' }));
    this.marker.position.set(0, 3.4, 0);
    this.marker.visible = false;
    this.root.add(this.marker);
  }

  setHighlight(on: boolean) {
    this.marker.visible = on;
  }

  /** 位置と向きを設定する。heading は進行方向（+x から +z へのラジアン） */
  place(x: number, z: number, heading: number) {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = -heading;
  }

  /**
   * 脚の動きを更新する。dt はレース時間の経過（一時停止中は 0）。
   * @param v 速度 (m/s)
   */
  animate(v: number, dt: number) {
    const s = Math.min(1.15, v / 16);
    // 歩幅は速度とともに伸びる（最大約7m）
    const stride = 2.5 + 4.5 * Math.min(1, v / 16);
    if (dt > 0) this.phase += (v / stride) * Math.PI * 2 * dt;
    const amp = 0.62 * Math.min(1, v / 9);

    for (const leg of this.legs) {
      const a = this.phase + leg.offset * Math.PI * 2;
      leg.upper.rotation.z = amp * Math.sin(a) + (leg.fore ? 0 : 0.08 * s);
      const fold = Math.max(0, Math.sin(a + (leg.fore ? 1.3 : -1.0))) * 1.25 * Math.min(1, v / 8);
      leg.lower.rotation.z = leg.fore ? -fold : fold * 0.8;
    }
    // 体の上下動・前後の揺れ、首の振り、騎手の重心
    this.bodyGroup.position.y = Math.abs(Math.sin(this.phase)) * 0.09 * s;
    this.bodyGroup.rotation.z = Math.sin(this.phase * 2 + 0.6) * 0.035 * s;
    this.neckPivot.rotation.z = -0.95 - Math.sin(this.phase * 2) * 0.12 * s;
    this.jockey.position.y = 2.0 - Math.abs(Math.sin(this.phase)) * 0.06 * s;
    this.tailPivot.rotation.z = -0.6 - 0.5 * s + Math.sin(this.phase * 2) * 0.1;
    // 停止時は立ち姿勢
    if (v < 0.3) {
      for (const leg of this.legs) {
        leg.upper.rotation.z = 0;
        leg.lower.rotation.z = 0;
      }
      this.bodyGroup.position.y = 0;
    }
  }

  dispose() {
    for (const m of this.materials) {
      const tex = (m as THREE.MeshStandardMaterial).map;
      tex?.dispose();
      m.dispose();
    }
    (this.marker.material as THREE.Material).dispose();
  }
}

/** 馬ごとの勝負服の色（架空の馬主の配色。馬IDから決定） */
export function silksFor(horseId: string): { silk: string; silk2: string } {
  const palette = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457', '#37474f', '#f5f5f5', '#4e342e', '#283593'];
  let h = 0;
  for (const ch of horseId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = palette[h % palette.length];
  let b = palette[(h >>> 4) % palette.length];
  if (b === a) b = palette[(h + 5) % palette.length];
  return { silk: a, silk2: b };
}
