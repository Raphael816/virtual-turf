/**
 * 競馬場の環境。コースの形状・起伏は中山競馬場の公開データを参考にした非公式の再現（core/track.ts）。
 * 建物・施設の外観は公式の図面や写真を使わず、一般的な構成から作ったオリジナル。
 * 配置や規模のうち資料で確認できなかったもの（スタンドの規模、障害コースの障害の位置、
 * ターフビジョンの位置、周辺の街並み）は推定で、docs/05-course-reference.md に記載している。
 *
 * - 空：物理ベースの空（Preetham）＋雲の層。空から環境光（IBL）を作り、自然な陰影にする
 * - 地形：コースの標高から周囲の地面の高さを補間した起伏のある地面（関東平野らしく遠景は平ら）
 * - 芝（内回り・外回り）・ダート：色と法線のテクスチャ、世界座標の色ムラ、内ラチ沿いの傷み・刈り込みの縞、ハローの筋
 * - ラチ：外回りが分かれる・合流する所は外ラチを開ける
 * - スタンド：ゴール前の2層スタンド・屋根・ガラス張りの建物。観客は人型で、ゴール前で盛り上がる
 * - 内馬場：障害コース（周回と襷）と生垣・竹柵、ターフビジョン
 * - 周辺：木立・生垣・住宅地と中層の建物（霧で遠くほど霞む）
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Going, TimeOfDay, Weather } from '../../core/sim';
import { type Course, pointAt, venueCourses } from '../../core/track';
import { DEFAULT_VENUE, type VenueId } from '../../data/venues';
import { GLSL_NOISE, fbm3, noise3, seededRandom } from './noise';
import {
  boardTexture,
  cloudField,
  cloudTexture,
  dirtTextures,
  facadeTexture,
  glowSprite,
  grassTextures,
  hedgeTexture,
  poleTexture,
  seatTexture,
  turfTextures,
} from './textures';

export interface EnvQuality {
  level: 'low' | 'medium' | 'high';
  crowd: number;
  trees: number;
  shadows: boolean;
  shadowSize: number;
}

// 競馬場ごとの形（configureVenue で切り替える。モジュールの値として持ち、建物・地形の生成で参照する）
let TURF: Course;
let OUTER: Course;
let DIRT: Course;
/** 外回りがある場か（ない場は OUTER が内回りと同じ） */
let HAS_OUTER = false;
let FINISH: { x: number; y: number; z: number };
/** 回り（1 = 右、-1 = 左） */
let HAND: 1 | -1 = 1;
/** スタンド前面（ホームストレッチ外側）の z 座標 */
export let STAND_Z = 0;
/** スタンドの地盤の高さ（ゴール付近のコースの標高） */
export let STAND_BASE_Y = 0;
/** スタンドの中心（ゴール板の少し4コーナー寄り） */
export let STAND_X = 0;
const STAND_HALF = 190;
/** 外回りが内回りから分かれる／合流する u（内回りの座標） */
let BRANCH_U = 0;
let JOIN_U = 0;
/** 外回り独自の区間（外回りの座標。OUTER_TO は1周を超えることがある） */
let OUTER_FROM = 0;
let OUTER_TO = 0;
let currentVenue: VenueId | null = null;

/** 外回りのうち内回りの芝から離れている区間と、その分かれ目・合流点の内回りの u */
function outerSplit(inner: Course, outer: Course) {
  const n = Math.floor(outer.circumference / 2);
  const away: boolean[] = [];
  const nearestU = (x: number, z: number) => {
    let best = 0;
    let bd = Infinity;
    for (let u = 0; u < inner.circumference; u += 2) {
      const p = pointAt(inner, u, 0);
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return { u: best, d: Math.sqrt(bd) };
  };
  for (let i = 0; i < n; i++) {
    const p = pointAt(outer, i * 2, 0);
    away.push(nearestU(p.x, p.z).d > inner.width + 1);
  }
  // 離れている区間のうち最も長いひと続き（1周をまたぐことがある）
  let bestStart = 0;
  let bestLen = 0;
  for (let i = 0; i < n; i++) {
    if (!away[i] || away[(i - 1 + n) % n]) continue;
    let len = 0;
    while (len < n && away[(i + len) % n]) len++;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
  }
  const from = bestStart * 2;
  const to = from + bestLen * 2;
  const a = pointAt(outer, from, 0);
  const b = pointAt(outer, to, 0);
  let branch = nearestU(a.x, a.z).u;
  let join = nearestU(b.x, b.z).u;
  if (join < branch) join += inner.circumference;
  return { from, to, branch, join };
}

/** 環境を作る前に、競馬場の形を設定する */
export function configureVenue(venue: VenueId): void {
  if (currentVenue === venue) return;
  currentVenue = venue;
  const c = venueCourses(venue);
  TURF = c.turf;
  OUTER = c.turfOuter;
  DIRT = c.dirt;
  HAS_OUTER = OUTER !== TURF;
  HAND = TURF.hand;
  FINISH = pointAt(TURF, TURF.finishU, 0);
  STAND_Z = FINISH.z + TURF.width + 22;
  STAND_BASE_Y = FINISH.y;
  STAND_X = FINISH.x + 40 * HAND;
  if (HAS_OUTER) {
    const sp = outerSplit(TURF, OUTER);
    OUTER_FROM = sp.from;
    OUTER_TO = sp.to;
    BRANCH_U = sp.branch;
    JOIN_U = sp.join;
  }
  buildTerrain();
  OUTER_POLY = (() => {
    const pts: { x: number; z: number }[] = [];
    for (let u = 0; u < OUTER.circumference; u += 8) {
      const p = pointAt(OUTER, u, OUTER.width + 8);
      pts.push({ x: p.x, z: p.z });
    }
    return pts;
  })();
}

/** 世界座標のノイズで色ムラを付ける（テクスチャの繰り返しを目立たなくする） */
function addMacroVariation(mat: THREE.MeshStandardMaterial, scale: number, amount: number) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosVT;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosVT = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorldPosVT;\n${GLSL_NOISE}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float vtN = vt_fbm(vWorldPosVT.xz * ${scale.toFixed(4)});
         float vtN2 = vt_noise(vWorldPosVT.xz * ${(scale * 7.3).toFixed(4)});
         diffuseColor.rgb *= 1.0 + ${amount.toFixed(3)} * ((vtN - 0.5) * 1.6 + (vtN2 - 0.5) * 0.5);`,
      );
  };
}

// ---------------------------------------------------------------- 地形

interface TerrainSample {
  x: number;
  z: number;
  e: number;
}
let BASE_LEVEL = 2.2;
const BUCKET = 60;
const buckets = new Map<string, TerrainSample[]>();
function buildTerrain() {
  buckets.clear();
  let lo = Infinity;
  for (const c of HAS_OUTER ? [TURF, OUTER, DIRT] : [TURF, DIRT]) {
    for (let u = 0; u < c.circumference; u += 6) {
      const p = pointAt(c, u, c.width / 2);
      const s = { x: p.x, z: p.z, e: p.y };
      lo = Math.min(lo, p.y);
      const k = `${Math.floor(s.x / BUCKET)},${Math.floor(s.z / BUCKET)}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(s);
    }
  }
  // 遠くの地盤はコースの最も低い所より少し高い（中山の 2.2m と同じ考え方）
  BASE_LEVEL = lo + 2.15;
}

