/**
 * 写実寄りの競走馬（基準モデルの制作基準で作る馬）。外部の3Dモデル・写真・モーションデータは使わない。
 *
 * - 馬体：骨・筋肉の塊をなめらかにつないだ1枚のスキンメッシュ（mesh.ts）。肩・トモ・首・脚が継ぎ目なくつながる
 * - リグ：胸郭・腰・首2節・頭・耳・肩甲骨・上腕・前腕・管・繋（前肢）、大腿・下腿・管・繋（後肢）・尾5節
 * - 走行：蹄の位置は歩様（gait.ts）。肩甲骨・上腕・大腿は「肢全体の振り」に合わせて回り、肘と膝（後膝）が前後に動く。
 *   膝下は2関節IKで蹄を地面に固定する（滑らない・沈まない）。胴の上下動・前後の傾き・腰の屈伸・首と頭のうなずきを完歩に同期
 * - 毛色：頂点色（毛色・背の濃さ・脚先・靴下・顔の白斑・ムラ・くぼみの陰影）と、毛並みの光沢（シーン・クリアコート）
 * - たてがみ・尾：毛束。たてがみは走りに合わせてなびき、尾は骨ごとのばねで遅れて揺れる
 * - 馬具：鞍下ゼッケン・鞍・腹帯は体の表面に沿わせて作り、体と一緒に変形する。頭絡・ハミ・手綱
 * - 騎手：短いあぶみに立つ前傾姿勢。馬の上下動を膝で吸収し、最後の直線では手綱を押す
 *
 * 座標系：馬の前方 +x、上 +y、右 +z。root の原点は胴の真下の地面。
 */
import * as THREE from 'three';
import { type GaitTraits, type LegSpec, footTarget, solveTwoBone, strideFrequency } from '../gait';
import { type Section, loftGeometry, sec } from '../loft';
import { fbm3, noise3 } from '../noise';
import { FORE, H, HEAD, HEAD_TILT, HIND, HOOF_H, PASTERN_LEN, POLL, anatomy, boneDefs } from './anatomy';
import { HAND, JOCKEY_BONES } from './jockeyShape';
import { type Detail, JPARTS, type MeshData } from './mesh';
import { horseMesh, jockeyMesh } from './meshCache';
import { Shape, type Vec3, skinWeights } from './sdf';
import type { HorseSpec } from './spec';

export interface Landing {
  x: number;
  y: number;
  z: number;
  fore: boolean;
}

