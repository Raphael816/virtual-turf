/**
 * 写実寄りの競走馬モデル（プロシージャル生成）。外部モデル・テクスチャは使わない。
 *
 * - 胴・首・頭・脚は断面スイープ（loft.ts）で生成し、肩・トモの筋肉、胸、腹の形を断面の変化と凹凸で表す
 * - 毛色は頂点色（ノイズによるムラ、鹿毛の黒い脚先、芦毛の連銭、白斑）と毛並みの法線マップで表現する
 * - 脚は 前腕/下腿・管骨・繋（蹄）の3節。蹄の位置は歩様（gait.ts）で決め、2関節IKで関節角度を求める
 * - 体の上下動・前後の揺れ・首の振り・尾とたてがみの揺れは、完歩の位相に同期させる
 * - 歩幅・ピッチ・手前・頭の高さ・体格は馬ごとに少しずつ変える
 *
 * 座標系：馬の前方 +x、上 +y、右 +z。root の原点は胴の真下の地面。
 */
import * as THREE from 'three';
import { type GaitTraits, type LegSpec, footTarget, solveTwoBone, strideFrequency } from './gait';
import { type Section, loftGeometry, sec, sectionPoint, interpolateSections } from './loft';
import { fbm3, noise3, seededRandom } from './noise';

export type Detail = 'low' | 'medium' | 'high';

export interface HorseLook {
  id: string;
  coat: string; // 毛色名（鹿毛・栗毛など）
  coatColor: string;
  number: number;
  capColor: string;
}

/** 繋（球節 → 蹄冠）の長さと、蹄の高さ。着地中の繋の傾き（鉛直から） */
const PASTERN = 0.13;
const HOOF_H = 0.075;
const PASTERN_STANCE = 0.62;

/** 深さ s に応じて骨を割り当てる。boundaries の前後 widths の範囲で隣の骨と滑らかにブレンド */
function applySkin(g: THREE.BufferGeometry, coord: (p: THREE.Vector3) => number, boundaries: number[], widths: number[]) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    const sv = coord(p);
    let bone = 0;
    while (bone < boundaries.length && sv >= boundaries[bone]) bone++;
    let done = false;
    for (let k = 0; k < boundaries.length; k++) {
      const w = widths[k];
      if (Math.abs(sv - boundaries[k]) < w) {
        let t = (sv - (boundaries[k] - w)) / (2 * w);
        t = t * t * (3 - 2 * t);
        si.set([k, k + 1, 0, 0], i * 4);
        sw.set([1 - t, t, 0, 0], i * 4);
        done = true;
        break;
      }
    }
    if (!done) {
      si.set([bone, 0, 0, 0], i * 4);
      sw.set([1, 0, 0, 0], i * 4);
    }
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}

const DETAIL = {
  low: { radial: 10, subdiv: 2, legRadial: 7, legSubdiv: 1 },
  medium: { radial: 18, subdiv: 3, legRadial: 10, legSubdiv: 2 },
  high: { radial: 26, subdiv: 4, legRadial: 14, legSubdiv: 3 },
} as const;

// ---- 胴の断面（x: 尻端 −1.0 〜 胸前 +0.93） ----
// [x, 背の高さ, 腹の高さ, 半幅, 背側のすぼまり, 腹側のすぼまり]
const TORSO: [number, number, number, number, number, number][] = [
  [-1.0, 1.4, 1.2, 0.07, 0.2, 0.2],
  [-0.94, 1.5, 1.02, 0.17, 0.15, 0.3],
  [-0.85, 1.575, 0.93, 0.235, 0.12, 0.3],
  [-0.7, 1.61, 0.9, 0.262, 0.14, 0.25],
  [-0.52, 1.595, 0.9, 0.27, 0.18, 0.15],
  [-0.32, 1.56, 0.885, 0.275, 0.24, 0.08],
  [-0.08, 1.535, 0.86, 0.29, 0.28, 0.05],
  [0.16, 1.555, 0.85, 0.295, 0.32, 0.05],
  [0.38, 1.625, 0.87, 0.278, 0.42, 0.12],
  [0.56, 1.64, 0.93, 0.252, 0.45, 0.12],
  [0.7, 1.59, 0.99, 0.228, 0.4, 0.16],
  [0.82, 1.5, 1.05, 0.185, 0.32, 0.22],
  [0.92, 1.37, 1.11, 0.11, 0.26, 0.32],
];

function torsoKeys(): Section[] {
  return TORSO.map(([x, top, bot, w, tn, bn]) => sec(x, (top + bot) / 2, 0, (top - bot) / 2, (top - bot) / 2, w, { n: 2.3, topNarrow: tn, bottomNarrow: bn }));
}

const gauss = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));
/** 筋肉の膨らみ（肩・前腕の付け根・トモ）と腹のくびれ。塊に見えないよう広く浅くかける */
function torsoBump(p: THREE.Vector3, theta: number): number {
  const sideAngle = Math.abs(Math.cos(theta)) > 0 ? (Math.cos(theta) >= 0 ? theta : Math.PI - theta) : theta;
  return (
    0.014 * gauss(p.x - 0.58, 0.16) * gauss(sideAngle - 0.2, 0.8) + // 肩
    0.02 * gauss(p.x - 0.5, 0.1) * gauss(sideAngle + 0.8, 0.35) + // 上腕三頭筋
    0.022 * gauss(p.x + 0.6, 0.2) * gauss(sideAngle + 0.15, 0.8) + // トモ
    -0.02 * gauss(p.x + 0.3, 0.12) * gauss(sideAngle + 1.0, 0.35) // 腹のくびれ
  );
}