/** 地面の高さ：近くのコースの標高を、離れるにつれて平らな地盤（BASE_LEVEL）へなじませる */
export function terrainHeight(x: number, z: number): number {
  const bx = Math.floor(x / BUCKET);
  const bz = Math.floor(z / BUCKET);
  let best = Infinity;
  let e = BASE_LEVEL;
  // 近く（45m以内）を通るコースのうち最も低い標高。内回りと外回り・ダートが近くで高さの違う所を通るとき、
  // 高い方に合わせると低い方のコースが地面に埋もれるため、地面は低い方に合わせる
  let lowest = Infinity;
  for (let r = 0; r <= 3 && best === Infinity; r++) {
    for (let i = bx - r; i <= bx + r; i++) {
      for (let j = bz - r; j <= bz + r; j++) {
        for (const s of buckets.get(`${i},${j}`) ?? []) {
          const d = (s.x - x) ** 2 + (s.z - z) ** 2;
          if (d < best) {
            best = d;
            e = s.e;
          }
          if (d < 45 * 45 && s.e < lowest) lowest = s.e;
        }
      }
    }
  }
  e = Math.min(e, lowest);
  const d = Math.sqrt(best);
  const w = d === Infinity ? 0 : Math.max(0, Math.min(1, 1 - (d - 25) / 140));
  return e * w + BASE_LEVEL * (1 - w);
}

// ---------------------------------------------------------------- コース・ラチ