/** 映像側から見た馬（旧モデルと共通のインターフェース） */
export interface HorseView {
  readonly root: THREE.Object3D;
  update(x: number, y: number, z: number, heading: number, grade: number, v: number, dt: number, drive: number): Landing[];
  setHighlight(on: boolean): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
/** 鉛直下向きを 0 とし、前方へ回る角度 */
const ang = (a: Vec3 | THREE.Vector3, b: Vec3 | THREE.Vector3) => {
  const [ax, ay] = Array.isArray(a) ? a : [a.x, a.y];
  const [bx, by] = Array.isArray(b) ? b : [b.x, b.y];
  return Math.atan2(bx - ax, -(by - ay));
};
const dist2 = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const dir = (t: number) => new THREE.Vector2(Math.sin(t), -Math.cos(t));
/** 着地中の繋の傾き（鉛直から） */
const PASTERN_STANCE = ang(FORE.fetlock, FORE.coronet);

interface LegRig {
  id: 'FL' | 'FR' | 'HL' | 'HR';
  fore: boolean;
  side: 1 | -1;
  spec: LegSpec;
  /** 上から順の骨（前肢：肩甲骨・上腕・前腕・管・繋、後肢：大腿・下腿・管・繋） */
  bones: THREE.Bone[];
  rest: number[];
  len: number[];
  /** 肢全体の振りの中心（前肢：き甲、後肢：股関節）と、静止時の球節 */
  pivot: Vec3;
  fetlockRest: Vec3;
  parent: THREE.Bone;
  parentAt: Vec3;
  hoof: THREE.Mesh;
}

function hairStrandTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  // 根元は密で、毛先ほど細く疎らになる毛束
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * 256;
    const len = 120 + Math.random() * 136;
    const shade = 200 + Math.floor(Math.random() * 55);
    g.strokeStyle = `rgba(${shade},${shade},${shade},${0.35 + Math.random() * 0.65})`;
    g.lineWidth = 0.6 + Math.random() * 1.4;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (Math.random() - 0.5) * 12, len * 0.35, x + (Math.random() - 0.5) * 18, len * 0.7, x + (Math.random() - 0.5) * 24, len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 尾の毛：塗りつぶしのない細い毛の線だけ（すき間から背景が見え、毛束らしく見える） */
function tailStrandTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 900; i++) {
    // 中央ほど密に
    const x = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 150;
    const start = Math.random() * 30;
    const len = 140 + Math.random() * (256 - start - 140);
    g.strokeStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.6})`;
    g.lineWidth = 0.7 + Math.random() * 1.6;
    g.beginPath();
    g.moveTo(x, start);
    g.bezierCurveTo(x + (Math.random() - 0.5) * 10, start + len * 0.4, x + (Math.random() - 0.5) * 16, start + len * 0.75, x + (Math.random() - 0.5) * 22, start + len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function clothTexture(n: number, base: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 384;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 384);
  g.fillStyle = '#1d2a38';
  g.fillRect(0, 372, 512, 12);
  g.fillRect(0, 0, 10, 384);
  g.fillRect(502, 0, 10, 384);
  g.font = 'bold 150px "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#121212';
  g.fillText(String(n), 256, 236);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
    g.fillRect(Math.random() * 512, Math.random() * 384, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 外側から内側へ光線を進め、SDF の表面の点を求める */
function surfacePoint(shape: Shape, o: THREE.Vector3, d: THREE.Vector3, maxDist = 0.7): THREE.Vector3 | null {
  let t = maxDist;
  const p = new THREE.Vector3();
  for (let i = 0; i < 80; i++) {
    p.copy(o).addScaledVector(d, t);
    const s = shape.dist(p.x, p.y, p.z);
    if (Math.abs(s) < 2e-4) return p;
    t -= s;
    if (t < 0) return null;
  }
  return p;
}

export class RaceHorse implements HorseView {
  readonly root = new THREE.Group();
  readonly traits: GaitTraits;
  private body = new THREE.Group();
  private bones = new Map<string, THREE.Bone>();
  private skeleton!: THREE.Skeleton;
  private legs: LegRig[] = [];
  private tailVel: number[] = [];
  private tailSway: number[] = [];
  private jBones = new Map<string, THREE.Bone>();
  private reins: THREE.Mesh[] = [];
  private leathers: THREE.Mesh[] = [];
  private bits: THREE.Object3D[] = [];
  private irons: THREE.Object3D[] = [];
  private saddleHang: THREE.Object3D[] = [];
  private jockeyMesh: THREE.SkinnedMesh | null = null;
  private maneUniforms = { uTime: { value: 0 }, uSpeed: { value: 0 } };
  private marker: THREE.Mesh;
  private blob: THREE.Mesh;
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private textures: THREE.Texture[] = [];
  private phase: number;
  private time = 0;
  private prevHeading = 0;
  private roll = 0;
  private bobSmooth = 0;
  private landings: Landing[] = [];
  private scaleX: number;
  private tmpV = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();

  /** メッシュを（必要なら Worker で）用意してから作る */
  static async create(spec: HorseSpec, detail: Detail, opts: { shadows: boolean; physical: boolean }): Promise<RaceHorse> {
    const [horse, jockey] = await Promise.all([horseMesh(spec.build.type, detail), jockeyMesh(detail)]);
    return new RaceHorse(spec, detail, opts, horse, jockey);
  }

  constructor(
    readonly spec: HorseSpec,
    detail: Detail,
    opts: { shadows: boolean; physical: boolean },
    mesh: MeshData,
    jmesh: MeshData,
  ) {
    const shape = new Shape(anatomy(spec.build.type));
    this.traits = { ...spec.gait, maxStance: 1.35 };
    this.phase = spec.gait.phase;
    this.scaleX = spec.build.length;

    // ---- 骨格 ----
    const defs = boneDefs();
    const at = new Map(defs.map((d) => [d.name, d.at]));
    for (const d of defs) {
      const b = new THREE.Bone();
      b.name = d.name;
      const p = d.parent ? at.get(d.parent)! : ([0, 0, 0] as Vec3);
      b.position.set(d.at[0] - p[0], d.at[1] - p[1], d.at[2] - p[2]);
      this.bones.set(d.name, b);
      if (d.parent) this.bones.get(d.parent)!.add(b);
    }
    this.body.add(this.bones.get('thorax')!);
    this.root.add(this.body);
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(defs.map((d) => this.bones.get(d.name)!));
    const B = (n: string) => this.bones.get(n)!;

    // ---- 材質 ----
    const coat = spec.coat;
    const base = new THREE.Color(coat.base);
    const gloss = coat.gloss;
    // 手入れされた短い毛の強いつや（筋肉の形に沿ったハイライト）
    const coatParams = { vertexColors: true, roughness: 0.46 - 0.14 * gloss, metalness: 0 };
    const coatMat = opts.physical
      ? new THREE.MeshPhysicalMaterial({
          ...coatParams,
          clearcoat: 0.6 * gloss,
          clearcoatRoughness: 0.36,
          sheen: 0.3,
          sheenRoughness: 0.5,
          sheenColor: base.clone().lerp(new THREE.Color('#ffffff'), 0.35),
        })
      : new THREE.MeshStandardMaterial(coatParams);
    this.materials.push(coatMat);

    // ---- 馬体 ----
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(mesh.skinWeight, 4));
    geo.setAttribute('color', new THREE.BufferAttribute(this.coatColors(mesh), 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();
    this.geometries.push(geo);
    const bodyMesh = new THREE.SkinnedMesh(geo, coatMat);
    bodyMesh.castShadow = opts.shadows;
    bodyMesh.receiveShadow = opts.shadows && detail === 'high';
    bodyMesh.frustumCulled = false;
    this.root.add(bodyMesh);
    bodyMesh.bind(this.skeleton, bodyMesh.matrixWorld);

    const skinned = (g: THREE.BufferGeometry, mat: THREE.Material, rest: Float32Array) => {
      const w = skinWeights(shape, rest, defs.length);
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(w.index, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w.weight, 4));
      const m = new THREE.SkinnedMesh(g, mat);
      m.frustumCulled = false;
      m.castShadow = opts.shadows;
      this.geometries.push(g);
      this.root.add(m);
      m.bind(this.skeleton, m.matrixWorld);
      return m;
    };

    // ---- 顔・耳・目・蹄 ----
    const pointsCol = new THREE.Color(coat.points);
    const darkMat = new THREE.MeshStandardMaterial({ color: '#141210', roughness: 0.6 });
    const eyeMat = opts.physical
      ? new THREE.MeshPhysicalMaterial({ color: '#0a0706', roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 })
      : new THREE.MeshStandardMaterial({ color: '#0a0706', roughness: 0.08, metalness: 0.2 });
    const hoofDark = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.45 });
    const hoofLight = new THREE.MeshStandardMaterial({ color: '#b9a88c', roughness: 0.5 });
    this.materials.push(darkMat, eyeMat, hoofDark, hoofLight);
    const head = B('head');
    const headAt = at.get('head')!;
    const local = (p: Vec3 | THREE.Vector3, boneAt: Vec3) => {
      const [x, y, z] = Array.isArray(p) ? p : [p.x, p.y, p.z];
      return new THREE.Vector3(x - boneAt[0], y - boneAt[1], z - boneAt[2]);
    };
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.021, 16, 12), eyeMat);
      eye.position.copy(local(HEAD.eye(s), headAt));
      this.geometries.push(eye.geometry);
      head.add(eye);
      // 耳：根元が丸く、先が細く尖った形（前を向く）
      const earKeys: Section[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const w = 0.042 * Math.sin(Math.PI * (0.25 + 0.75 * (1 - t))) * (1 - 0.15 * t) + 0.003;
        earKeys.push(sec(0, t * 0.15, 0, w * 0.55, w * 0.55, w, { n: 2.2 }));
      }
      const outer = base.clone().lerp(pointsCol, 0.35).multiplyScalar(0.85);
      const earGeo = loftGeometry(earKeys, { radial: 10, subdiv: 2, capStart: false, capEnd: true, up: new THREE.Vector3(1, 0, 0), color: () => outer });
      this.geometries.push(earGeo);
      const ear = new THREE.Mesh(earGeo, coatMat);
      ear.castShadow = opts.shadows;
      ear.rotation.set(s * 0.22, 0, -0.18);
      B(s < 0 ? 'earL' : 'earR').add(ear);
    }
    const hoofGeo = new THREE.CylinderGeometry(0.046, 0.063, HOOF_H, 16, 1);
    hoofGeo.translate(0, -HOOF_H / 2, 0);
    {
      const hp = hoofGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < hp.count; i++) hp.setX(i, hp.getX(i) + (-hp.getY(i) / HOOF_H) * 0.022);
      hoofGeo.computeVertexNormals();
    }
    this.geometries.push(hoofGeo);

    // ---- 脚のリグ ----
    const legIds: ['FL' | 'FR' | 'HL' | 'HR', boolean, 1 | -1][] = [
      ['FL', true, -1],
      ['FR', true, 1],
      ['HL', false, -1],
      ['HR', false, 1],
    ];
    legIds.forEach(([id, fore, s], i) => {
      const side = s < 0 ? 'L' : 'R';
      const J: Record<string, Vec3> = fore ? FORE : HIND;
      const names = fore ? ['scapula', 'humerus', 'forearm', 'fcannon', 'fpastern'] : ['femur', 'tibia', 'hcannon', 'hpastern'];
      const joints: Vec3[] = fore ? [J.withers, J.shoulder, J.elbow, J.knee, J.fetlock, J.coronet] : [J.hip, J.stifle, J.hock, J.fetlock, J.coronet];
      const rest: number[] = [];
      const len: number[] = [];
      for (let k = 0; k < joints.length - 1; k++) {
        rest.push(ang(joints[k], joints[k + 1]));
        len.push(dist2(joints[k], joints[k + 1]));
      }
      const bones = names.map((n) => B(`${n}${side}`));
      const ikRoot = fore ? FORE.elbow : HIND.stifle;
      const l1 = len[fore ? 2 : 1];
      const l2 = len[fore ? 3 : 2];
      const legSpec: LegSpec = { id, fore, ax: ikRoot[0], ay: ikRoot[1], l1, l2, pastern: PASTERN_LEN, restX: J.coronet[0] + 0.012 };
      const hoof = new THREE.Mesh(hoofGeo, spec.markings.socks[i] > 0 ? hoofLight : hoofDark);
      hoof.castShadow = opts.shadows;
      const pasternBone = bones[bones.length - 1];
      hoof.position.copy(local(J.coronet, J.fetlock));
      hoof.position.z = 0;
      pasternBone.add(hoof);
      const parentName = fore ? 'thorax' : 'pelvis';
      this.legs.push({ id, fore, side: s, spec: legSpec, bones, rest, len, pivot: joints[0], fetlockRest: J.fetlock, parent: B(parentName), parentAt: at.get(parentName)!, hoof });
    });

    // ---- たてがみ（首の稜線から右側へ垂れる毛束を重ねる）・前髪 ----
    const maneTex = hairStrandTexture();
    this.textures.push(maneTex);
    const maneMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(coat.mane), map: maneTex, alphaTest: 0.32, side: THREE.DoubleSide, roughness: 0.8, envMapIntensity: 0.35 });
    maneMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.maneUniforms.uTime;
      shader.uniforms.uSpeed = this.maneUniforms.uSpeed;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uSpeed;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float tip = uv.y;
         float w = sin(uTime * 9.0 + uv.x * 13.0) * 0.012 + sin(uTime * 19.0 + uv.x * 29.0) * 0.006;
         transformed.x -= tip * tip * (0.03 + 0.09 * uSpeed);
         transformed.y += tip * (w + 0.05 * uSpeed);
         transformed.z += tip * w * 1.5;`,
      );
    };
    const tailTex = tailStrandTexture();
    this.textures.push(tailTex);
    const tailMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(coat.mane), map: tailTex, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8, envMapIntensity: 0.35 });
    this.materials.push(maneMat, tailMat);
    {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const card = (roots: THREE.Vector3[], tips: THREE.Vector3[], u0: number) => {
        const base0 = pos.length / 3;
        roots.forEach((r, i) => {
          pos.push(r.x, r.y, r.z, tips[i].x, tips[i].y, tips[i].z);
          const u = u0 + i / (roots.length - 1);
          uv.push(u, 0, u, 1);
          if (i < roots.length - 1) {
            const k = base0 + i * 2;
            idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
          }
        });
      };
      const layers = detail === 'low' ? [{ side: 1, len: 1, z: 0 }, { side: 1.2, len: 0.85, z: 0.02 }] : [
        { side: 0.9, len: 1, z: 0 },
        { side: 1.1, len: 0.95, z: 0.012 },
        { side: 1.3, len: 0.85, z: 0.024 },
        { side: 0.5, len: 0.7, z: -0.006 },
        { side: 1.5, len: 0.75, z: 0.036 },
      ];
      const crestA = new THREE.Vector3(...HEAD.crest[0]);
      const crestB = new THREE.Vector3(...HEAD.crest[1]);
      for (const Ly of layers) {
        const roots: THREE.Vector3[] = [];
        const tips: THREE.Vector3[] = [];
        const N = 26;
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const c = crestA.clone().lerp(crestB, t);
          const up = new THREE.Vector3(-(crestB.y - crestA.y), crestB.x - crestA.x, 0).normalize();
          const sp = surfacePoint(shape, c.clone().addScaledVector(up, -0.15), up, 0.6) ?? c;
          const root = sp.clone().addScaledVector(up, -0.006);
          root.z += Ly.z;
          const len = (0.13 + 0.12 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.04 * noise3(t * 9, Ly.z * 50, 2)) * Ly.len;
          const tip = root.clone().add(new THREE.Vector3(-0.04, -len * 0.75, len * 0.5 * Ly.side + 0.05));
          roots.push(root);
          tips.push(tip);
        }
        card(roots, tips, 0);
      }
      // 前髪（耳の間から額へ）
      if (detail !== 'low') {
        const r0 = new THREE.Vector3(...H(-0.01, 0.08, -0.035));
        const r1 = new THREE.Vector3(...H(-0.01, 0.08, 0.035));
        card([r0, r1], [new THREE.Vector3(...H(0.16, 0.11, -0.05)), new THREE.Vector3(...H(0.16, 0.11, 0.05))], 0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // 重みは毛の根元（各列の偶数番目の頂点）で決め、毛先も同じ骨に付ける
      const rest = new Float32Array(pos.length);
      for (let v = 0; v < pos.length / 3; v++) {
        const r = v % 2 === 0 ? v : v - 1;
        rest.set(pos.slice(r * 3, r * 3 + 3), v * 3);
      }
      const mane = skinned(g, maneMat, rest);
      mane.castShadow = false;
    }

    // ---- 尾（交差させた毛束。尾の骨に沿って重みを付ける） ----
    {
      const tailDefs = defs.filter((d) => d.name.startsWith('tail'));
      const t0 = tailDefs[0].at;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const skinI: number[] = [];
      const skinW: number[] = [];
      const rows = 18;
      const Ltail = 0.95;
      const planes = detail === 'low' ? 3 : 6;
      for (let pl = 0; pl < planes; pl++) {
        const a = (pl / planes) * Math.PI;
        const base0 = pos.length / 3;
        for (let r = 0; r <= rows; r++) {
          const t = r / rows;
          const x = t0[0] - t * Ltail;
          const y = t0[1] - t * 0.07 * 5 * (Ltail / 0.85);
          const w = 0.05 + 0.2 * Math.sin(Math.min(1, t * 1.3) * Math.PI * 0.5) * (1 - 0.3 * t);
          const dy = Math.cos(a) * w * 0.5;
          const dz = Math.sin(a) * w * 0.5;
          pos.push(x, y + dy, dz, x, y - dy, -dz);
          uv.push(0, t, 1, t);
          // 尾の骨（0〜4）の間で線形に重みを配分
          const f = Math.min(3.999, t * 4.6);
          const b0 = Math.floor(f);
          const wt = f - b0;
          const i0 = defs.findIndex((d) => d.name === `tail${b0}`);
          const i1 = defs.findIndex((d) => d.name === `tail${Math.min(4, b0 + 1)}`);
          for (let k = 0; k < 2; k++) {
            skinI.push(i0, i1, 0, 0);
            skinW.push(1 - wt, wt, 0, 0);
          }
          if (r < rows) {
            const k = base0 + r * 2;
            idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinI, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.geometries.push(g);
      const tail = new THREE.SkinnedMesh(g, tailMat);
      tail.frustumCulled = false;
      tail.castShadow = opts.shadows;
      this.root.add(tail);
      tail.bind(this.skeleton, tail.matrixWorld);
      for (let i = 0; i < 5; i++) {
        this.tailVel.push(0);
        this.tailSway.push(0);
      }
    }

    // ---- 馬具（体の表面に沿わせる） ----
    const leather = new THREE.MeshStandardMaterial({ color: '#2b1d14', roughness: 0.5 });
    const strap = new THREE.MeshStandardMaterial({ color: '#16130f', roughness: 0.55 });
    const girthMat = new THREE.MeshStandardMaterial({ color: '#d8d4cb', roughness: 0.85 });
    const clothTex = clothTexture(spec.tack.number, spec.tack.cloth);
    const clothMat = new THREE.MeshStandardMaterial({ map: clothTex, roughness: 0.85 });
    this.materials.push(leather, strap, girthMat, clothMat);
    this.textures.push(clothTex);
    /** 胴の断面に沿った帯：x の範囲 × 断面の角度の範囲（角度は右側から上へ測る） */
    const drape = (x0: number, x1: number, th0: number, th1: number, cols: number, rows: number, off: number, mat: THREE.Material, uvFn: (u: number, v: number) => [number, number], cy = 1.25) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const rest: number[] = [];
      for (let i = 0; i <= cols; i++) {
        const x = x0 + ((x1 - x0) * i) / cols;
        for (let j = 0; j <= rows; j++) {
          const th = th0 + ((th1 - th0) * j) / rows;
          const d = new THREE.Vector3(0, Math.sin(th), Math.cos(th));
          const o = new THREE.Vector3(x, cy, 0);
          const p = surfacePoint(shape, o, d, 0.7) ?? o.clone().addScaledVector(d, 0.3);
          const n = shape.grad(p.x, p.y, p.z);
          rest.push(p.x, p.y, p.z);
          pos.push(p.x + n[0] * off, p.y + n[1] * off, p.z + n[2] * off);
          uv.push(...uvFn(i / cols, j / rows));
          if (i < cols && j < rows) {
            const a = i * (rows + 1) + j;
            const b = a + rows + 1;
            idx.push(a, b, a + 1, b, b + 1, a + 1);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = skinned(g, mat, new Float32Array(rest));
      m.material = mat;
      (m.material as THREE.Material).side = THREE.DoubleSide;
      return m;
    };
    // 鞍下ゼッケン（左右。番号が正しく読める向きに uv を付ける）
    drape(-0.3, 0.27, Math.PI / 2 - 0.1, -0.5, 18, 12, 0.012, clothMat, (u, v) => [u, 1 - v]);
    drape(-0.3, 0.27, Math.PI / 2 + 0.1, Math.PI + 0.5, 18, 12, 0.012, clothMat, (u, v) => [1 - u, 1 - v]);
    // 鞍・腹帯
    drape(-0.1, 0.21, Math.PI / 2 - 0.6, Math.PI / 2 + 0.6, 10, 10, 0.03, leather, (u, v) => [u, v]);
    drape(0.32, 0.355, -Math.PI / 2 - 0.02, Math.PI * 1.5 + 0.02, 3, 40, 0.016, girthMat, (u, v) => [u, v], 1.2);
    // 頭絡（鼻革・頬革・額革・喉革）とハミ
    const tube = (pts: THREE.Vector3[], closed: boolean, r: number, mat: THREE.Material) => {
      if (pts.length < 3) return null;
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => local(p, headAt)), closed);
      const g = new THREE.TubeGeometry(curve, pts.length * 3, r, 5, closed);
      this.geometries.push(g);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = opts.shadows;
      head.add(m);
      return m;
    };
    /** 断面に沿った輪（中心から maxR より遠い点は、首など別の部位に当たったものとして除く） */
    const ring = (c: THREE.Vector3, u: THREE.Vector3, w: THREE.Vector3, a0: number, a1: number, n: number, off: number, maxR = 0.16) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const d = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a)).normalize();
        const p = surfacePoint(shape, c, d, maxR + 0.05);
        if (p && p.distanceTo(c) <= maxR) pts.push(p.addScaledVector(d, off));
      }
      return pts;
    };
    const Z = new THREE.Vector3(0, 0, 1);
    const headN = new THREE.Vector3(Math.sin(HEAD_TILT), Math.cos(HEAD_TILT), 0);
    tube(ring(new THREE.Vector3(...HEAD.noseband), headN, Z, 0, TAU, 28, 0.006), true, 0.007, strap);
    tube(ring(new THREE.Vector3(...HEAD.brow), headN, Z, -Math.PI / 2, Math.PI / 2, 14, 0.006), false, 0.006, strap);
    tube(ring(new THREE.Vector3(...HEAD.throat), headN.clone().negate(), Z, -Math.PI / 2, Math.PI / 2, 14, 0.006), false, 0.006, strap);
    for (const s of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const c = new THREE.Vector3(...H(0.0, 0.05)).lerp(new THREE.Vector3(...HEAD.bit), i / 10);
        const p = surfacePoint(shape, c, new THREE.Vector3(0, 0, s), 0.3);
        if (p) pts.push(p.add(new THREE.Vector3(0, 0, 0.006 * s)));
      }
      tube(pts, false, 0.006, strap);
      const bitP = surfacePoint(shape, new THREE.Vector3(...HEAD.bit), new THREE.Vector3(0, 0, s), 0.3) ?? new THREE.Vector3(HEAD.bit[0], HEAD.bit[1], 0.06 * s);
      const bit = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.005, 6, 16), new THREE.MeshStandardMaterial({ color: '#b8bcc0', metalness: 0.9, roughness: 0.3 }));
      this.geometries.push(bit.geometry);
      this.materials.push(bit.material as THREE.Material);
      bit.position.copy(local(bitP, headAt));
      head.add(bit);
      const anchor = new THREE.Object3D();
      anchor.position.copy(bit.position);
      head.add(anchor);
      this.bits.push(anchor);
    }

    // ---- 騎手 ----
    this.buildJockey(jmesh, opts, detail, at.get('thorax')!);

    // 接地影（影を計算しない軽量設定でも接地感を出す）
    const blobTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      grd.addColorStop(0, 'rgba(0,0,0,0.9)');
      grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    this.textures.push(blobTex);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.0), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: opts.shadows ? 0.3 : 0.6 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.03;
    this.blob.renderOrder = -1;
    this.geometries.push(this.blob.geometry);
    this.materials.push(this.blob.material as THREE.Material);
    this.root.add(this.blob);
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 3).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: '#ffd166' }));
    this.marker.position.set(0.3, 3.0, 0);
    this.marker.visible = false;
    this.geometries.push(this.marker.geometry);
    this.materials.push(this.marker.material as THREE.Material);
    this.root.add(this.marker);

    // 体格の個体差（体長・体高・幅）
    this.root.scale.set(spec.build.length, spec.build.height, spec.build.width);
    // モーションブラーのマスク用に、馬と騎手をレイヤー1にも載せる
    this.root.traverse((o) => o.layers.enable(1));
    this.blob.layers.disable(1);
  }

  /** 馬ごとの頂点色：毛色のムラ・背の濃さ・脚先・靴下・顔の白斑・連銭・くぼみの陰影 */
  private coatColors(mesh: MeshData): Float32Array {
    const s = this.spec;
    const n = mesh.positions.length / 3;
    const out = new Float32Array(n * 3);
    const base = new THREE.Color(s.coat.base);
    const points = new THREE.Color(s.coat.points);
    const white = new THREE.Color('#ece8de');
    const muzzle = new THREE.Color('#2a2220');
    const c = new THREE.Color();
    const seed = [...s.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 97;
    const p = new THREE.Vector3();
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    for (let v = 0; v < n; v++) {
      p.set(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      // 大きなムラと細かい毛のムラ
      const big = fbm3(p.x * 2.6, p.y * 2.6, p.z * 2.6, 3, seed);
      const fine = noise3(p.x * 28, p.y * 28, p.z * 28, seed + 3);
      c.copy(base).multiplyScalar(0.9 + 0.2 * big + 0.05 * (fine - 0.5));
      // 背・首の上は濃く、腹側はわずかに明るい
      const top = smooth(1.3, 1.65, p.y);
      c.multiplyScalar(1 - s.coat.darkTop * top);
      if (p.y < 1.0 && p.y > 0.8) c.multiplyScalar(1.04);
      // 芦毛の連銭
      if (s.coat.dapple > 0) {
        const dn = noise3(p.x * 8, p.y * 8, p.z * 8, seed + 5);
        if (dn > 0.6) c.lerp(white, 0.35 * s.coat.dapple);
        else if (dn < 0.32) c.multiplyScalar(1 - 0.15 * s.coat.dapple);
      }
      // 脚先（膝・飛節から下）
      const legTop = p.x > 0 ? 0.57 : 0.6;
      const pt = 1 - smooth(legTop - 0.12, legTop, p.y);
      if (pt > 0) c.lerp(points, pt * 0.92);
      // 頭の座標（u: 項から鼻先へ、v: 額の側）
      const hu = (p.x - POLL[0]) * Math.cos(HEAD_TILT) - (p.y - POLL[1]) * Math.sin(HEAD_TILT);
      const hv = (p.x - POLL[0]) * Math.sin(HEAD_TILT) + (p.y - POLL[1]) * Math.cos(HEAD_TILT);
      const onHead = hu > -0.08 && p.x > 1.05;
      // 鼻先・唇は毛が薄く地肌の色、目の周りも少し暗い
      if (onHead) {
        const dm = Math.hypot(p.x - HEAD.muzzle[0], p.y - HEAD.muzzle[1], p.z * 0.7);
        c.lerp(muzzle, (1 - smooth(0.05, 0.13, dm)) * 0.85);
        const eye = HEAD.eye(p.z < 0 ? -1 : 1);
        const de = Math.hypot(p.x - eye[0], p.y - eye[1], p.z - eye[2]);
        if (de < 0.055) c.multiplyScalar(0.65 + 0.35 * smooth(0.024, 0.055, de));
      }
      // 顔の白斑（星・流星・大流星）は顔の前面（額の側）だけ
      if (onHead && s.markings.face !== 'none' && hv > 0.02) {
        const w = Math.abs(p.z);
        let mark = false;
        if (s.markings.face === 'star') mark = Math.hypot(hu - 0.12, w * 1.3) < 0.04;
        else if (s.markings.face === 'stripe') mark = hu > 0.08 && hu < 0.48 && w < 0.016 + 0.01 * Math.max(0, 0.15 - Math.abs(hu - 0.12)) / 0.15;
        else mark = hu > 0.06 && hu < 0.62 && w < 0.04 - 0.012 * Math.max(0, hu - 0.2);
        if (mark) c.copy(white).multiplyScalar(0.95 + 0.05 * fine);
      }
      // 白い靴下（脚ごと）
      const legIndex = (p.x > 0 ? 0 : 2) + (p.z > 0 ? 1 : 0);
      const sock = s.markings.socks[legIndex];
      if (sock > 0 && p.y < sock) c.lerp(white, 1 - smooth(sock - 0.03, sock, p.y));
      // くぼみの陰影（筋肉の境目・脚の付け根・腹の下）
      c.multiplyScalar(1 - 0.6 * mesh.occlusion[v]);
      out.set([c.r, c.g, c.b], v * 3);
    }
    return out;
  }

  private buildJockey(jm: MeshData, opts: { shadows: boolean; physical: boolean }, detail: Detail, thoraxAt: Vec3) {
    const t = this.spec.tack;
    const jat = new Map(JOCKEY_BONES.map((b) => [b.name, b.at]));
    for (const d of JOCKEY_BONES) {
      const b = new THREE.Bone();
      const p = d.parent ? jat.get(d.parent)! : thoraxAt;
      b.position.set(d.at[0] - p[0], d.at[1] - p[1], d.at[2] - p[2]);
      this.jBones.set(d.name, b);
      if (d.parent) this.jBones.get(d.parent)!.add(b);
    }
    this.bones.get('thorax')!.add(this.jBones.get('jroot')!);
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(JOCKEY_BONES.map((d) => this.jBones.get(d.name)!));

    const [silk, silk2, pattern] = t.silks;
    const cSilk = new THREE.Color(silk);
    const cSilk2 = new THREE.Color(silk2);
    const colors: Record<string, THREE.Color> = {
      breeches: new THREE.Color('#ecebe6'),
      boots: new THREE.Color('#121214'),
      skin: new THREE.Color('#c99a7a'),
      glove: new THREE.Color('#e9e7e2'),
    };
    const n = jm.positions.length / 3;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let v = 0; v < n; v++) {
      const x = jm.positions[v * 3];
      const y = jm.positions[v * 3 + 1];
      const z = jm.positions[v * 3 + 2];
      const part = JPARTS[jm.part![v]];
      if (part === 'silk' || part === 'sleeve') {
        // 勝負服の柄（位置で塗り分ける）
        let alt = false;
        switch (pattern % 6) {
          case 1:
            alt = Math.floor((x + 1) * 9) % 2 === 0;
            break;
          case 2:
            alt = Math.floor((z + 1) * 14) % 2 === 0;
            break;
          case 3:
            alt = Math.abs(y - 2.0 - (x - 0.2) * 0.4 - z * 0.6) < 0.045;
            break;
          case 4:
            alt = Math.floor((x + Math.abs(z) * 0.8 + 1) * 8) % 2 === 0;
            break;
          case 5:
            alt = noise3(x * 30, y * 30, z * 30, 4) > 0.62;
            break;
        }
        if (part === 'sleeve' && pattern % 6 === 0) alt = true;
        c.copy(alt ? cSilk2 : cSilk);
      } else c.copy(colors[part]);
      c.multiplyScalar(1 - 0.5 * jm.occlusion[v]);
      col.set([c.r, c.g, c.b], v * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(jm.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(jm.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(jm.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(jm.skinWeight, 4));
    g.setIndex(new THREE.BufferAttribute(jm.indices, 1));
    this.geometries.push(g);
    const mat = opts.physical
      ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.45, sheen: 0.6, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffffff') })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
    this.materials.push(mat);
    const m = new THREE.SkinnedMesh(g, mat);
    m.frustumCulled = false;
    m.castShadow = opts.shadows;
    this.root.add(m);
    m.bind(skeleton, m.matrixWorld);
    this.jockeyMesh = m;

    // 帽子（ヘルメット）・ひさし・ゴーグル
    const head = this.jBones.get('jhead')!;
    const hat = jat.get('jhead')!;
    const capMat = new THREE.MeshStandardMaterial({ color: t.cap, roughness: 0.32 });
    const dark = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: '#c0c4c8', metalness: 0.9, roughness: 0.3 });
    this.materials.push(capMat, dark, metal);
    const seg = detail === 'low' ? 12 : 20;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.108, seg, seg / 2, 0, TAU, 0, Math.PI * 0.62).scale(1.12, 0.95, 0.98), capMat);
    helmet.position.set(0.625 - hat[0], 2.155 - hat[1], 0);
    helmet.rotation.z = -0.35;
    const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.008, 12, 1, false, -Math.PI / 2, Math.PI).scale(1, 1, 1.4), capMat);
    peak.position.set(0.71 - hat[0], 2.165 - hat[1], 0);
    peak.rotation.z = -0.1;
    const goggles = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 6, 18, Math.PI).scale(1, 0.4, 1.05), dark);
    goggles.position.set(0.66 - hat[0], 2.13 - hat[1], 0);
    goggles.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    for (const o of [helmet, peak, goggles]) {
      o.castShadow = opts.shadows;
      this.geometries.push(o.geometry);
      head.add(o);
    }
    // 鞭（右手）
    const farmR = this.jBones.get('jfarmR')!;
    const fat = jat.get('jfarmR')!;
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.008, 0.66, 5).translate(0, -0.33, 0), dark);
    whip.position.set(HAND.R[0] - fat[0], HAND.R[1] - fat[1], HAND.R[2] - fat[2]);
    whip.rotation.z = -2.3;
    this.geometries.push(whip.geometry);
    farmR.add(whip);
    // 手綱を持つ手の位置
    for (const s of [-1, 1]) {
      const fa = this.jBones.get(s < 0 ? 'jfarmL' : 'jfarmR')!;
      const fp = jat.get(s < 0 ? 'jfarmL' : 'jfarmR')!;
      const h = s < 0 ? HAND.L : HAND.R;
      const hand = new THREE.Object3D();
      hand.position.set(h[0] - fp[0], h[1] - fp[1], h[2] - fp[2]);
      fa.add(hand);
      this.bits.push(hand);
      // あぶみ（足の位置）と、鞍から吊るす革
      const jr = this.jBones.get('jroot')!;
      const jra = jat.get('jroot')!;
      const iron = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.007, 6, 14), metal);
      iron.position.set(0.17 - jra[0], 1.395 - jra[1], 0.205 * s);
      iron.rotation.y = Math.PI / 2;
      this.geometries.push(iron.geometry);
      jr.add(iron);
      this.irons.push(iron);
      const hang = new THREE.Object3D();
      hang.position.set(0.04 - thoraxAt[0], 1.6 - thoraxAt[1], 0.2 * s);
      this.bones.get('thorax')!.add(hang);
      this.saddleHang.push(hang);
    }
    const strapMat = new THREE.MeshStandardMaterial({ color: '#2b1d14', roughness: 0.55 });
    this.materials.push(strapMat);
    if (detail !== 'low') {
      for (let i = 0; i < 2; i++) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 1, 5).translate(0, 0.5, 0), strapMat);
        this.geometries.push(r.geometry);
        this.reins.push(r);
        this.body.add(r);
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.008, 1, 0.025).translate(0, 0.5, 0), strapMat);
        this.geometries.push(l.geometry);
        this.leathers.push(l);
        this.body.add(l);
      }
    }
  }

  /** 騎手の表示（プレビューで馬体だけを確認するとき） */
  setJockeyVisible(on: boolean) {
    if (this.jockeyMesh) this.jockeyMesh.visible = on;
    this.jBones.get('jroot')!.visible = on;
    [...this.reins, ...this.leathers].forEach((r) => (r.visible = on));
  }

  setHighlight(on: boolean) {
    this.marker.visible = on;
  }

  /** 世界座標の点を、骨の親の座標（静止姿勢の馬の座標に換算）へ */
  private toParentRest(leg: LegRig, wp: THREE.Vector3): THREE.Vector3 {
    this.tmpM.copy(leg.parent.matrixWorld).invert();
    const q = wp.clone().applyMatrix4(this.tmpM);
    return q.add(new THREE.Vector3(...leg.parentAt));
  }

  update(x: number, y: number, z: number, heading: number, grade: number, v: number, dt: number, drive: number): Landing[] {
    this.landings.length = 0;
    this.time += dt;
    let dh = heading - this.prevHeading;
    if (dh > Math.PI) dh -= TAU;
    if (dh < -Math.PI) dh += TAU;
    this.prevHeading = heading;
    const yawRate = dt > 0 ? dh / dt : 0;
    const targetRoll = Math.max(-0.12, Math.min(0.12, v * yawRate * 0.045));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);
    this.root.position.set(x, y, z);
    this.root.rotation.set(this.roll, -heading, Math.atan(grade), 'YXZ');

    // 体の座標での速度（体格の倍率で割ると、世界での歩幅と蹄の動きが一致する）
    const vm = v / this.scaleX;
    const prevPhase = this.phase;
    if (dt > 0) this.phase += strideFrequency(vm, this.traits) * dt * (vm < 0.3 ? 0 : 1);
    const p = this.phase;
    const speed = Math.min(1, vm / 16);
    const g = this.spec.gait;

    // 胴：前肢の着地で低く前下がり、空中期で高く。腰は後肢の踏み込みで屈伸する
    const bob = (0.055 * speed + 0.004) * Math.cos(TAU * (p - 0.75)) - 0.02 * speed;
    const pitch = -0.04 * speed * Math.sin(TAU * (p - 0.15));
    this.body.position.y = bob;
    this.body.rotation.z = pitch;
    this.bobSmooth += (bob - this.bobSmooth) * Math.min(1, dt * 3);
    this.bones.get('pelvis')!.rotation.z = 0.045 * speed * Math.sin(TAU * (p - 0.05));
    // 首と頭：速いほど前へ伸ばし、前肢の着地に合わせてうなずく（頭は振りを打ち消して視線を保つ）
    const nod = 0.075 * speed * g.nod * Math.sin(TAU * (p - 0.2));
    this.bones.get('neck1')!.rotation.z = -0.24 * speed + nod + g.headCarriage * 0.5;
    this.bones.get('neck2')!.rotation.z = -0.07 * speed + nod * 0.45;
    this.bones.get('head')!.rotation.z = 0.36 * speed - nod * 0.8 + g.headCarriage * 0.5;
    // 耳：走るときは前へ向け、ときどき動かす
    for (const s of [-1, 1]) {
      const e = this.bones.get(s < 0 ? 'earL' : 'earR')!;
      e.rotation.z = -0.25 * speed + 0.08 * Math.sin(this.time * 0.9 + s * 1.7) * (1 - speed * 0.6);
      e.rotation.x = s * 0.05 * Math.sin(this.time * 0.6 + s);
    }
    this.root.updateMatrixWorld(true);

    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    for (const leg of this.legs) {
      const s = leg.spec;
      const ft = footTarget(s, p, prevPhase, vm, this.traits);
      const load = ft.stance && vm > 1 ? Math.sin(Math.PI * ft.stanceT) * speed : 0;
      const sAng = PASTERN_STANCE + 0.3 * load;
      const zz = leg.fetlockRest[2] * leg.side * Math.sign(leg.fetlockRest[2] || 1);
      // 蹄・蹄冠・球節の目標（馬の地面の座標）→ 骨の親の座標
      const coronetW = this.root.localToWorld(new THREE.Vector3(ft.x, ft.y + HOOF_H, zz));
      const fetW = this.root.localToWorld(new THREE.Vector3(ft.x - PASTERN_LEN * Math.sin(sAng), ft.y + HOOF_H + PASTERN_LEN * Math.cos(sAng), zz));
      const F = this.toParentRest(leg, fetW);
      const Cn = this.toParentRest(leg, coronetW);
      // 肢全体の振り：付け根（き甲・股関節）から球節への向きの変化
      const phi = ang(leg.pivot, F) - ang(leg.pivot, leg.fetlockRest);
      const swingFlex = ft.stance ? 0 : Math.sin(Math.PI * ft.swing) * (0.35 + 0.65 * speed);
      const th: number[] = [];
      let root: THREE.Vector2;
      let k: number;
      if (leg.fore) {
        th[0] = leg.rest[0] + 0.5 * phi;
        th[1] = leg.rest[1] + 0.7 * phi - 0.35 * swingFlex;
        root = new THREE.Vector2(leg.pivot[0], leg.pivot[1]).add(dir(th[0]).multiplyScalar(leg.len[0])).add(dir(th[1]).multiplyScalar(leg.len[1]));
        k = 2;
      } else {
        th[0] = leg.rest[0] + 0.85 * phi + 0.2 * swingFlex;
        root = new THREE.Vector2(leg.pivot[0], leg.pivot[1]).add(dir(th[0]).multiplyScalar(leg.len[0]));
        k = 1;
      }
      const ik = solveTwoBone(root.x, root.y, F.x, F.y, leg.len[k], leg.len[k + 1], leg.fore ? 1 : -1);
      th[k] = ik.a1;
      th[k + 1] = ik.a2;
      // 繋：着地中は地面に合わせ、遊脚中は後ろへ折りたたむ
      const fold = ft.stance ? 0 : Math.sin(Math.PI * ft.swing) * (leg.fore ? 1.5 : 1.15) * (0.3 + 0.7 * speed);
      th[k + 2] = ft.stance ? ang(F, Cn) : ik.a2 + 0.35 - fold;
      // 骨の回転（静止姿勢からの差。親の回転を差し引く）
      let prev = 0;
      leg.bones.forEach((b, i) => {
        const delta = th[i] - leg.rest[i];
        b.rotation.z = delta - prev;
        prev = delta;
      });
      // 着地中は蹄底を地面と平行に保つ
      leg.hoof.rotation.z = ft.stance ? -(sAng - PASTERN_STANCE) * 0.9 : 0;
      if (ft.justLanded && v > 3) {
        const lx = ft.x * this.root.scale.x;
        const lz = zz * this.root.scale.z;
        this.landings.push({ x: x + lx * cosH - lz * sinH, y: y + grade * lx, z: z + lx * sinH + lz * cosH, fore: s.fore });
      }
    }

    // 尾：付け根は速度で持ち上がって後ろへ流れ、各節はばねで遅れて揺れる（静止時は垂れ下がる）
    const tailBase = 1.2 - 0.85 * speed;
    for (let i = 0; i < 5; i++) {
      const seg = this.bones.get(`tail${i}`)!;
      const target = (i === 0 ? tailBase : 0.12 * (1 - speed) + 0.02) + pitch * (i === 0 ? 1.4 : 0.4) + Math.sin(TAU * (p - 0.3 - i * 0.08)) * 0.06 * speed;
      if (dt > 0) {
        const acc = 90 * (target - seg.rotation.z) - 14 * this.tailVel[i];
        this.tailVel[i] += acc * dt;
        seg.rotation.z += this.tailVel[i] * dt;
        this.tailSway[i] += (Math.sin(this.time * (2.7 + i) + i) * 0.06 * (1 - speed * 0.5) - this.tailSway[i]) * Math.min(1, dt * 3);
        seg.rotation.y = this.tailSway[i];
      }
    }
    this.maneUniforms.uTime.value = this.time;
    this.maneUniforms.uSpeed.value = speed;

    // 騎手：馬の上下動を膝で吸収して頭の位置を保ち、最後の直線では手綱を押す
    const jr = this.jBones.get('jroot')!;
    const jrAt = JOCKEY_BONES[0].at;
    jr.position.y = jrAt[1] - 1.3 - bob * 0.8 + (bob - this.bobSmooth) * 0.2;
    jr.rotation.z = -pitch * 0.85;
    const push = drive * Math.sin(TAU * (p - 0.25));
    this.jBones.get('jchest')!.rotation.z = -0.04 * drive + 0.03 * push;
    for (const s of ['L', 'R']) {
      this.jBones.get(`juarm${s}`)!.rotation.z = 0.12 * push - 0.04 * drive;
      this.jBones.get(`jfarm${s}`)!.rotation.z = -0.1 * push;
    }

    // 手綱（ハミ → 手）とあぶみ革（鞍 → あぶみ）
    if (this.reins.length) {
      this.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(this.body.matrixWorld).invert();
      const seg = (m: THREE.Mesh, a: THREE.Object3D, b: THREE.Object3D) => {
        const pa = a.getWorldPosition(this.tmpV).applyMatrix4(inv).clone();
        const pb = b.getWorldPosition(this.tmpV).applyMatrix4(inv).clone();
        m.position.copy(pa);
        const d = pb.sub(pa);
        m.scale.set(1, d.length(), 1);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      };
      seg(this.reins[0], this.bits[0], this.bits[2]);
      seg(this.reins[1], this.bits[1], this.bits[3]);
      seg(this.leathers[0], this.irons[0], this.saddleHang[0]);
      seg(this.leathers[1], this.irons[1], this.saddleHang[1]);
    }
    return this.landings;
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
