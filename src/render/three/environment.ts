/**
 * 架空の「翠ヶ原競馬場」の環境。実在の競馬場の写しではなく、一般的な競馬場の構成
 * （芝の外回り・ダートの内回り・2層スタンド・内馬場の池と大型ビジョン）を参考にしたオリジナル。
 *
 * - 空：物理ベースの空（Preetham）＋雲の層。空から環境光（IBL）を作り、自然な陰影にする
 * - 地面：芝・ダート・芝生は色と法線のテクスチャに加え、世界座標のノイズで場所ごとの色ムラを付ける
 * - 芝は内ラチ沿いの傷みと刈り込みの縞、ダートはハロー掛けの筋
 * - スタンド：2層の座席・屋根・ガラス張りの建物。観客は人型のインスタンスで、ゴール前で盛り上がる
 * - 背景：木立・生垣・遠景の稜線と街並み（霧で遠くほど霞む）
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Going, TimeOfDay, Weather } from '../../core/sim';
import { COURSES, type Course, pointAt } from '../../core/track';
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

const TURF = COURSES.turf;
const DIRT = COURSES.dirt;
/** スタンド前面（ホームストレッチ外側）の z 座標 */
export const STAND_Z = TURF.radius + TURF.width + 22;
const STAND_HALF = 190;

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