/** コースの帯（u の範囲 [from, to)）。across 分割して頂点色（傷み・刈り込み縞）を載せる */
function ribbon(
  course: Course,
  inner: number,
  outer: number,
  yOff: number,
  uvScale: number,
  across: number,
  color: (u: number, lane: number) => THREE.Color,
  from = 0,
  to = course.circumference,
): THREE.BufferGeometry {
  const len = to - from;
  const segs = Math.ceil(len / 2);
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = from + (i / segs) * len;
    for (let j = 0; j <= across; j++) {
      const lane = inner + ((outer - inner) * j) / across;
      const p = pointAt(course, u, lane);
      pos.push(p.x, p.y + yOff, p.z);
      uv.push(u / uvScale, lane / uvScale);
      const c = color(u, lane);
      col.push(c.r, c.g, c.b);
      if (i < segs && j < across) {
        const a = i * (across + 1) + j;
        const b = a + across + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (g.getAttribute('normal').getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** ラチ（u の範囲 [from, to]、閉じた周回なら from=0, to=周長） */
function railGeometry(course: Course, lane: number, from: number, to: number, h: number, r: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const closed = from === 0 && to >= course.circumference;
  const end = closed ? course.circumference - 3 : to;
  for (let u = from; u <= end; u += 3) {
    const p = pointAt(course, u, lane);
    pts.push(new THREE.Vector3(p.x, p.y + h, p.z));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed), pts.length * 2, r, 8, closed);
}

/** 人型（胴＋脚をカプセル、頭は別メッシュ）の観客。シェーダーで揺れと盛り上がりを付ける */
function crowdMaterial(uniforms: { uTime: { value: number }; uExcite: { value: number } }): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uExcite;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
         float sway = sin(uTime * (1.2 + ph * 1.5) + ph * 30.0) * 0.03;
         float jump = uExcite * max(0.0, sin(uTime * (5.0 + ph * 3.0) + ph * 20.0)) * (0.12 + 0.2 * ph);
         transformed.x += sway * position.y;
         transformed.y += jump;`,
      );
  };
  return m;
}

/** 外回りの外ラチで囲まれた範囲（内馬場・内回りとの間の空地を含む）。木や建物はここに置かない */
let OUTER_POLY: { x: number; z: number }[] = [];
function insideOuter(x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = OUTER_POLY.length - 1; i < OUTER_POLY.length; j = i++) {
    const a = OUTER_POLY[i];
    const b = OUTER_POLY[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** 最も外側の走路（外回りは共通区間を含むので、外回りの外側をたどればよい）の外 lane(m) の点 */
function outermost(i: number, n: number, lane: number) {
  return pointAt(OUTER, (i / n) * OUTER.circumference, OUTER.width + lane);
}

export class Environment {
  readonly group = new THREE.Group();
  /** カメラと馬の間に入りうる設備（看板・照明塔・木・建物・生垣・障害）。カメラの遮蔽判定に使う */
  readonly occluders: THREE.Object3D[] = [];
  readonly sun = new THREE.DirectionalLight('#fff4e0', 3);
  private fill = new THREE.DirectionalLight('#cfe0ff', 0);
  private hemi = new THREE.HemisphereLight('#bcd3e8', '#4a5a3a', 0.25);
  private sky = new Sky();
  private clouds: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private cloudData = cloudField(512, 256);
  private cloudTex: THREE.CanvasTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3(0.4, 0.7, 0.4).normalize();
  private turfMat: THREE.MeshStandardMaterial;
  private dirtMat: THREE.MeshStandardMaterial;
  private lampMat = new THREE.MeshStandardMaterial({ color: '#2a2d30', emissive: '#000000', roughness: 0.5 });
  private windowMat = new THREE.MeshStandardMaterial({ color: '#2a3542', emissive: '#000000', roughness: 0.15, metalness: 0.6 });
  private glows: THREE.Sprite[] = [];
  private board: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private crowdUniforms = { uTime: { value: 0 }, uExcite: { value: 0 } };
  private shadowRadius = 60;

  constructor(
    private scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private q: EnvQuality,
    readonly venue: VenueId = DEFAULT_VENUE,
  ) {
    configureVenue(venue);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    scene.add(this.group, this.sun, this.sun.target, this.fill, this.fill.target, this.hemi);
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    this.sun.castShadow = q.shadows;
    if (q.shadows) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.bias = -0.0002;
      this.sun.shadow.normalBias = 0.03;
      const s = this.sun.shadow.camera;
      s.near = 1;
      s.far = 1200;
    }

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.BackSide }),
    );
    scene.add(this.clouds);

    const rnd = seededRandom('venue:midorigahara');
    const big = q.level !== 'low';

    this.addTerrain(big);

    // ---- 芝コース（内回り＋外回りの独自区間） ----
    const turfTex = turfTextures(big ? 512 : 256);
    this.turfMat = new THREE.MeshStandardMaterial({ map: turfTex.map, normalMap: turfTex.normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.92, vertexColors: true });
    addMacroVariation(this.turfMat, 0.03, 0.12);
    const outerMat = this.turfMat.clone();
    outerMat.polygonOffset = true;
    outerMat.polygonOffsetFactor = -1;
    addMacroVariation(outerMat, 0.03, 0.12);
    const worn = new THREE.Color('#c9b88e');
    const tc = new THREE.Color();
    const turfColor = (u: number, lane: number) => {
      const stripe = Math.floor(u / 12) % 2 === 0 ? 1.05 : 0.95;
      const wear = Math.max(0, 1 - lane / 7) * (0.35 + 0.65 * fbm3(u * 0.05, lane * 0.4, 0, 3, 3));
      return tc.setScalar(stripe).lerp(worn, wear * 0.32);
    };
    const turf = new THREE.Mesh(ribbon(TURF, 0, TURF.width, 0.03, 8, big ? 12 : 6, turfColor), this.turfMat);
    turf.receiveShadow = true;
    this.group.add(turf);
    if (HAS_OUTER) {
      const outerTurf = new THREE.Mesh(ribbon(OUTER, 0, OUTER.width, 0.031, 8, big ? 12 : 6, turfColor, OUTER_FROM, OUTER_TO), outerMat);
      outerTurf.receiveShadow = true;
      this.group.add(outerTurf);
    }

    // ---- ダートコース ----
    const dirtTex = dirtTextures(big ? 512 : 256);
    this.dirtMat = new THREE.MeshStandardMaterial({ map: dirtTex.map, normalMap: dirtTex.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.95, vertexColors: true });
    addMacroVariation(this.dirtMat, 0.04, 0.1);
    const dirt = new THREE.Mesh(
      ribbon(DIRT, 0, DIRT.width, 0.04, 6, big ? 10 : 5, (u, lane) => tc.setScalar(0.94 + 0.12 * fbm3(u * 0.03, lane * 0.25, 1, 3, 9) - Math.max(0, 1 - lane / 4) * 0.06)),
      this.dirtMat,
    );
    dirt.receiveShadow = true;
    this.group.add(dirt);

    this.addRails(big);
    this.addFinish();
    this.addGrandstand(rnd);
    this.addCrowd(rnd);
    this.addTowers();
    this.addTrees(rnd);
    this.addHedges(big);
    this.addInfield(big);
    this.addSurroundings(rnd);

    // ターフビジョン（内馬場のホームストレッチ寄り。スタンドの主カメラから向正面を見る視線より低く置く。位置は推定）
    this.board = new THREE.Mesh(new THREE.PlaneGeometry(56, 15), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    const boardGroup = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: '#30353a', roughness: 0.6 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(58, 17, 1.2), frameMat);
    frame.position.set(0, 0, -0.7);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(2, 9, 2), frameMat);
    legs.position.set(0, -12, -1);
    boardGroup.add(this.board, frame, legs);
    const bx = -40 * HAND;
    const bz = FINISH.z - 68;
    const by = terrainHeight(bx, bz) + 13;
    boardGroup.scale.setScalar(0.85);
    boardGroup.position.set(bx, by, bz);
    boardGroup.lookAt(STAND_X, by, STAND_Z);
    this.group.add(boardGroup);
    this.occluders.push(boardGroup);
  }

  /** 起伏のある地面（コースの標高から補間） */
  private addTerrain(big: boolean) {
    const grass = grassTextures(big ? 256 : 128);
    grass.map.repeat.set(500, 500);
    grass.normal.repeat.set(500, 500);
    const groundMat = new THREE.MeshStandardMaterial({ map: grass.map, normalMap: grass.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95 });
    addMacroVariation(groundMat, 0.012, 0.22);
    // 近くは細かい格子で起伏を表し、遠くは大きな平面
    // 近くの地面は正方形にし、遠景の平面（リング）とすき間なく重なるようにする
    const W = 1700;
    const H = 1700;
    const seg = big ? 8 : 12;
    const geo = new THREE.PlaneGeometry(W, H, Math.round(W / seg), Math.round(H / seg));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // 縁は遠景の平面とつながるよう基準の高さへ
      const edge = Math.min(1, Math.max(Math.abs(x) / (W / 2), Math.abs(z) / (H / 2)));
      const h = terrainHeight(x, z);
      pos.setY(i, (edge > 0.92 ? BASE_LEVEL + (h - BASE_LEVEL) * (1 - edge) / 0.08 : h) - 0.25);
    }
    geo.computeVertexNormals();
    const near = new THREE.Mesh(geo, groundMat);
    near.receiveShadow = true;
    // 遠景の平面はコースのある範囲（半径700m）の外だけに置く。全面に敷くと、標高の低い区間で
    // コースより上に出て、馬が地面に沈んで見える
    const far = new THREE.Mesh(new THREE.RingGeometry(700, 4500, 64, 1), groundMat);
    far.rotation.x = -Math.PI / 2;
    far.position.y = BASE_LEVEL - 0.3;
    this.group.add(near, far);
  }

  private addRails(big: boolean) {
    const white = new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.35 });
    const postGeo = new THREE.CylinderGeometry(0.045, 0.05, 1.05, 6);
    postGeo.translate(0, 0.525, 0);
    const step = big ? 2.5 : 5;
    // [コース, レーン, 開始u, 終了u]：外回りが分かれる・合流する所は内回りの外ラチを開ける
    const rails: [Course, number, number, number][] = HAS_OUTER
      ? [
          [TURF, -0.4, 0, TURF.circumference],
          [TURF, TURF.width + 0.4, BRANCH_U + 70, JOIN_U - 70],
          [TURF, TURF.width + 0.4, JOIN_U + 5, TURF.circumference + BRANCH_U - 5],
          [OUTER, -0.4, OUTER_FROM + 80, OUTER_TO - 80],
          [OUTER, OUTER.width + 0.4, OUTER_FROM - 10, OUTER_TO + 10],
          [DIRT, -0.4, 0, DIRT.circumference],
          [DIRT, DIRT.width + 0.4, 0, DIRT.circumference],
        ]
      : [
          [TURF, -0.4, 0, TURF.circumference],
          [TURF, TURF.width + 0.4, 0, TURF.circumference],
          [DIRT, -0.4, 0, DIRT.circumference],
          [DIRT, DIRT.width + 0.4, 0, DIRT.circumference],
        ];
    for (const [course, lane, from, to] of rails) {
      this.group.add(new THREE.Mesh(railGeometry(course, lane, from, to, 1.05, 0.06), white));
      const n = Math.floor((to - from) / step);
      const posts = new THREE.InstancedMesh(postGeo, white, n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const p = pointAt(course, from + i * step, lane);
        posts.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      }
      this.group.add(posts);
    }
  }

  private addFinish() {
    const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    for (const course of [TURF, DIRT]) {
      const a = pointAt(course, course.finishU, 0);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.3, course.width), white);
      line.rotation.x = -Math.PI / 2;
      line.position.set(a.x, a.y + 0.06, a.z + course.width / 2);
      this.group.add(line);
    }
    const f = pointAt(TURF, TURF.finishU, -1.6);
    const metal = new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 4.4, 10), metal);
    post.position.set(f.x, f.y + 2.2, f.z);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.1, 32), new THREE.MeshStandardMaterial({ color: '#f5f5f2', roughness: 0.5 }));
    disc.rotation.x = Math.PI / 2;
    disc.position.set(f.x, f.y + 4.9, f.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.1, 10, 32), new THREE.MeshStandardMaterial({ color: '#b71c1c', roughness: 0.5 }));
    ring.position.copy(disc.position);
    this.group.add(post, disc, ring);
    // 審判台（ゴール板横のカメラの視界を遮らないよう外側に離す）
    const judge = new THREE.Mesh(new THREE.BoxGeometry(4, 9, 4), [metal, metal, metal, metal, this.windowMat, this.windowMat]);
    const jp = pointAt(TURF, TURF.finishU + 8, TURF.width + 19);
    judge.position.set(jp.x, jp.y + 4.5, jp.z);
    this.group.add(judge);
    this.occluders.push(judge);
    // ハロン棒（200mごと、内回りの内ラチ沿い）
    const pole = new THREE.MeshStandardMaterial({ map: poleTexture(), roughness: 0.5 });
    for (let d = 200; d < TURF.circumference; d += 200) {
      const p = pointAt(TURF, TURF.finishU - d, -1.3);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 8), pole);
      m.position.set(p.x, p.y + 1.3, p.z);
      this.group.add(m);
    }
  }

  private addGrandstand(rnd: () => number) {
    const concrete = new THREE.MeshStandardMaterial({ color: '#a6abaf', roughness: 0.9 });
    const darkConcrete = new THREE.MeshStandardMaterial({ color: '#5c6166', roughness: 0.9 });
    const seats = seatTexture();
    seats.repeat.set(STAND_HALF / 4, 3);
    const seatMat = new THREE.MeshStandardMaterial({ map: seats, roughness: 0.85 });
    const Y = STAND_BASE_Y - 0.2;
    const X = STAND_X;
    const tier = (z0: number, z1: number, y0: number, y1: number) => {
      const g = new THREE.PlaneGeometry(STAND_HALF * 2, Math.hypot(z1 - z0, y1 - y0));
      const m = new THREE.Mesh(g, seatMat);
      m.position.set(X, Y + (y0 + y1) / 2, (z0 + z1) / 2);
      m.rotation.x = -Math.PI / 2 + Math.atan2(y1 - y0, z1 - z0);
      m.receiveShadow = true;
      this.group.add(m);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, 1.4, 0.4), concrete);
      wall.position.set(X, Y + y0 + 0.5, z0 - 0.2);
      this.group.add(wall);
      const fillM = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, y1 - 0.5, z1 - z0), darkConcrete);
      fillM.position.set(X, Y + (y1 - 0.5) / 2, (z0 + z1) / 2 + 0.6);
      fillM.scale.y = 0.98;
      this.group.add(fillM);
    };
    tier(STAND_Z, STAND_Z + 16, 1.2, 8.5);
    tier(STAND_Z + 21, STAND_Z + 38, 12, 25);
    const concourse = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, 0.6, 5), concrete);
    concourse.position.set(X, Y + 9, STAND_Z + 18.5);
    const facade = facadeTexture();
    facade.repeat.set(16, 3);
    this.windowMat.map = facade;
    const building = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 30, 38, 20), [concrete, concrete, concrete, concrete, this.windowMat, concrete]);
    building.position.set(X, Y + 19, STAND_Z + 50);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 20, 0.8, 42), concrete);
    roof.position.set(X, Y + 36.5, STAND_Z + 26);
    roof.rotation.x = -0.035;
    roof.castShadow = this.q.shadows;
    this.group.add(concourse, building, roof);
    this.occluders.push(building, roof);
    const beamMat = new THREE.MeshStandardMaterial({ color: '#8d9399', roughness: 0.6, metalness: 0.3 });
    const beams: THREE.BufferGeometry[] = [];
    for (let x = -STAND_HALF; x <= STAND_HALF; x += 16) {
      const b = new THREE.BoxGeometry(0.6, 1.8, 40);
      b.translate(X + x, Y + 35.4, STAND_Z + 26);
      beams.push(b);
      const col = new THREE.BoxGeometry(1.2, 36, 1.2);
      col.translate(X + x, Y + 18, STAND_Z + 42);
      beams.push(col);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(beams), beamMat));
    for (const s of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.BoxGeometry(2, 30, 44), concrete);
      end.position.set(X + s * (STAND_HALF + 1), Y + 15, STAND_Z + 20);
      this.group.add(end);
      this.occluders.push(end);
    }
    // 前のエプロン（舗装）：コースの外ラチからスタンドまで
    const apronMat = new THREE.MeshStandardMaterial({ color: '#8f9396', roughness: 1 });
    addMacroVariation(apronMat, 0.05, 0.12);
    const apronDepth = STAND_Z - (FINISH.z + TURF.width + 2);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(STAND_HALF * 2 + 40, apronDepth), apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(X, Y + 0.05, STAND_Z - apronDepth / 2);
    apron.receiveShadow = true;
    this.group.add(apron);
    // パドック・付属棟（スタンドの裏・両脇。規模と配置は推定）
    for (let i = 0; i < 6; i++) {
      const w = 20 + rnd() * 30;
      const h = 8 + rnd() * 14;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 18), i % 2 ? concrete : darkConcrete);
      const side = i < 3 ? -1 : 1;
      const bx = X + side * (STAND_HALF + 40 + (i % 3) * 45);
      const bz = STAND_Z + 20 + rnd() * 20;
      b.position.set(bx, terrainHeight(bx, bz) + h / 2 - 0.3, bz);
      this.group.add(b);
      this.occluders.push(b);
    }
  }

  private addCrowd(rnd: () => number) {
    const n = this.q.crowd;
    const bodyGeo = new THREE.CapsuleGeometry(0.19, 0.62, 2, 6);
    bodyGeo.translate(0, 0.5, 0);
    const headGeo = new THREE.SphereGeometry(0.11, 7, 5);
    headGeo.translate(0, 1.18, 0);
    const bodies = new THREE.InstancedMesh(bodyGeo, crowdMaterial(this.crowdUniforms), n);
    const heads = new THREE.InstancedMesh(headGeo, crowdMaterial(this.crowdUniforms), n);
    const shirts = ['#e8e6e1', '#2d2f33', '#3c5a7d', '#7a2f2f', '#c8b27a', '#56704f', '#f0ece4', '#6a5a7a', '#c77a3a', '#1f3b5a', '#9aa3ab', '#b5463a'];
    const skins = ['#e0b896', '#c99a7a', '#a87656', '#f0cfb0', '#7d5236'];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const Y = STAND_BASE_Y - 0.2;
    for (let i = 0; i < n; i++) {
      const r = rnd();
      let x: number;
      let y: number;
      let z: number;
      let scale = 1;
      if (r < 0.5) {
        const t = rnd();
        x = STAND_X + (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 0.5 + t * 15;
        y = Y + 1.2 + (7.3 * (z - STAND_Z)) / 16 - 0.25;
        scale = 0.78;
      } else if (r < 0.75) {
        const t = rnd();
        x = STAND_X + (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 21.5 + t * 16;
        y = Y + 12 + (13 * (z - STAND_Z - 21)) / 17 - 0.25;
        scale = 0.78;
      } else {
        // エプロンの立ち見（ゴール前ほど密）
        x = rnd() < 0.6 ? FINISH.x + (rnd() - 0.5) * 120 : STAND_X + (rnd() * 2 - 1) * STAND_HALF;
        z = STAND_Z - 2 - rnd() * 14;
        y = Y + 0.05;
      }
      s.set(scale * (0.9 + rnd() * 0.2), scale * (0.9 + rnd() * 0.25), scale);
      q.setFromAxisAngle(yAxis, Math.PI + (rnd() - 0.5) * 0.8);
      m.compose(new THREE.Vector3(x, y, z), q, s);
      bodies.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      bodies.setColorAt(i, c.set(shirts[Math.floor(rnd() * shirts.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.1));
      heads.setColorAt(i, c.set(skins[Math.floor(rnd() * skins.length)]));
    }
    this.group.add(bodies, heads);
  }

  /** 照明塔（最も外側の走路のさらに外） */
  private addTowers() {
    const steel = new THREE.MeshStandardMaterial({ color: '#7b838a', metalness: 0.5, roughness: 0.5 });
    const glow = glowSprite();
    const N = 14;
    for (let i = 0; i < N; i++) {
      const p = outermost(i, N, 45);
      if (p.z > STAND_Z - 40 && Math.abs(p.x - STAND_X) < STAND_HALF + 20) continue;
      const base = terrainHeight(p.x, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.2, 50, 8), steel);
      pole.position.set(p.x, base + 25, p.z);
      const head = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 1.0), this.lampMat);
      head.position.set(p.x, base + 51, p.z);
      head.lookAt(0, 0, 0);
      this.group.add(pole, head);
      this.occluders.push(pole, head);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#fff6e0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      const inward = new THREE.Vector3(-p.x, 0, -p.z).normalize().multiplyScalar(1.5);
      sp.position.set(p.x + inward.x, base + 51, p.z + inward.z);
      sp.scale.set(26, 18, 1);
      this.glows.push(sp);
      this.group.add(sp);
    }
  }

  /** 木立（コースの外周に帯状に）。樹冠はノイズで凹凸をつけた形を数種類 */
  private addTrees(rnd: () => number) {
    const variants: THREE.BufferGeometry[] = [];
    for (let v = 0; v < 3; v++) {
      const parts: THREE.BufferGeometry[] = [];
      for (let b = 0; b < 3 + v; b++) {
        const g = new THREE.IcosahedronGeometry(1, 2);
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const k = 0.75 + 0.45 * noise3(x * 1.7 + b * 3 + v * 7, y * 1.7, z * 1.7, 13);
          pos.setXYZ(i, x * k, y * k * 0.85, z * k);
        }
        const sc = 2.2 + rnd() * 1.6;
        g.scale(sc, sc, sc);
        g.translate((rnd() - 0.5) * 3, 5.5 + rnd() * 3.5, (rnd() - 0.5) * 3);
        parts.push(g);
      }
      const merged = mergeGeometries(parts);
      merged.computeVertexNormals();
      variants.push(merged);
    }
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 6, 6);
    trunkGeo.translate(0, 3, 0);
    // 空からの環境光を受ける材質にする（逆光で真っ黒なシルエットにならないように）
    const leafMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#6e5c4b', roughness: 1 });
    const per = Math.ceil(this.q.trees / 3);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, per * 3);
    let ti = 0;
    const greens = ['#3d6b35', '#45753a', '#34592f', '#557d40', '#2f5130'];
    variants.forEach((geo) => {
      const inst = new THREE.InstancedMesh(geo, leafMat, per);
      for (let i = 0; i < per; i++) {
        let x = 0;
        let z = 0;
        for (let tries = 0; tries < 30; tries++) {
          const p = outermost(Math.floor(rnd() * 1000), 1000, 25 + rnd() * 90);
          x = p.x + (rnd() - 0.5) * 20;
          z = p.z + (rnd() - 0.5) * 20;
          const nearStand = z > STAND_Z - 30 && Math.abs(x - STAND_X) < STAND_HALF + 160;
          if (!nearStand && !insideOuter(x, z)) break;
        }
        const s = 0.7 + rnd() * 0.9;
        m.makeRotationY(rnd() * Math.PI * 2).scale(new THREE.Vector3(s, s * (0.9 + rnd() * 0.4), s)).setPosition(x, terrainHeight(x, z) - 0.3, z);
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, c.set(greens[Math.floor(rnd() * greens.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.06));
        trunks.setMatrixAt(ti++, m);
      }
      inst.castShadow = this.q.level === 'high';
      this.group.add(inst);
    this.occluders.push(inst);
      this.occluders.push(inst);
    });
    this.group.add(trunks);
    this.occluders.push(trunks);
  }

  private addHedges(big: boolean) {
    const tex = hedgeTexture();
    tex.repeat.set(2, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    const geo = new THREE.BoxGeometry(2.6, 1.3, 1.0);
    geo.translate(0, 0.65, 0);
    const step = big ? 2.5 : 5;
    const n = Math.floor(OUTER.circumference / step);
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = pointAt(OUTER, i * step, OUTER.width + 2.2);
      if (p.z > FINISH.z && Math.abs(p.x - STAND_X) < STAND_HALF + 10) continue; // スタンド前は開ける
      m.makeRotationY(-p.heading).setPosition(p.x, p.y, p.z);
      inst.setMatrixAt(k++, m);
    }
    inst.count = k;
    this.group.add(inst);
  }

  /**
   * 内馬場：障害コース（周回コースと、内馬場を斜めに横切る「襷」）と障害（生垣・竹柵）。
   * 公式の障害コースは1周 1,456.4m だが、このモデルではダートの内側に収めるため短い（約1,250m）。
   * 形・障害の位置はすべて推定。
   */
  private addInfield(big: boolean) {
    const R = DIRT.radius - 32;
    // ダートの直線より短く（札幌のように直線の短い場でもダートの内側に収める）
    const L = Math.min(360, (DIRT.circumference - 2 * Math.PI * DIRT.radius) / 2 - 40);
    const width = 20;
    const hurdleMat = new THREE.MeshStandardMaterial({ map: this.turfMat.map, normalMap: this.turfMat.normalMap, roughness: 0.95, color: '#d7e3cf' });
    addMacroVariation(hurdleMat, 0.03, 0.15);
    const pts: { x: number; z: number; h: number }[] = [];
    const ringPoint = (s: number) => {
      // ダートの内側に収まる楕円（直線 L、半径 R）。s は周回上の距離
      const C = 2 * L + 2 * Math.PI * R;
      const u = ((s % C) + C) % C;
      if (u < L) return { x: L / 2 - u, z: R, h: Math.PI };
      if (u < L + Math.PI * R) {
        const a = Math.PI / 2 + (u - L) / R;
        return { x: -L / 2 + Math.cos(a) * R, z: Math.sin(a) * R, h: a + Math.PI / 2 };
      }
      if (u < 2 * L + Math.PI * R) return { x: -L / 2 + (u - L - Math.PI * R), z: -R, h: 0 };
      const a = -Math.PI / 2 + (u - 2 * L - Math.PI * R) / R;
      return { x: L / 2 + Math.cos(a) * R, z: Math.sin(a) * R, h: a + Math.PI / 2 };
    };
    const C = 2 * L + 2 * Math.PI * R;
    for (let s = 0; s <= C; s += 3) pts.push(ringPoint(s));
    // 周回コースの帯
    const pos: number[] = [];
    const idx: number[] = [];
    pts.forEach((p, i) => {
      const nx = Math.sin(p.h);
      const nz = -Math.cos(p.h);
      for (const lane of [0, width]) {
        const x = p.x + nx * lane;
        const z = p.z + nz * lane;
        pos.push(x, terrainHeight(x, z) - 0.18, z);
      }
      if (i < pts.length - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ring = new THREE.Mesh(g, hurdleMat);
    ring.material.side = THREE.DoubleSide;
    ring.receiveShadow = true;
    this.group.add(ring);
    // 襷（内馬場を斜めに横切る走路）
    const a = { x: -L / 2 - R * 0.4, z: R * 0.55 };
    const b = { x: L / 2 + R * 0.4, z: -R * 0.55 };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const diag = new THREE.Mesh(new THREE.PlaneGeometry(len, 18, Math.ceil(len / 10), 1), hurdleMat);
    diag.rotation.x = -Math.PI / 2;
    diag.rotation.z = -Math.atan2(dz, dx);
    diag.position.set((a.x + b.x) / 2, terrainHeight((a.x + b.x) / 2, (a.z + b.z) / 2) - 0.17, (a.z + b.z) / 2);
    this.group.add(diag);

    // 障害：生垣（周回の直線に数か所）、襷の上に大きな生垣と竹柵（位置は推定）
    const hedgeMat = new THREE.MeshStandardMaterial({ map: hedgeTexture(), roughness: 1 });
    const bambooMat = new THREE.MeshStandardMaterial({ color: '#9a8a55', roughness: 0.8 });
    const hedge = (x: number, z: number, heading: number, h: number, w: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, h, w), hedgeMat);
      m.position.set(x, terrainHeight(x, z) - 0.2 + h / 2, z);
      m.rotation.y = -heading;
      m.castShadow = this.q.shadows;
      this.group.add(m);
      this.occluders.push(m);
    };
    for (const s of [L * 0.3, L * 0.75, L + Math.PI * R + L * 0.25, L + Math.PI * R + L * 0.7]) {
      const p = ringPoint(s);
      const nx = Math.sin(p.h);
      const nz = -Math.cos(p.h);
      hedge(p.x + nx * width * 0.5, p.z + nz * width * 0.5, p.h, 1.4, width);
    }
    const dh = Math.atan2(dz, dx);
    hedge(a.x + dx * 0.35, a.z + dz * 0.35, dh, 1.6, 18); // 大きな生垣（推定）
    // 竹柵：細い竹を並べる
    const fx = a.x + dx * 0.65;
    const fz = a.z + dz * 0.65;
    const count = big ? 90 : 40;
    const bamboo = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.04, 1.6, 5).translate(0, 0.8, 0), bambooMat, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const t = (i / (count - 1) - 0.5) * 18;
      const x = fx - Math.sin(dh) * t + Math.cos(dh) * (i % 3) * 0.15;
      const z = fz + Math.cos(dh) * t + Math.sin(dh) * (i % 3) * 0.15;
      bamboo.setMatrixAt(i, m.makeTranslation(x, terrainHeight(x, z) - 0.2, z));
    }
    this.group.add(bamboo);
    this.occluders.push(bamboo);
  }

  /** 周辺：住宅地（低層の家並み）と中層の建物。遠くは霧で霞む（配置は推定） */
  private addSurroundings(rnd: () => number) {
    const houses: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const flats: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 520; i++) {
      const p = outermost(Math.floor(rnd() * 1000), 1000, 150 + rnd() * 420);
      const x = p.x + (rnd() - 0.5) * 40;
      const z = p.z + (rnd() - 0.5) * 40;
      if (z > STAND_Z - 10 && Math.abs(x - STAND_X) < STAND_HALF + 220 && z < STAND_Z + 160) continue;
      if (insideOuter(x, z)) continue;
      const base = terrainHeight(x, z) - 0.3;
      if (rnd() < 0.85) {
        const w = 7 + rnd() * 5;
        const d = 7 + rnd() * 4;
        const h = 5 + rnd() * 2.5;
        const rot = rnd() * Math.PI;
        const body = new THREE.BoxGeometry(w, h, d).rotateY(rot).translate(x, base + h / 2, z);
        houses.push(body);
        const roof = new THREE.ConeGeometry(Math.max(w, d) * 0.72, 2.2, 4).rotateY(Math.PI / 4 + rot).translate(x, base + h + 1.1, z);
        roofs.push(roof);
      } else {
        const w = 18 + rnd() * 25;
        const h = 12 + rnd() * 25;
        flats.push(new THREE.BoxGeometry(w, h, 12 + rnd() * 8).rotateY(rnd() * Math.PI).translate(x, base + h / 2, z));
      }
    }
    if (houses.length) this.group.add(new THREE.Mesh(mergeGeometries(houses), new THREE.MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.95 })));
    if (roofs.length) this.group.add(new THREE.Mesh(mergeGeometries(roofs), new THREE.MeshStandardMaterial({ color: '#5a5e66', roughness: 0.8 })));
    if (flats.length) this.group.add(new THREE.Mesh(mergeGeometries(flats), new THREE.MeshStandardMaterial({ color: '#b8bcc0', roughness: 0.9 })));
    // 遠景の街並み（平野の地平線）
    const town: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 160; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 1400 + rnd() * 900;
      const h = 8 + rnd() * rnd() * 60;
      town.push(new THREE.BoxGeometry(20 + rnd() * 40, h, 20 + rnd() * 30).translate(Math.cos(a) * r, BASE_LEVEL + h / 2, Math.sin(a) * r));
    }
    this.group.add(new THREE.Mesh(mergeGeometries(town), new THREE.MeshLambertMaterial({ color: '#a4abb2' })));
  }

  /** 天候・時間帯・馬場に合わせて空・光・霧・質感を切り替える */
  applyConditions(weather: Weather, timeOfDay: TimeOfDay, going: Going, boardLines: string[]) {
    const wet = going === 'soft' || going === 'heavy';
    const overcast = weather === 'rain' || weather === 'snow' ? 1 : weather === 'drizzle' || weather === 'lightsnow' ? 0.8 : weather === 'cloudy' ? 0.55 : 0.15;
    const u = this.sky.material.uniforms;
    let elevation: number;
    let azimuth: number;
    let fogColor: string;
    let fogDensity: number;
    let sunColor: string;
    let sunI: number;
    let envI: number;
    let cloudTint: string;
    if (timeOfDay === 'night') {
      elevation = -6;
      azimuth = 200;
      u.turbidity.value = 2;
      u.rayleigh.value = 0.2;
      fogColor = '#0d1522';
      fogDensity = 0.0007;
      sunColor = '#e6eeff';
      sunI = 2.6;
      envI = 0.12;
      cloudTint = '#2a3240';
    } else if (timeOfDay === 'dusk') {
      elevation = 4;
      azimuth = 245;
      u.turbidity.value = 5 + overcast * 6;
      u.rayleigh.value = 2.4 - overcast;
      fogColor = '#c49a7a';
      fogDensity = 0.00045 + overcast * 0.0004;
      sunColor = '#ffb27a';
      sunI = 2.4 * (1 - overcast * 0.6);
      envI = 0.75;
      cloudTint = '#e7b08f';
    } else {
      elevation = 36;
      azimuth = 205;
      u.turbidity.value = 3 + overcast * 14;
      u.rayleigh.value = 1.3 - overcast * 0.9;
      fogColor = overcast > 0.7 ? '#9aa3aa' : overcast > 0.4 ? '#b6c2cb' : '#c5d6e2';
      fogDensity = 0.00028 + overcast * 0.0007;
      sunColor = overcast > 0.5 ? '#eef1f3' : '#fff2df';
      sunI = 3.4 * (1 - overcast * 0.75);
      envI = 1.0;
      cloudTint = overcast > 0.7 ? '#a7adb2' : '#f4f6f8';
    }
    u.mieCoefficient.value = 0.004 + overcast * 0.01;
    u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);

    this.cloudTex = cloudTexture(this.cloudData, 512, 256, overcast, cloudTint, this.cloudTex ?? undefined);
    this.clouds.material.map = this.cloudTex;
    this.clouds.material.needsUpdate = true;

    // 空から環境光（IBL）を作る
    const envScene = new THREE.Scene();
    const skyClone = new Sky();
    skyClone.scale.setScalar(1000);
    skyClone.material.uniforms = THREE.UniformsUtils.clone(u);
    envScene.add(skyClone);
    if (timeOfDay === 'night') envScene.background = new THREE.Color('#0a1220');
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02, 1, 3000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = envI * (1 - overcast * 0.25);
    skyClone.geometry.dispose();
    skyClone.material.dispose();
    this.scene.background = timeOfDay === 'night' ? new THREE.Color('#070c16') : null;
    this.sky.visible = timeOfDay !== 'night';
    this.scene.fog = new THREE.FogExp2(fogColor, fogDensity);

    if (timeOfDay === 'night') {
      // 夜はスタンド上の照明塔を主光源に
      this.sunDir.set(0.15, 0.75, 0.65).normalize();
      this.fill.intensity = 0.9;
      this.fill.position.set(-200, 260, -300);
      this.hemi.intensity = 0.35;
      this.hemi.color.set('#9fb3cc');
    } else {
      this.fill.intensity = 0;
      this.hemi.intensity = 0.15 + overcast * 0.25;
      this.hemi.color.set(fogColor);
    }
    this.sun.color.set(sunColor);
    this.sun.intensity = sunI;
    this.focusShadow(0, FINISH.z, this.shadowRadius);

    const lit = timeOfDay !== 'day';
    this.lampMat.emissive.set(lit ? '#fff6e6' : '#000000');
    this.lampMat.emissiveIntensity = lit ? 3 : 0;
    this.glows.forEach((g) => (g.material.opacity = timeOfDay === 'night' ? 0.28 : timeOfDay === 'dusk' ? 0.12 : 0));
    this.windowMat.emissive.set(timeOfDay === 'night' ? '#e8c27a' : timeOfDay === 'dusk' ? '#5a4a30' : '#000000');
    this.windowMat.emissiveIntensity = timeOfDay === 'night' ? 0.6 : 0.3;

    this.turfMat.color.set(wet ? '#b9c6b0' : going === 'yielding' ? '#e4ebdf' : '#ffffff');
    this.turfMat.roughness = wet ? 0.7 : 0.92;
    this.dirtMat.color.set(wet ? '#866a52' : going === 'yielding' ? '#cdb9a2' : '#ffffff');
    this.dirtMat.roughness = wet ? 0.62 : going === 'yielding' ? 0.82 : 0.95;

    this.board.material.map?.dispose();
    this.board.material.map = boardTexture(boardLines);
    this.board.material.needsUpdate = true;
  }

  /** 影の範囲を注目地点の周りに限定する（radius は画角から決める） */
  focusShadow(x: number, z: number, radius = this.shadowRadius) {
    this.shadowRadius = radius;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 500, this.sunDir.y * 500, z + this.sunDir.z * 500);
    if (this.sun.castShadow) {
      const s = this.sun.shadow.camera;
      const r = Math.max(25, Math.min(160, radius));
      if (Math.abs(s.right - r) > 2) {
        s.left = s.bottom = -r;
        s.right = s.top = r;
        s.updateProjectionMatrix();
      }
    }
    this.fill.target.position.set(x, 0, z);
  }

  setShadows(on: boolean) {
    this.sun.castShadow = on && this.q.shadows;
  }

  /** 観客の盛り上がり（0〜1）と時間 */
  update(time: number, excitement: number) {
    this.crowdUniforms.uTime.value = time;
    this.crowdUniforms.uExcite.value += (excitement - this.crowdUniforms.uExcite.value) * 0.05;
    this.clouds.rotation.y = time * 0.002;
  }

  /** 競馬場を切り替えるとき：この環境が加えたものだけを取り除いて解放する（馬などは残す） */
  detach() {
    const own: THREE.Object3D[] = [this.group, this.sun, this.sun.target, this.fill, this.fill.target, this.hemi, this.sky, this.clouds];
    for (const o of own) {
      this.scene.remove(o);
      o.traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const mat of mats) {
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
          mat.dispose();
        }
      });
    }
    this.envRT?.dispose();
    this.pmrem.dispose();
  }

  dispose() {
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
  }
}