// ---- 毛色 ----
interface Palette {
  base: THREE.Color;
  points: THREE.Color; // 脚先・たてがみ・尾
  mane: THREE.Color;
  dapple: boolean;
  darkTop: number;
}

function paletteFor(coatName: string, coatColor: string, rnd: () => number): Palette {
  const base = new THREE.Color(coatColor).multiplyScalar(0.82);
  base.offsetHSL((rnd() - 0.5) * 0.02, -0.06 + (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.04);
  const black = new THREE.Color('#141110');
  switch (coatName) {
    case '栗毛':
    case '栃栗毛':
      return { base, points: base.clone().multiplyScalar(0.85), mane: base.clone().offsetHSL(0, -0.05, coatName === '栃栗毛' ? -0.1 : 0.06), dapple: false, darkTop: 0.06 };
    case '芦毛':
      return { base: new THREE.Color('#b9b6b0').offsetHSL(0, 0, (rnd() - 0.5) * 0.1), points: new THREE.Color('#4a4846'), mane: new THREE.Color('#8f8c88'), dapple: true, darkTop: 0 };
    case '青鹿毛':
      return { base, points: black, mane: black, dapple: false, darkTop: 0.08 };
    default: // 鹿毛・黒鹿毛：黒い脚先・たてがみ・尾
      return { base, points: black, mane: black, dapple: false, darkTop: 0.14 };
  }
}

function silksTexture(silk: string, silk2: string, pattern: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = silk;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = silk2;
  switch (pattern % 6) {
    case 1: // 輪（胴の周りの帯）
      for (let x = 20; x < 256; x += 56) g.fillRect(x, 0, 24, 128);
      break;
    case 2: // 縦縞
      for (let y = 0; y < 128; y += 22) g.fillRect(0, y, 256, 9);
      break;
    case 3: // 襷
      g.beginPath();
      g.moveTo(60, 0); g.lineTo(110, 0); g.lineTo(200, 128); g.lineTo(150, 128);
      g.fill();
      break;
    case 4: // 山形
      for (let x = 30; x < 256; x += 70) {
        g.beginPath();
        g.moveTo(x, 0); g.lineTo(x + 30, 64); g.lineTo(x, 128); g.lineTo(x + 16, 128); g.lineTo(x + 46, 64); g.lineTo(x + 16, 0);
        g.fill();
      }
      break;
    case 5: // 玉霰（水玉）
      for (let x = 16; x < 256; x += 34) for (let y = 12; y < 128; y += 30) { g.beginPath(); g.arc(x + (y % 60 ? 0 : 17), y, 7, 0, Math.PI * 2); g.fill(); }
      break;
    default:
      break;
  }
  // 布のしわ・陰影
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * 256, Math.random() * 128, 6, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** ゼッケン：右側・左側の両方に馬番（左側は面の向きに合わせて180°回転して描く） */
function clothTexture(n: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f3f2ee';
  g.fillRect(0, 0, 512, 256);
  // 縁取り
  g.fillStyle = '#1d2a38';
  g.fillRect(0, 0, 512, 8);
  g.fillRect(0, 248, 512, 8);
  g.font = 'bold 92px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#121212';
  // 右側（v が小さい側 = テクスチャ下半分）
  g.fillText(String(n), 256, 196);
  // 左側（テクスチャ上半分、180°回転）
  g.save();
  g.translate(256, 60);
  g.rotate(Math.PI);
  g.fillText(String(n), 0, 0);
  g.restore();
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * 512, Math.random() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 毛並みの法線マップ（体の長さ方向に流れる細い筋）。全馬で共有 */
let hairNormal: THREE.Texture | null = null;
function hairNormalMap(): THREE.Texture {
  if (hairNormal) return hairNormal;
  const W = 256;
  const H = 256;
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) h[y * W + x] = noise3(x * 0.05, y * 0.9, 0, 7) * 0.7 + noise3(x * 0.2, y * 2.5, 1, 9) * 0.3;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = h[y * W + ((x - 1 + W) % W)];
      const r = h[y * W + ((x + 1) % W)];
      const u = h[((y - 1 + H) % H) * W + x];
      const d = h[((y + 1) % H) * W + x];
      const nx = (l - r) * 2;
      const ny = (u - d) * 2;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const k = (y * W + x) * 4;
      img.data[k] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 3);
  hairNormal = t;
  return t;
}

/** たてがみ・尾の毛束テクスチャ（アルファ付き） */
let hairStrands: THREE.Texture | null = null;
function hairStrandTexture(): THREE.Texture {
  if (hairStrands) return hairStrands;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * 128;
    const len = 70 + Math.random() * 58;
    const a = 0.35 + Math.random() * 0.65;
    g.strokeStyle = `rgba(255,255,255,${a})`;
    g.lineWidth = 1 + Math.random() * 1.6;
    g.beginPath();
    g.moveTo(x, 0);
    g.quadraticCurveTo(x + (Math.random() - 0.5) * 10, len * 0.5, x + (Math.random() - 0.5) * 16, len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  hairStrands = t;
  return t;
}

let blobTex: THREE.Texture | null = null;
function blobShadowTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.9)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

interface LegRig {
  spec: LegSpec;
  az: number;
  bend: 1 | -1;
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  pastern: THREE.Object3D;
  prevStance: boolean;
}

export interface Landing {
  x: number;
  z: number;
  fore: boolean;
}

export class HorseModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private neckPivot = new THREE.Group();
  private headPivot = new THREE.Group();
  private jockey = new THREE.Group();
  private jockeyTorso = new THREE.Group();
  private arms: { upper: THREE.Group; fore: THREE.Group }[] = [];
  private tail: THREE.Group[] = [];
  private tailVel: number[] = [];
  private tailSway: number[] = [];
  private legs: LegRig[] = [];
  private reins: THREE.Mesh[] = [];
  private bitL = new THREE.Object3D();
  private bitR = new THREE.Object3D();
  private handL = new THREE.Object3D();
  private handR = new THREE.Object3D();
  private maneMat: THREE.MeshStandardMaterial;
  private maneUniforms = { uTime: { value: 0 }, uSpeed: { value: 0 } };
  private marker: THREE.Mesh;
  private blob: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private textures: THREE.Texture[] = [];
  readonly traits: GaitTraits;
  private phase: number;
  private headCarriage: number;
  private size: number;
  private prevHeading = 0;
  private roll = 0;
  private bobSmooth = 0;
  private landings: Landing[] = [];
  private time = 0;

  constructor(look: HorseLook, detail: Detail, opts: { shadows: boolean; physical: boolean }) {
    const rnd = seededRandom(`horse:${look.id}`);
    const d = DETAIL[detail];
    this.traits = {
      freqScale: 0.96 + rnd() * 0.08,
      dutyOffset: (rnd() - 0.5) * 0.04,
      lead: rnd() < 0.5 ? 'left' : 'right',
      lift: 0.88 + rnd() * 0.24,
    };
    this.phase = rnd();
    this.headCarriage = (rnd() - 0.5) * 0.12;
    this.size = 0.965 + rnd() * 0.07;
    const pal = paletteFor(look.coat, look.coatColor, rnd);
    const socks = [0, 1, 2, 3].map(() => (rnd() < 0.3 ? 0.1 + rnd() * 0.35 : 0));
    const blaze = rnd() < 0.4;

    // ---- マテリアル ----
    const coatParams = {
      vertexColors: true,
      roughness: 0.55,
      metalness: 0,
      normalMap: hairNormalMap(),
      normalScale: new THREE.Vector2(0.3, 0.3),
    };
    const coat = opts.physical
      ? new THREE.MeshPhysicalMaterial({ ...coatParams, sheen: 0.22, sheenRoughness: 0.5, sheenColor: new THREE.Color('#e6d9c4') })
      : new THREE.MeshStandardMaterial(coatParams);
    const dark = new THREE.MeshStandardMaterial({ color: '#141210', roughness: 0.6 });
    const eye = new THREE.MeshStandardMaterial({ color: '#0b0908', roughness: 0.08, metalness: 0.1 });
    const hoofDark = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.45 });
    const hoofLight = new THREE.MeshStandardMaterial({ color: '#bfae93', roughness: 0.5 });
    const leather = new THREE.MeshStandardMaterial({ color: '#2b1d14', roughness: 0.55, side: THREE.DoubleSide });
    const strap = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.6, side: THREE.DoubleSide });
    const clothTex = clothTexture(look.number);
    const cloth = new THREE.MeshStandardMaterial({ map: clothTex, roughness: 0.85, side: THREE.DoubleSide });
    this.maneMat = new THREE.MeshStandardMaterial({
      color: pal.mane,
      map: hairStrandTexture(),
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.7,
    });
    this.maneMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.maneUniforms.uTime;
      shader.uniforms.uSpeed = this.maneUniforms.uSpeed;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uSpeed;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float tip = uv.y;
           float w = sin(uTime * 11.0 + uv.x * 14.0) * 0.012 + sin(uTime * 23.0 + uv.x * 31.0) * 0.006;
           transformed.x -= tip * tip * (0.05 + 0.06 * uSpeed);
           transformed.y += tip * (w + 0.03 * uSpeed);
           transformed.z += tip * w * 1.5;`,
        );
    };
    const silkRnd = seededRandom(`silks:${look.id}`);
    const SILK = ['#b71c1c', '#0d47a1', '#1b5e20', '#f9a825', '#4a148c', '#e65100', '#006064', '#880e4f', '#263238', '#fafafa', '#3e2723', '#1a237e'];
    const silk = SILK[Math.floor(silkRnd() * SILK.length)];
    let silk2 = SILK[Math.floor(silkRnd() * SILK.length)];
    if (silk2 === silk) silk2 = SILK[(SILK.indexOf(silk) + 5) % SILK.length];
    const silkTex = silksTexture(silk, silk2, Math.floor(silkRnd() * 6));
    const silkMat = new THREE.MeshStandardMaterial({ map: silkTex, roughness: 0.42, metalness: 0.05 });
    const sleeveMat = new THREE.MeshStandardMaterial({ color: silk2, roughness: 0.45 });
    const capMat = new THREE.MeshStandardMaterial({ color: look.capColor, roughness: 0.35 });
    const breeches = new THREE.MeshStandardMaterial({ color: '#ecebe6', roughness: 0.7 });
    const boots = new THREE.MeshStandardMaterial({ color: '#0f0f10', roughness: 0.35 });
    const skin = new THREE.MeshStandardMaterial({ color: '#c99a7a', roughness: 0.6 });
    this.materials.push(coat, dark, eye, hoofDark, hoofLight, leather, strap, cloth, this.maneMat, silkMat, sleeveMat, capMat, breeches, boots, skin);
    this.textures.push(clothTex, silkTex);

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const x = new THREE.Mesh(g, m);
      x.castShadow = opts.shadows;
      x.receiveShadow = opts.shadows && detail === 'high';
      this.geometries.push(g);
      return x;
    };

    // 頂点色：ムラ・背の濃さ・連銭・白斑
    const tmp = new THREE.Color();
    const coatAt = (p: THREE.Vector3, extraDark = 0): THREE.Color => {
      const v = 0.9 + 0.2 * fbm3(p.x * 4, p.y * 4, p.z * 4, 3, 11);
      tmp.copy(pal.base).multiplyScalar(v);
      const topness = Math.max(0, Math.min(1, (p.y - 1.35) / 0.3));
      tmp.multiplyScalar(1 - pal.darkTop * topness - extraDark);
      if (pal.dapple) {
        const dn = noise3(p.x * 9, p.y * 9, p.z * 9, 5);
        if (dn > 0.62) tmp.lerp(new THREE.Color('#e8e6e2'), 0.4);
        else if (dn < 0.3) tmp.multiplyScalar(0.82);
      }
      return tmp;
    };

    this.root.add(this.body);
    this.root.scale.setScalar(this.size);

    // ---- 胴 ----
    const torsoK = torsoKeys();
    const torso = mesh(
      loftGeometry(torsoK, {
        radial: d.radial,
        subdiv: d.subdiv,
        capStart: true,
        capEnd: true,
        bump: (_t, theta, p) => torsoBump(p, theta),
        color: (p) => coatAt(p),
      }),
      coat,
    );
    this.body.add(torso);

    // ---- 首（付け根を中心に振る） ----
    const pivot = new THREE.Vector3(0.6, 1.42, 0);
    this.neckPivot.position.copy(pivot);
    const nk = (x: number, y: number, top: number, bot: number, side: number) =>
      sec(x - pivot.x, y - pivot.y, 0, top, bot, side, { n: 2.2, topNarrow: 0.35, bottomNarrow: 0.1 });
    const neckKeys = [
      nk(0.52, 1.3, 0.3, 0.36, 0.215),
      nk(0.72, 1.45, 0.23, 0.26, 0.165),
      nk(0.93, 1.6, 0.165, 0.175, 0.125),
      nk(1.14, 1.745, 0.125, 0.135, 0.095),
      nk(1.28, 1.82, 0.11, 0.12, 0.088),
    ];
    const neck = mesh(
      loftGeometry(neckKeys, { radial: d.radial, subdiv: d.subdiv, color: (p) => coatAt(p.clone().add(pivot)) }),
      coat,
    );
    this.neckPivot.add(neck);
    this.body.add(this.neckPivot);

    // たてがみ（首の稜線から右側に垂らす毛束）
    const crest = interpolateSections(neckKeys, 3);
    {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      crest.forEach((s, i) => {
        const t = i / (crest.length - 1);
        const a = crest[Math.max(0, i - 1)].c;
        const b = crest[Math.min(crest.length - 1, i + 1)].c;
        const tangent = b.clone().sub(a).normalize();
        const up = new THREE.Vector3(-tangent.y, tangent.x, 0);
        const root = s.c.clone().addScaledVector(up, s.top * 0.98);
        const len = 0.1 + 0.08 * Math.sin(t * Math.PI) + rnd() * 0.03;
        const tip = root.clone().addScaledVector(up, -len * 0.55).add(new THREE.Vector3(-0.02, 0, 0.07));
        pos.push(root.x, root.y, root.z + 0.01, tip.x, tip.y, tip.z);
        uv.push(t, 0, t, 1);
        if (i < crest.length - 1) {
          const k = i * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const mane = mesh(g, this.maneMat);
      mane.castShadow = false;
      this.neckPivot.add(mane);
    }

    // ---- 頭 ----
    this.headPivot.position.set(1.29 - pivot.x, 1.81 - pivot.y, 0);
    this.neckPivot.add(this.headPivot);
    const hk = [
      sec(-0.02, 0, 0, 0.1, 0.13, 0.095, { n: 2.2 }),
      sec(0.08, -0.005, 0, 0.115, 0.15, 0.1, { n: 2.2, bottomNarrow: 0.15 }),
      sec(0.22, 0.0, 0, 0.1, 0.11, 0.088, { n: 2.3 }),
      sec(0.38, 0.0, 0, 0.083, 0.085, 0.074, { n: 2.3 }),
      sec(0.52, -0.012, 0, 0.082, 0.09, 0.074, { n: 2.2 }),
    ];
    const head = mesh(
      loftGeometry(hk, {
        radial: d.radial,
        subdiv: d.subdiv,
        capStart: true,
        capEnd: true,
        color: (p) => {
          const c = coatAt(new THREE.Vector3(p.x + 1.3, p.y + 1.8, p.z), 0.04).clone();
          if (blaze && Math.abs(p.z) < 0.03 && p.y > 0.04) c.set('#efece6');
          return c;
        },
      }),
      coat,
    );
    this.headPivot.add(head);
    const earG = new THREE.ConeGeometry(0.032, 0.13, 6).translate(0, 0.065, 0);
    for (const s of [-1, 1]) {
      const ear = mesh(earG, coat);
      ear.position.set(0.0, 0.1, s * 0.05);
      ear.rotation.set(s * -0.25, 0, -0.35);
      this.headPivot.add(ear);
      const e = mesh(new THREE.SphereGeometry(0.021, 10, 8), eye);
      e.position.set(0.12, 0.045, s * 0.094);
      this.headPivot.add(e);
      const nostril = mesh(new THREE.SphereGeometry(0.018, 8, 6).scale(1.4, 0.8, 0.8), dark);
      nostril.position.set(0.545, 0.0, s * 0.04);
      this.headPivot.add(nostril);
    }
    // 頭絡（鼻革・項革）とハミ
    const nose = mesh(new THREE.TorusGeometry(0.088, 0.008, 6, 20).scale(1, 1.05, 0.9), strap);
    nose.position.set(0.4, -0.005, 0);
    nose.rotation.y = Math.PI / 2;
    const crown = mesh(new THREE.TorusGeometry(0.11, 0.008, 6, 20).scale(1, 1.25, 0.95), strap);
    crown.position.set(0.04, 0.0, 0);
    crown.rotation.set(0, Math.PI / 2, 0.25);
    this.headPivot.add(nose, crown);
    this.bitL.position.set(0.47, -0.06, -0.075);
    this.bitR.position.set(0.47, -0.06, 0.075);
    this.headPivot.add(this.bitL, this.bitR);
    if (detail !== 'low') {
      const forelock = mesh(
        new THREE.PlaneGeometry(0.1, 0.16).translate(0, -0.08, 0),
        this.maneMat,
      );
      forelock.position.set(0.02, 0.12, 0);
      forelock.rotation.set(0, Math.PI / 2, -0.5);
      forelock.castShadow = false;
      this.headPivot.add(forelock);
    }

    // ---- 脚（1本ずつ継ぎ目のないスキンメッシュ。上腕/下腿・管骨・繋の3本の骨で変形） ----
    const legSpecs: (LegSpec & { az: number; bend: 1 | -1 })[] = [
      { id: 'FL', fore: true, ax: 0.52, ay: 0.97, l1: 0.47, l2: 0.33, pastern: PASTERN, az: -0.125, bend: 1 },
      { id: 'FR', fore: true, ax: 0.52, ay: 0.97, l1: 0.47, l2: 0.33, pastern: PASTERN, az: 0.125, bend: 1 },
      { id: 'HL', fore: false, ax: -0.4, ay: 1.03, l1: 0.48, l2: 0.42, pastern: PASTERN, az: -0.19, bend: -1 },
      { id: 'HR', fore: false, ax: -0.4, ay: 1.03, l1: 0.48, l2: 0.42, pastern: PASTERN, az: 0.19, bend: -1 },
    ];
    // [付け根からの深さ(m, 負は体の中), 前側半径, 後側半径, 横半径]
    const FORE_PROFILE: [number, number, number, number][] = [
      [-0.1, 0.085, 0.085, 0.075], [0, 0.095, 0.09, 0.082], [0.18, 0.082, 0.072, 0.072], [0.36, 0.06, 0.052, 0.056],
      [0.47, 0.062, 0.056, 0.064], [0.52, 0.045, 0.045, 0.047], [0.62, 0.036, 0.045, 0.038], [0.76, 0.036, 0.046, 0.039],
      [0.8, 0.05, 0.056, 0.052], [0.84, 0.045, 0.048, 0.046], [0.9, 0.038, 0.04, 0.04], [0.93, 0.045, 0.045, 0.047],
    ];
    const HIND_PROFILE: [number, number, number, number][] = [
      [-0.3, 0.16, 0.16, 0.115], [-0.12, 0.16, 0.19, 0.125], [0.05, 0.12, 0.15, 0.1], [0.22, 0.085, 0.1, 0.075],
      [0.4, 0.055, 0.07, 0.055], [0.48, 0.055, 0.085, 0.06], [0.53, 0.045, 0.055, 0.047], [0.65, 0.037, 0.047, 0.04],
      [0.86, 0.037, 0.047, 0.04], [0.9, 0.05, 0.056, 0.052], [0.94, 0.045, 0.048, 0.046], [1.0, 0.038, 0.04, 0.04],
      [1.03, 0.045, 0.045, 0.047],
    ];
    const up = new THREE.Vector3(1, 0, 0);
    const pointColor = (k: number) => tmp.copy(pal.base).lerp(pal.points, k).clone();
    const hoofGeo = new THREE.CylinderGeometry(0.046, 0.064, HOOF_H, 14, 1);
    hoofGeo.translate(0, -HOOF_H / 2, 0);
    {
      // つま先側の壁を前に傾ける
      const hp = hoofGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < hp.count; i++) hp.setX(i, hp.getX(i) + (-hp.getY(i) / HOOF_H) * 0.02);
      hoofGeo.computeVertexNormals();
    }
    this.geometries.push(hoofGeo);
    legSpecs.forEach((s, i) => {
      const sock = socks[i];
      const white = new THREE.Color('#ece9e2');
      const profile = s.fore ? FORE_PROFILE : HIND_PROFILE;
      const total = s.l1 + s.l2 + s.pastern;
      const geo = loftGeometry(
        profile.map(([depth, front, back, side]) => sec(s.ax, s.ay - depth, s.az, front, back, side, { n: 2.1 })),
        {
          radial: d.legRadial,
          subdiv: d.legSubdiv + 1,
          capStart: false, // 付け根は胴の中に隠れるので丸めない（丸めると肩にこぶが出る）
          capEnd: false,
          up,
          color: (p) => {
            const depth = s.ay - p.y;
            const fromBottom = total - depth;
            if (sock > 0 && fromBottom < sock) return white;
            if (depth > s.l1 * 0.85) return pointColor(Math.min(1, (depth - s.l1 * 0.85) / 0.12));
            return coatAt(p);
          },
        },
      );
      // スキニング：深さに応じて骨を割り当て、関節の前後で滑らかにブレンドする
      applySkin(geo, (p) => s.ay - p.y, [s.l1, s.l1 + s.l2], [0.05, 0.03]);
      const b0 = new THREE.Bone();
      b0.position.set(s.ax, s.ay, s.az);
      const b1 = new THREE.Bone();
      b1.position.y = -s.l1;
      const b2 = new THREE.Bone();
      b2.position.y = -s.l2;
      b0.add(b1);
      b1.add(b2);
      this.body.add(b0);
      const legMesh = new THREE.SkinnedMesh(geo, coat);
      legMesh.castShadow = opts.shadows;
      legMesh.frustumCulled = false;
      this.geometries.push(geo);
      this.body.add(legMesh);
      this.root.updateMatrixWorld(true);
      legMesh.bind(new THREE.Skeleton([b0, b1, b2]), legMesh.matrixWorld);
      // 蹄（繋の先、着地中は底面が水平になる向き）
      const hoof = new THREE.Mesh(hoofGeo, sock > 0 ? hoofLight : hoofDark);
      hoof.castShadow = opts.shadows;
      hoof.position.y = -s.pastern;
      hoof.rotation.z = -PASTERN_STANCE;
      b2.add(hoof);
      this.legs.push({ spec: s, az: s.az, bend: s.bend, upper: b0, lower: b1, pastern: b2, prevStance: true });
    });

    // ---- 尾（付け根の肉 + 交差させた毛束のスキンメッシュ。4本の骨がばねで遅れて揺れる） ----
    const dock = mesh(
      loftGeometry([sec(-0.93, 1.47, 0, 0.055, 0.055, 0.05), sec(-1.1, 1.42, 0, 0.04, 0.04, 0.038)], {
        radial: 8,
        subdiv: 1,
        capEnd: true,
        color: () => coatAt(new THREE.Vector3(-1, 1.45, 0)),
      }),
      coat,
    );
    this.body.add(dock);
    {
      const L = 0.95;
      const rows = 14;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      // 縦の毛束と横の毛束を十字に組む（どの角度から見ても厚みが出る）
      for (const plane of [0, 1]) {
        const base = pos.length / 3;
        for (let r = 0; r <= rows; r++) {
          const t = r / rows;
          const x = -t * L;
          const w = plane === 0 ? 0.05 + 0.13 * Math.sin(Math.min(1, t * 1.3) * Math.PI * 0.5) : 0.04 + 0.1 * t;
          if (plane === 0) pos.push(x, w * 0.5, 0, x, -w * 0.5, 0);
          else pos.push(x, 0, w * 0.5, x, 0, -w * 0.5);
          uv.push(0, 1 - t, 1, 1 - t);
          if (r < rows) {
            const k = base + r * 2;
            idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const segLen = L / 4;
      applySkin(g, (p) => -p.x, [segLen, segLen * 2, segLen * 3], [0.08, 0.08, 0.08]);
      const bones: THREE.Bone[] = [];
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Bone();
        if (i === 0) b.position.set(-1.06, 1.43, 0);
        else b.position.x = -segLen;
        if (i > 0) bones[i - 1].add(b);
        bones.push(b);
      }
      // 尾の骨は胴の座標で作ったジオメトリに合わせる（付け根を原点にずらす）
      g.translate(-1.06, 1.43, 0);
      this.body.add(bones[0]);
      const tailMat = this.maneMat.clone();
      tailMat.onBeforeCompile = () => {};
      this.materials.push(tailMat);
      const tailMesh = new THREE.SkinnedMesh(g, tailMat);
      tailMesh.frustumCulled = false;
      tailMesh.castShadow = opts.shadows;
      this.geometries.push(g);
      this.body.add(tailMesh);
      this.root.updateMatrixWorld(true);
      tailMesh.bind(new THREE.Skeleton(bones), tailMesh.matrixWorld);
      bones.forEach((b) => {
        this.tail.push(b as unknown as THREE.Group);
        this.tailVel.push(0);
        this.tailSway.push(0);
      });
    }

    // ---- 鞍下ゼッケン・鞍・腹帯（胴の表面に沿わせる） ----
    const surface = interpolateSections(torsoK, 6);
    const patch = (x0: number, x1: number, th0: number, th1: number, offset: number, mat: THREE.Material, segs: number) => {
      const rows = surface.filter((s) => s.c.x >= x0 && s.c.x <= x1);
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      rows.forEach((s, i) => {
        for (let j = 0; j <= segs; j++) {
          const th = th0 + ((th1 - th0) * j) / segs;
          const [yy, zz] = sectionPoint(s, th);
          const p = new THREE.Vector3(s.c.x, s.c.y + yy, zz);
          const r = new THREE.Vector3(0, yy, zz);
          const extra = torsoBump(p, th) + offset;
          p.addScaledVector(r.normalize(), extra);
          pos.push(p.x, p.y, p.z);
          uv.push((s.c.x - x0) / (x1 - x0), j / segs);
          if (i < rows.length - 1 && j < segs) {
            const a = i * (segs + 1) + j;
            const b = a + segs + 1;
            idx.push(a, a + 1, b, b, a + 1, b + 1);
          }
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return mesh(g, mat);
    };
    this.body.add(patch(-0.3, 0.3, -0.35, Math.PI + 0.35, 0.014, cloth, 24));
    this.body.add(patch(-0.1, 0.22, Math.PI / 2 - 0.55, Math.PI / 2 + 0.55, 0.035, leather, 10));
    this.body.add(patch(0.38, 0.44, -Math.PI / 2, Math.PI * 1.5, 0.016, strap, 24));

    // ---- 騎手（短いあぶみで立って前傾） ----
    this.jockey.position.set(-0.02, 2.0, 0);
    this.jockey.scale.setScalar(0.93);
    this.body.add(this.jockey);
    this.jockey.add(this.jockeyTorso);
    const torsoJ = mesh(
      loftGeometry(
        [
          sec(-0.02, 0.0, 0, 0.11, 0.11, 0.15, { n: 2.4 }),
          sec(0.14, 0.04, 0, 0.1, 0.095, 0.14, { n: 2.4 }),
          sec(0.3, 0.1, 0, 0.12, 0.11, 0.18, { n: 2.4 }),
          sec(0.42, 0.14, 0, 0.09, 0.1, 0.19, { n: 2.4 }),
        ],
        { radial: d.legRadial, subdiv: d.legSubdiv, capStart: true, capEnd: true },
      ),
      silkMat,
    );
    this.jockeyTorso.add(torsoJ);
    const helmet = mesh(new THREE.SphereGeometry(0.105, 16, 12).scale(1.12, 0.92, 0.95), capMat);
    helmet.position.set(0.56, 0.24, 0);
    const peak = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.01, 12, 1, false, -Math.PI / 2, Math.PI).scale(1, 1, 1.4), capMat);
    peak.position.set(0.64, 0.19, 0);
    peak.rotation.z = -0.25;
    const face = mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
    face.position.set(0.6, 0.15, 0);
    const goggles = mesh(new THREE.TorusGeometry(0.09, 0.014, 6, 16).scale(1, 0.55, 1.05), boots);
    goggles.position.set(0.62, 0.19, 0);
    goggles.rotation.y = Math.PI / 2;
    this.jockeyTorso.add(helmet, peak, face, goggles);
    // 腕（肩 → 肘 → 手。最後の直線では追い動作）
    for (const s of [-1, 1]) {
      const upper = new THREE.Group();
      upper.position.set(0.38, 0.1, s * 0.17);
      const ua = mesh(loftGeometry([sec(0, 0, 0, 0.045, 0.045, 0.045), sec(0, -0.26, 0, 0.04, 0.04, 0.038)], { radial: 8, subdiv: 1, capStart: true, capEnd: true, up }), sleeveMat);
      upper.add(ua);
      const fore = new THREE.Group();
      fore.position.y = -0.26;
      const fa = mesh(loftGeometry([sec(0, 0, 0, 0.038, 0.038, 0.036), sec(0, -0.25, 0, 0.032, 0.032, 0.03)], { radial: 8, subdiv: 1, capStart: true, capEnd: true, up }), sleeveMat);
      const glove = mesh(new THREE.SphereGeometry(0.04, 8, 6), breeches);
      glove.position.y = -0.27;
      const hand = s < 0 ? this.handL : this.handR;
      hand.position.y = -0.27;
      fore.add(fa, glove, hand);
      upper.add(fore);
      this.jockeyTorso.add(upper);
      this.arms.push({ upper, fore });
      // 脚（太もも → すね → ブーツ）
      const thigh = mesh(loftGeometry([sec(0.02, -0.03, s * 0.13, 0.062, 0.062, 0.058), sec(0.3, -0.22, s * 0.2, 0.05, 0.05, 0.047)], { radial: 9, subdiv: 1, capStart: true, capEnd: true }), breeches);
      const shin = mesh(loftGeometry([sec(0.3, -0.22, s * 0.2, 0.05, 0.05, 0.048), sec(0.12, -0.5, s * 0.215, 0.042, 0.042, 0.04)], { radial: 9, subdiv: 1, capStart: true, capEnd: true }), boots);
      const foot = mesh(loftGeometry([sec(0.1, -0.52, s * 0.215, 0.04, 0.035, 0.04), sec(0.24, -0.56, s * 0.215, 0.03, 0.03, 0.035)], { radial: 8, subdiv: 1, capStart: true, capEnd: true }), boots);
      const iron = mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 12), strap);
      iron.position.set(0.18, -0.6, s * 0.215);
      iron.rotation.y = Math.PI / 2;
      this.jockey.add(thigh, shin, foot, iron);
    }

    // 手綱（ハミ → 手。毎フレーム更新）
    if (detail !== 'low') {
      for (let i = 0; i < 2; i++) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 5).translate(0, 0.5, 0), leather);
        this.geometries.push(r.geometry);
        this.reins.push(r);
        this.body.add(r);
      }
    }

    // 接地影（影を計算しない軽量設定でも接地感を出す）
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 1.0),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: opts.shadows ? 0.35 : 0.6 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.03;
    this.blob.renderOrder = -1;
    this.geometries.push(this.blob.geometry);
    this.materials.push(this.blob.material as THREE.Material);
    this.root.add(this.blob);

    // 注目馬のマーカー（控えめな小さい三角）
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 3).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: '#ffd166' }));
    this.marker.position.set(0.3, 3.0, 0);
    this.marker.visible = false;
    this.geometries.push(this.marker.geometry);
    this.materials.push(this.marker.material as THREE.Material);
    this.root.add(this.marker);

    // モーションブラーのマスク用に、馬と騎手をレイヤー1にも載せる
    this.root.traverse((o) => o.layers.enable(1));
    this.blob.layers.disable(1);
  }

  setHighlight(on: boolean) {
    this.marker.visible = on;
  }

  /**
   * 位置・向き・速度を与えて1フレーム進める。
   * @param dt レース時間の経過（一時停止中は 0）
   * @param drive 追い動作の強さ 0〜1（最後の直線）
   * @returns このフレームで着地した蹄（世界座標）
   */
  update(x: number, z: number, heading: number, v: number, dt: number, drive: number): Landing[] {
    this.landings.length = 0;
    this.time += dt;
    // 旋回に応じて内側へ傾く
    let dh = heading - this.prevHeading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    this.prevHeading = heading;
    const yawRate = dt > 0 ? dh / dt : 0;
    const targetRoll = Math.max(-0.12, Math.min(0.12, v * yawRate * 0.045));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);
    this.root.position.set(x, 0, z);
    this.root.rotation.set(this.roll, -heading, 0, 'YXZ');

    const prevPhase = this.phase;
    if (dt > 0) this.phase += strideFrequency(v, this.traits) * dt * (v < 0.3 ? 0 : 1);
    const p = this.phase;
    const speed = Math.min(1, v / 16);
    const TAU = Math.PI * 2;

    // 体の上下動と前後の揺れ（前肢の着地で低く・前下がり、空中期で高く）
    const bob = (0.05 * speed + 0.004) * Math.cos(TAU * (p - 0.75)) - 0.015 * speed;
    const pitch = -0.035 * speed * Math.sin(TAU * (p - 0.15));
    this.body.position.y = bob;
    this.body.rotation.z = pitch;
    this.bobSmooth += (bob - this.bobSmooth) * Math.min(1, dt * 3);

    // 首と頭：速いほど前へ伸ばし、前肢の着地に合わせてうなずく
    const nod = 0.075 * speed * Math.sin(TAU * (p - 0.2));
    this.neckPivot.rotation.z = (0.22 - 0.3 * speed) + this.headCarriage + nod;
    this.headPivot.rotation.z = -1.05 + 0.25 * speed - nod * 0.6;

    // 脚：蹄の目標 → 胴の座標へ変換 → IK
    const cosP = Math.cos(-pitch);
    const sinP = Math.sin(-pitch);
    const toBody = (wx: number, wy: number): [number, number] => {
      const dy = wy - bob;
      return [wx * cosP - dy * sinP, wx * sinP + dy * cosP];
    };
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    for (const leg of this.legs) {
      const s = leg.spec;
      const ft = footTarget(s, p, prevPhase, v, this.traits);
      // 着地中は球節が沈んで繋が寝る（荷重）。球節の目標 = 蹄底の目標 − (繋 + 蹄)
      const load = ft.stance && v > 1 ? Math.sin(Math.PI * ft.stanceT) * speed : 0;
      const sAng = PASTERN_STANCE + 0.28 * load;
      const [fx, fy] = toBody(ft.x - s.pastern * Math.sin(sAng), ft.y + s.pastern * Math.cos(sAng) + HOOF_H);
      const ik = solveTwoBone(s.ax, s.ay, fx, fy, s.l1, s.l2, leg.bend);
      leg.upper.rotation.z = ik.a1;
      leg.lower.rotation.z = ik.a2 - ik.a1;
      // 繋の向き（世界座標）：着地中は前下方、遊脚中は後ろへ折りたたむ
      const fold = ft.stance ? 0 : Math.sin(Math.PI * ft.swing) * (s.fore ? 1.6 : 1.2) * (0.3 + 0.7 * speed);
      const pasternWorld = ft.stance ? sAng : ik.a2 + pitch + 0.35 - fold;
      leg.pastern.rotation.z = pasternWorld - pitch - ik.a2;
      if (ft.justLanded && v > 3) {
        const lx = ft.x * this.size;
        const lz = leg.az * this.size;
        this.landings.push({ x: x + lx * cosH - lz * sinH, z: z + lx * sinH + lz * cosH, fore: s.fore });
      }
    }

    // 尾：付け根の角度は速度で持ち上がり、各節はばねで遅れて揺れる
    // 静止時は垂れ下がり（+1.35rad）、全速では後ろへ流れる
    const tailBase = 1.35 - 0.9 * speed;
    this.tail.forEach((seg, i) => {
      const target = (i === 0 ? tailBase : 0.1 + 0.04 * (1 - speed)) + pitch * (i === 0 ? 1.4 : 0.4) + Math.sin(TAU * (p - 0.3 - i * 0.08)) * 0.07 * speed;
      if (dt > 0) {
        const k = 90;
        const c = 14;
        const acc = k * (target - seg.rotation.z) - c * this.tailVel[i];
        this.tailVel[i] += acc * dt;
        seg.rotation.z += this.tailVel[i] * dt;
        this.tailSway[i] += (Math.sin(this.time * (3.1 + i) + i) * 0.06 * (1 - speed * 0.5) - this.tailSway[i]) * Math.min(1, dt * 3);
        seg.rotation.y = this.tailSway[i];
      }
    });

    // たてがみのなびき
    this.maneUniforms.uTime.value = this.time;
    this.maneUniforms.uSpeed.value = speed;

    // 騎手：馬の上下動を膝で吸収して頭の位置を保ち、最後の直線では追う
    this.jockey.position.y = 2.0 - bob * 0.75 + (bob - this.bobSmooth) * 0.2;
    this.jockey.rotation.z = -pitch * 0.8;
    const push = drive * Math.sin(TAU * (p - 0.25));
    this.jockeyTorso.rotation.z = -0.05 * drive + 0.035 * push;
    this.jockeyTorso.position.x = 0.03 * push;
    for (const arm of this.arms) {
      arm.upper.rotation.z = 0.75 + 0.2 * push + 0.05 * speed;
      arm.fore.rotation.z = 0.5 - 0.15 * push;
    }

    // 手綱をハミと手の間に張る
    if (this.reins.length) {
      this.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
      const pairs: [THREE.Object3D, THREE.Object3D][] = [
        [this.bitL, this.handL],
        [this.bitR, this.handR],
      ];
      pairs.forEach(([bit, hand], i) => {
        const a = bit.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
        const b2 = hand.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
        const r = this.reins[i];
        r.position.copy(a);
        const dir = b2.clone().sub(a);
        r.scale.set(1, dir.length(), 1);
        r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      });
    }
    return this.landings;
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