/** コースの帯を作る。across 分割して頂点色（傷み・刈り込み縞）を載せる */
function ribbon(course: Course, inner: number, outer: number, y: number, uvScale: number, across: number, color: (u: number, lane: number) => THREE.Color): THREE.BufferGeometry {
  const segs = Math.ceil(course.circumference / 2);
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = (i / segs) * course.circumference;
    for (let j = 0; j <= across; j++) {
      const lane = inner + ((outer - inner) * j) / across;
      const p = pointAt(course, u, lane);
      pos.push(p.x, y, p.z);
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
  // 上向きでなければ反転
  const n = g.getAttribute('normal');
  if (n.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

function railGeometry(course: Course, lane: number, h: number, r: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let u = 0; u < course.circumference; u += 3) {
    const p = pointAt(course, u, lane);
    pts.push(new THREE.Vector3(p.x, h, p.z));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), pts.length * 2, r, 8, true);
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

export class Environment {
  readonly group = new THREE.Group();
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
  ) {
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

    // 雲（上半球のドーム）
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.BackSide }),
    );
    scene.add(this.clouds);

    const rnd = seededRandom('venue:midorigahara');
    const big = q.level !== 'low';

    // ---- 地面（コース外の芝生） ----
    const grass = grassTextures(big ? 256 : 128);
    grass.map.repeat.set(500, 500);
    grass.normal.repeat.set(500, 500);
    const groundMat = new THREE.MeshStandardMaterial({ map: grass.map, normalMap: grass.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95 });
    addMacroVariation(groundMat, 0.012, 0.22);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.25;
    ground.receiveShadow = true;
    this.group.add(ground);

    // ---- 芝コース（内ラチ沿いの傷み・刈り込みの縞） ----
    const turfTex = turfTextures(big ? 512 : 256);
    this.turfMat = new THREE.MeshStandardMaterial({ map: turfTex.map, normalMap: turfTex.normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.92, vertexColors: true });
    addMacroVariation(this.turfMat, 0.03, 0.12);
    const worn = new THREE.Color('#c9b88e');
    const tc = new THREE.Color();
    const turf = new THREE.Mesh(
      ribbon(TURF, 0, TURF.width, 0.03, 8, big ? 12 : 6, (u, lane) => {
        const stripe = Math.floor(u / 12) % 2 === 0 ? 1.05 : 0.95;
        const wear = Math.max(0, 1 - lane / 7) * (0.35 + 0.65 * fbm3(u * 0.05, lane * 0.4, 0, 3, 3));
        return tc.setScalar(stripe).lerp(worn, wear * 0.32);
      }),
      this.turfMat,
    );
    turf.receiveShadow = true;
    this.group.add(turf);

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
    this.addInfield();
    this.addBackground(rnd);

    // 大型ビジョン（スタンドに向ける）
    this.board = new THREE.Mesh(new THREE.PlaneGeometry(44, 15), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    // 1コーナー寄りの内馬場に置き、スタンドへ向ける（向こう正面への視線を遮らない）
    const boardGroup = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: '#30353a', roughness: 0.6 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(46, 17, 1.2), frameMat);
    frame.position.set(0, 0, -0.7);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), frameMat);
    legs.position.set(0, -11.5, -1);
    boardGroup.add(this.board, frame, legs);
    boardGroup.position.set(300, 15, 0);
    boardGroup.lookAt(0, 15, STAND_Z);
    this.group.add(boardGroup);
  }

  private addRails(big: boolean) {
    const white = new THREE.MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.35 });
    const postGeo = new THREE.CylinderGeometry(0.045, 0.05, 1.05, 6);
    postGeo.translate(0, 0.525, 0);
    const step = big ? 2.5 : 5;
    for (const [course, lane] of [
      [TURF, -0.4],
      [TURF, TURF.width + 0.4],
      [DIRT, -0.4],
      [DIRT, DIRT.width + 0.4],
    ] as [Course, number][]) {
      this.group.add(new THREE.Mesh(railGeometry(course, lane, 1.05, 0.06), white));
      const n = Math.floor(course.circumference / step);
      const posts = new THREE.InstancedMesh(postGeo, white, n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const p = pointAt(course, i * step, lane);
        posts.setMatrixAt(i, m.makeTranslation(p.x, 0, p.z));
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
      line.position.set(a.x, 0.06, a.z + course.width / 2);
      this.group.add(line);
    }
    const f = pointAt(TURF, TURF.finishU, -1.6);
    const metal = new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 4.4, 10), metal);
    post.position.set(f.x, 2.2, f.z);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.1, 32), new THREE.MeshStandardMaterial({ color: '#f5f5f2', roughness: 0.5 }));
    disc.rotation.x = Math.PI / 2;
    disc.position.set(f.x, 4.9, f.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.1, 10, 32), new THREE.MeshStandardMaterial({ color: '#b71c1c', roughness: 0.5 }));
    ring.position.copy(disc.position);
    this.group.add(post, disc, ring);
    // 審判台（ゴール前の外側）
    const judge = new THREE.Mesh(new THREE.BoxGeometry(4, 9, 4), [metal, metal, metal, metal, this.windowMat, this.windowMat]);
    // ゴール板横のカメラの視界を遮らないよう、外側に離して置く
    const jp = pointAt(TURF, TURF.finishU - 8, TURF.width + 19);
    judge.position.set(jp.x, 4.5, jp.z);
    this.group.add(judge);
    // ハロン棒（200mごと）
    const pole = new THREE.MeshStandardMaterial({ map: poleTexture(), roughness: 0.5 });
    for (let d = 200; d < TURF.circumference; d += 200) {
      const p = pointAt(TURF, TURF.finishU - d, -1.3);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 8), pole);
      m.position.set(p.x, 1.3, p.z);
      this.group.add(m);
    }
  }

  private addGrandstand(rnd: () => number) {
    const concrete = new THREE.MeshStandardMaterial({ color: '#a6abaf', roughness: 0.9 });
    const darkConcrete = new THREE.MeshStandardMaterial({ color: '#5c6166', roughness: 0.9 });
    const seats = seatTexture();
    seats.repeat.set(STAND_HALF / 4, 3);
    const seatMat = new THREE.MeshStandardMaterial({ map: seats, roughness: 0.85 });
    // 傾斜した座席面（下層・上層）
    const tier = (z0: number, z1: number, y0: number, y1: number) => {
      const g = new THREE.PlaneGeometry(STAND_HALF * 2, Math.hypot(z1 - z0, y1 - y0));
      const m = new THREE.Mesh(g, seatMat);
      m.position.set(0, (y0 + y1) / 2, (z0 + z1) / 2);
      m.rotation.x = -Math.PI / 2 + Math.atan2(y1 - y0, z1 - z0);
      m.receiveShadow = true;
      this.group.add(m);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, 1.4, 0.4), concrete);
      wall.position.set(0, y0 + 0.5, z0 - 0.2);
      this.group.add(wall);
      // 座席面の下を埋める（横から見て浮かないように）
      const fillG = new THREE.BoxGeometry(STAND_HALF * 2, y1 - 0.5, z1 - z0);
      const fillM = new THREE.Mesh(fillG, darkConcrete);
      fillM.position.set(0, (y1 - 0.5) / 2, (z0 + z1) / 2 + 0.6);
      fillM.scale.y = 0.98;
      this.group.add(fillM);
    };
    tier(STAND_Z, STAND_Z + 16, 1.2, 8.5); // 下層
    tier(STAND_Z + 21, STAND_Z + 38, 12, 25); // 上層
    const concourse = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2, 0.6, 5), concrete);
    concourse.position.set(0, 9, STAND_Z + 18.5);
    // 背面のガラス張りの建物
    const facade = facadeTexture();
    facade.repeat.set(16, 3);
    this.windowMat.map = facade;
    const building = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 30, 38, 20), [concrete, concrete, concrete, concrete, this.windowMat, concrete]);
    building.position.set(0, 19, STAND_Z + 50);
    // 屋根（片持ち）と梁・柱
    const roof = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 20, 0.8, 42), concrete);
    roof.position.set(0, 36.5, STAND_Z + 26);
    roof.rotation.x = -0.035;
    roof.castShadow = this.q.shadows;
    this.group.add(concourse, building, roof);
    const beamMat = new THREE.MeshStandardMaterial({ color: '#8d9399', roughness: 0.6, metalness: 0.3 });
    const beams: THREE.BufferGeometry[] = [];
    for (let x = -STAND_HALF; x <= STAND_HALF; x += 16) {
      const b = new THREE.BoxGeometry(0.6, 1.8, 40);
      b.translate(x, 35.4, STAND_Z + 26);
      beams.push(b);
      const col = new THREE.BoxGeometry(1.2, 36, 1.2);
      col.translate(x, 18, STAND_Z + 42);
      beams.push(col);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(beams), beamMat));
    for (const s of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.BoxGeometry(2, 30, 44), concrete);
      end.position.set(s * (STAND_HALF + 1), 15, STAND_Z + 20);
      this.group.add(end);
    }
    // 前のエプロン（舗装）
    const apronMat = new THREE.MeshStandardMaterial({ color: '#8f9396', roughness: 1 });
    addMacroVariation(apronMat, 0.05, 0.12);
    const apronDepth = STAND_Z - (TURF.radius + TURF.width + 2);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(STAND_HALF * 2 + 40, apronDepth), apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.02, STAND_Z - apronDepth / 2);
    apron.receiveShadow = true;
    this.group.add(apron);
    // パドック側の建物群（スタンドの両脇）
    for (let i = 0; i < 6; i++) {
      const w = 20 + rnd() * 30;
      const h = 8 + rnd() * 14;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 18), i % 2 ? concrete : darkConcrete);
      const side = i < 3 ? -1 : 1;
      b.position.set(side * (STAND_HALF + 40 + (i % 3) * 45), h / 2, STAND_Z + 20 + rnd() * 20);
      this.group.add(b);
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
    for (let i = 0; i < n; i++) {
      const r = rnd();
      let x: number;
      let y: number;
      let z: number;
      let scale = 1;
      if (r < 0.5) {
        const t = rnd();
        x = (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 0.5 + t * 15;
        y = 1.2 + (7.3 * (z - STAND_Z)) / 16 - 0.25;
        scale = 0.78;
      } else if (r < 0.75) {
        const t = rnd();
        x = (rnd() * 2 - 1) * (STAND_HALF - 2);
        z = STAND_Z + 21.5 + t * 16;
        y = 12 + (13 * (z - STAND_Z - 21)) / 17 - 0.25;
        scale = 0.78;
      } else {
        // エプロンの立ち見（ゴール前ほど密）
        x = rnd() < 0.6 ? (rnd() - 0.5) * 120 + 60 : (rnd() * 2 - 1) * STAND_HALF;
        z = STAND_Z - 2 - rnd() * 14;
        y = 0;
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

  private addTowers() {
    const steel = new THREE.MeshStandardMaterial({ color: '#7b838a', metalness: 0.5, roughness: 0.5 });
    const glow = glowSprite();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = Math.cos(a) * (TURF.straight / 2 + TURF.radius + 45);
      const z = Math.sin(a) * (TURF.radius + 45);
      if (z > STAND_Z - 30 && Math.abs(x) < STAND_HALF) continue;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.2, 50, 8), steel);
      pole.position.set(x, 25, z);
      const head = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 1.0), this.lampMat);
      head.position.set(x, 51, z);
      head.lookAt(0, 0, 0);
      this.group.add(pole, head);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: '#fff6e0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      const inward = new THREE.Vector3(-x, 0, -z).normalize().multiplyScalar(1.5);
      sp.position.set(x + inward.x, 51, z + inward.z);
      sp.scale.set(26, 18, 1);
      this.glows.push(sp);
      this.group.add(sp);
    }
  }

  /** 木立：ノイズで凹凸をつけた樹冠を数種類作り、インスタンスで配置 */
  private addTrees(rnd: () => number) {
    const variants: THREE.BufferGeometry[] = [];
    for (let v = 0; v < 3; v++) {
      const parts: THREE.BufferGeometry[] = [];
      const blobs = 3 + v;
      for (let b = 0; b < blobs; b++) {
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
    const leafMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const trunkMat = new THREE.MeshLambertMaterial({ color: '#6e5c4b' });
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
          {
            // 外周の林だけに置く（内馬場はスタンドからの視線を遮らないよう空けておく）
            const a = rnd() * Math.PI * 2;
            const r = 1.05 + rnd() * 0.8;
            x = Math.cos(a) * (TURF.straight / 2 + TURF.radius + 70) * r;
            z = Math.sin(a) * (TURF.radius + 75) * r;
          }
          const nearStand = z > STAND_Z - 30 && Math.abs(x) < STAND_HALF + 160;
          const inPond = Math.abs(z - 30) < 46 && Math.abs(x + 40) < 120;
          const nearBoard = Math.abs(x - 300) < 35 && Math.abs(z) < 25;
          if (!nearStand && !inPond && !nearBoard && !this.onTrack(x, z)) break;
        }
        const s = 0.7 + rnd() * 0.9;
        m.makeRotationY(rnd() * Math.PI * 2).scale(new THREE.Vector3(s, s * (0.9 + rnd() * 0.4), s)).setPosition(x, 0, z);
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, c.set(greens[Math.floor(rnd() * greens.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.06));
        trunks.setMatrixAt(ti++, m);
      }
      inst.castShadow = this.q.level === 'high';
      this.group.add(inst);
    });
    this.group.add(trunks);
  }

  /** コース上（ラチの内外数m）に木を置かない */
  private onTrack(x: number, z: number): boolean {
    const L = TURF.straight / 2;
    const dx = Math.max(0, Math.abs(x) - L);
    const r = Math.hypot(dx, z);
    return r > DIRT.radius - 15 && r < TURF.radius + TURF.width + 20;
  }

  private addHedges(big: boolean) {
    const tex = hedgeTexture();
    tex.repeat.set(2, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    const geo = new THREE.BoxGeometry(2.6, 1.3, 1.0);
    geo.translate(0, 0.65, 0);
    const step = big ? 2.5 : 5;
    const n = Math.floor(TURF.circumference / step);
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = pointAt(TURF, i * step, TURF.width + 2.2);
      if (p.z > TURF.radius && Math.abs(p.x) < STAND_HALF + 10) continue; // スタンド前は開ける
      m.makeRotationY(-p.heading).setPosition(p.x, 0, p.z);
      inst.setMatrixAt(k++, m);
    }
    inst.count = k;
    this.group.add(inst);
  }

  private addInfield() {
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshStandardMaterial({ color: '#16303a', roughness: 0.22, metalness: 0.0, envMapIntensity: 0.55 }),
    );
    pond.scale.set(110, 40, 1);
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(-40, 0.05, 30);
    const bank = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 64), new THREE.MeshStandardMaterial({ color: '#6f6a5c', roughness: 1 }));
    bank.scale.set(110, 40, 1);
    bank.rotation.x = -Math.PI / 2;
    bank.position.set(-40, 0.06, 30);
    this.group.add(pond, bank);
  }

  /** 遠景：2層の稜線と、片側の街並み（霧で霞ませる） */
  private addBackground(rnd: () => number) {
    const ridge = (radius: number, height: number, color: string, seed: number) => {
      const segs = 200;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const h = height * (0.35 + 0.65 * fbm3(Math.cos(a) * 2.5, Math.sin(a) * 2.5, seed, 4, seed));
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        pos.push(x, -2, z, x, h, z);
        if (i < segs) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    };
    this.group.add(ridge(2300, 210, '#5d7468', 3), ridge(1650, 110, '#4b6450', 7));
    const town: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 70; i++) {
      const w = 12 + rnd() * 30;
      const h = 6 + rnd() * rnd() * 45;
      const g = new THREE.BoxGeometry(w, h, 12 + rnd() * 20);
      g.translate((rnd() - 0.5) * 1400, h / 2, -(800 + rnd() * 450));
      town.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(town), new THREE.MeshLambertMaterial({ color: '#9aa2a8' })));
  }

  /** 天候・時間帯・馬場に合わせて空・光・霧・質感を切り替える */
  applyConditions(weather: Weather, timeOfDay: TimeOfDay, going: Going, boardLines: string[]) {
    const wet = going === 'soft' || going === 'heavy';
    const overcast = weather === 'rain' ? 1 : weather === 'drizzle' ? 0.8 : weather === 'cloudy' ? 0.55 : 0.15;
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
    this.focusShadow(0, TURF.radius, this.shadowRadius);

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
