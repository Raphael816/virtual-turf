/**
 * 競馬場の静的な環境：地面・芝/ダートコース・ラチ・ハロン棒・ゴール板・スタンドと観客・照明塔・木々・遠景・空。
 * 開催条件（天候・時間帯・馬場）に応じた照明は applyConditions で切り替える。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Going, TimeOfDay, Weather } from '../../core/sim';
import { COURSES, type Course, pointAt } from '../../core/track';
import { boardTexture, dirtTexture, grassTexture, turfTexture } from './textures';

export interface EnvQuality {
  crowd: number;
  trees: number;
  shadows: boolean;
}

const TURF = COURSES.turf;
const STAND_Z = TURF.radius + TURF.width + 20;
const STAND_ROWS = 22;
const STAND_HALF = 175;

/** コースの帯（内側 inner〜外側 outer）を上向きの面で作る */
function ribbon(course: Course, inner: number, outer: number, y: number, uvScale: number): THREE.BufferGeometry {
  const segs = Math.ceil(course.circumference / 2);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = (i / segs) * course.circumference;
    const a = pointAt(course, u, inner);
    const b = pointAt(course, u, outer);
    pos.push(a.x, y, a.z, b.x, y, b.z);
    uv.push(u / uvScale, 0, u / uvScale, (outer - inner) / uvScale);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function railGeometry(course: Course, lane: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let u = 0; u < course.circumference; u += 4) {
    const p = pointAt(course, u, lane);
    pts.push(new THREE.Vector3(p.x, 1.0, p.z));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  return new THREE.TubeGeometry(curve, pts.length * 2, 0.07, 6, true);
}

function railPosts(course: Course, lane: number, step: number, mat: THREE.Material): THREE.InstancedMesh {
  const n = Math.floor(course.circumference / step);
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 5), mat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const p = pointAt(course, i * step, lane);
    m.makeTranslation(p.x, 0.5, p.z);
    mesh.setMatrixAt(i, m);
  }
  return mesh;
}

/** 空のグラデーション（天頂色 → 地平線色） */
function skyDome(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color('#5d9fd8') }, horizon: { value: new THREE.Color('#cfe3ef') } },
    vertexShader: `varying float vH; void main(){ vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying float vH;
      void main(){ float t = clamp(pow(max(vH,0.0), 0.55), 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, t), 1.0); }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(2800, 24, 12), mat);
}

export class Environment {
  readonly group = new THREE.Group();
  readonly hemi = new THREE.HemisphereLight('#cfe3ef', '#3d5a33', 0.9);
  readonly sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  private sky = skyDome();
  private sunDir = new THREE.Vector3(-260, 420, 240).normalize();
  private turfMat: THREE.MeshStandardMaterial;
  private dirtMat: THREE.MeshStandardMaterial;
  private lampMat = new THREE.MeshStandardMaterial({ color: '#333', emissive: '#000' });
  private windowMat = new THREE.MeshStandardMaterial({ color: '#2a3542', emissive: '#000', roughness: 0.4 });
  private board: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;

  constructor(
    private scene: THREE.Scene,
    q: EnvQuality,
  ) {
    scene.add(this.group, this.hemi, this.sun, this.sun.target, this.sky);
    this.sun.castShadow = q.shadows;
    if (q.shadows) {
      this.sun.shadow.mapSize.set(q.crowd > 5000 ? 2048 : 1024, q.crowd > 5000 ? 2048 : 1024);
      const s = this.sun.shadow.camera;
      s.left = s.bottom = -45;
      s.right = s.top = 45;
      s.near = 10;
      s.far = 900;
      this.sun.shadow.bias = -0.0005;
    }

    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    // コース面と重なってちらつかないよう、地面は少し下げる
    ground.position.y = -0.25;
    ground.receiveShadow = true;
    this.group.add(ground);

    // コース
    this.turfMat = new THREE.MeshStandardMaterial({ map: turfTexture(), roughness: 0.95 });
    this.turfMat.map!.repeat.set(1, 1);
    this.dirtMat = new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 1 });
    const turf = new THREE.Mesh(ribbon(TURF, 0, TURF.width, 0.03, 12), this.turfMat);
    const dirt = new THREE.Mesh(ribbon(COURSES.dirt, 0, COURSES.dirt.width, 0.04, 6), this.dirtMat);
    turf.receiveShadow = dirt.receiveShadow = true;
    this.group.add(turf, dirt);

    // ラチ（内・外）と支柱
    const white = new THREE.MeshStandardMaterial({ color: '#f2f2ee', roughness: 0.5 });
    const step = q.crowd > 2000 ? 4 : 8;
    for (const [course, lane] of [
      [TURF, -0.3],
      [TURF, TURF.width + 0.3],
      [COURSES.dirt, -0.3],
      [COURSES.dirt, COURSES.dirt.width + 0.3],
    ] as [Course, number][]) {
      this.group.add(new THREE.Mesh(railGeometry(course, lane), white), railPosts(course, lane, step, white));
    }

    this.addFinishAndPoles(white);
    this.addGrandstand(q);
    this.addTowers();
    this.addScenery(q);

    // 内馬場の大型ビジョン（スタンドに向ける）
    const mats = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial({ color: '#1b2633' }));
    this.board = new THREE.Mesh(new THREE.BoxGeometry(48, 17, 1.2), mats);
    this.board.position.set(0, 14, -30);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 1), new THREE.MeshStandardMaterial({ color: '#555' }));
    pole.position.set(0, 3, -30);
    this.group.add(this.board, pole);
  }

  private addFinishAndPoles(white: THREE.Material) {
    for (const course of [TURF, COURSES.dirt]) {
      // ゴールライン
      const a = pointAt(course, course.finishU, 0);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.5, course.width), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(a.x, 0.06, a.z + course.width / 2);
      this.group.add(line);
    }
    // ゴール板（芝の内ラチ側）
    const f = pointAt(TURF, TURF.finishU, -1.6);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 8), white);
    post.position.set(f.x, 2.1, f.z);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 0.12, 24),
      new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#222' }),
    );
    disc.rotation.x = Math.PI / 2;
    disc.position.set(f.x, 4.6, f.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 8, 24), new THREE.MeshStandardMaterial({ color: '#c62828' }));
    ring.position.copy(disc.position);
    this.group.add(post, disc, ring);

    // ハロン棒（200mごと、赤白）
    const red = new THREE.MeshStandardMaterial({ color: '#c62828' });
    for (let d = 200; d < TURF.circumference; d += 200) {
      const p = pointAt(TURF, TURF.finishU - d, -1.2);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.4, 6), d % 400 === 0 ? red : white);
      m.position.set(p.x, 1.2, p.z);
      this.group.add(m);
    }
  }

  private addGrandstand(q: EnvQuality) {
    const concrete = new THREE.MeshStandardMaterial({ color: '#8b939b', roughness: 0.9 });
    const seat = new THREE.MeshStandardMaterial({ color: '#4b5866', roughness: 0.8 });
    const steps: THREE.BufferGeometry[] = [];
    for (let i = 0; i < STAND_ROWS; i++) {
      const h = (i + 1) * 0.6 + 4;
      const g = new THREE.BoxGeometry(STAND_HALF * 2, h, 1.3);
      g.translate(0, h / 2, STAND_Z + i * 1.3);
      steps.push(g);
    }
    const stand = new THREE.Mesh(mergeGeometries(steps), seat);
    stand.receiveShadow = true;
    this.group.add(stand);

    const topY = STAND_ROWS * 0.6 + 4;
    const depth = STAND_ROWS * 1.3;
    // 後ろの建物（窓はナイターで点灯）
    const building = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 20, topY + 22, 16), [
      concrete,
      concrete,
      concrete,
      concrete,
      this.windowMat,
      concrete,
    ]);
    building.position.set(0, (topY + 22) / 2, STAND_Z + depth + 8);
    // 屋根と柱
    const roof = new THREE.Mesh(new THREE.BoxGeometry(STAND_HALF * 2 + 10, 0.8, depth + 10), concrete);
    roof.position.set(0, topY + 13, STAND_Z + depth / 2 - 2);
    roof.rotation.x = -0.05;
    roof.castShadow = q.shadows;
    this.group.add(building, roof);
    for (let x = -STAND_HALF; x <= STAND_HALF; x += 35) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.8, 14, 0.8), concrete);
      col.position.set(x, topY + 6, STAND_Z + depth - 1);
      this.group.add(col);
    }
    // 前面の芝生エリア（エプロン）
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(STAND_HALF * 2, 14), new THREE.MeshStandardMaterial({ color: '#8a8f92', roughness: 1 }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.02, STAND_Z - 7);
    this.group.add(apron);

    // 観客（インスタンス描画）
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.85, 0.35), new THREE.MeshLambertMaterial(), q.crowd);
    const palette = ['#d8d8d8', '#2b2b2b', '#3a5f8a', '#8a3a3a', '#c9b37a', '#5f7f5a', '#e5e1d8', '#6b5b7a', '#cf7a3a', '#1f3b5a'];
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < q.crowd; i++) {
      let x: number;
      let y: number;
      let z: number;
      if (i < q.crowd * 0.82) {
        const row = Math.floor(Math.random() * STAND_ROWS);
        x = (Math.random() * 2 - 1) * (STAND_HALF - 2);
        y = (row + 1) * 0.6 + 4 + 0.42;
        z = STAND_Z + row * 1.3 + (Math.random() - 0.5) * 0.4;
      } else {
        x = (Math.random() * 2 - 1) * (STAND_HALF - 2);
        y = 0.45;
        z = STAND_Z - 2 - Math.random() * 11;
      }
      m.makeTranslation(x, y, z);
      crowd.setMatrixAt(i, m);
      crowd.setColorAt(i, c.set(palette[i % palette.length]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.1));
    }
    this.group.add(crowd);
  }

  private addTowers() {
    const steel = new THREE.MeshStandardMaterial({ color: '#6c747c', metalness: 0.4, roughness: 0.6 });
    const spots = [
      [-300, 230], [0, 260], [300, 230], [-300, -230], [0, -250], [300, -230], [-450, 0], [450, 0],
    ];
    for (const [x, z] of spots) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.0, 45, 8), steel);
      pole.position.set(x, 22.5, z);
      const head = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 1.2), this.lampMat);
      head.position.set(x, 46, z);
      head.lookAt(0, 0, 0);
      this.group.add(pole, head);
    }
  }

  private addScenery(q: EnvQuality) {
    // 木々（コースの外周と内馬場）
    const trunkG = new THREE.CylinderGeometry(0.3, 0.4, 3, 5);
    trunkG.translate(0, 1.5, 0);
    const leafG = new THREE.ConeGeometry(3, 8, 7);
    leafG.translate(0, 6.5, 0);
    const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: '#5a4030' }), q.trees);
    // 色はインスタンスごとに設定するので、マテリアルは白（掛け合わせで暗くならないように）
    const leaves = new THREE.InstancedMesh(leafG, new THREE.MeshLambertMaterial({ color: '#ffffff' }), q.trees);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < q.trees; i++) {
      let x: number;
      let z: number;
      do {
        const ring = Math.random() < 0.12;
        if (ring) {
          // 内馬場（池の周り）
          x = (Math.random() * 2 - 1) * 200;
          z = (Math.random() * 2 - 1) * 80;
        } else {
          const a = Math.random() * Math.PI * 2;
          const r = 1 + Math.random() * 0.6;
          x = Math.cos(a) * (TURF.straight / 2 + TURF.radius + 60) * r;
          z = Math.sin(a) * (TURF.radius + 70) * r;
        }
      } while ((z > STAND_Z - 20 && Math.abs(x) < STAND_HALF + 30) || (Math.abs(z) < 50 && Math.abs(x) < 70));
      const s = 0.7 + Math.random() * 0.8;
      m.makeScale(s, s, s).setPosition(x, 0, z);
      trunks.setMatrixAt(i, m);
      leaves.setMatrixAt(i, m);
      leaves.setColorAt(i, c.set('#3f7339').offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.1));
    }
    this.group.add(trunks, leaves);

    // 内馬場の池
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshStandardMaterial({ color: '#2d5f7a', roughness: 0.15, metalness: 0.3 }),
    );
    pond.scale.set(110, 40, 1);
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(-40, 0.05, 30);
    this.group.add(pond);

    // 遠景の山並み
    const hillMat = new THREE.MeshLambertMaterial({ color: '#6f8a80' });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + Math.random() * 0.2;
      const r = 1500 + Math.random() * 400;
      const h = 70 + Math.random() * 90;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(220 + Math.random() * 220, h, 6), hillMat);
      hill.position.set(Math.cos(a) * r, h / 2 - 5, Math.sin(a) * r);
      this.group.add(hill);
    }
  }

  /** 天候・時間帯・馬場に合わせて照明と質感を切り替える */
  applyConditions(weather: Weather, timeOfDay: TimeOfDay, going: Going, boardLines: string[]) {
    const wet = going === 'soft' || going === 'heavy';
    const preset = {
      day: {
        sunny: { top: '#4f93d1', horizon: '#cfe3ef', sun: 2.4, hemi: 0.9, sunColor: '#fff4e0' },
        cloudy: { top: '#7f8e9b', horizon: '#c6cdd3', sun: 0.9, hemi: 1.3, sunColor: '#eef2f5' },
        drizzle: { top: '#626e78', horizon: '#a3acb4', sun: 0.6, hemi: 1.15, sunColor: '#e5ebf0' },
        rain: { top: '#4f5a64', horizon: '#8e979f', sun: 0.45, hemi: 1.05, sunColor: '#dde4ea' },
      },
      dusk: { top: '#2b3a67', horizon: '#ef9d5a', sun: 1.6, hemi: 0.55, sunColor: '#ffb070' },
      night: { top: '#040914', horizon: '#18263c', sun: 1.7, hemi: 0.35, sunColor: '#dfe8ff' },
    } as const;
    const p = timeOfDay === 'day' ? preset.day[weather] : preset[timeOfDay];
    // 夕方・夜は雨でも少し暗く
    const dim = timeOfDay !== 'day' && (weather === 'rain' || weather === 'drizzle') ? 0.8 : 1;

    this.sky.material.uniforms.top.value.set(p.top);
    this.sky.material.uniforms.horizon.value.set(p.horizon);
    this.scene.fog = new THREE.Fog(p.horizon, 350, weather === 'rain' ? 1300 : 2400);
    this.hemi.color.set(p.horizon);
    this.hemi.intensity = p.hemi * dim;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sun * dim;
    // 太陽（夜はスタンド上の照明）の方向
    if (timeOfDay === 'night') this.sunDir.set(80, 320, 420);
    else if (timeOfDay === 'dusk') this.sunDir.set(-600, 120, 150);
    else this.sunDir.set(-260, 420, 240);
    this.sunDir.normalize();
    this.focusShadow(0, TURF.radius);

    const lit = timeOfDay !== 'day';
    this.lampMat.emissive.set(lit ? '#fff8e8' : '#000000');
    this.lampMat.emissiveIntensity = lit ? 2 : 0;
    this.windowMat.emissive.set(timeOfDay === 'night' ? '#f6d48a' : timeOfDay === 'dusk' ? '#5a4a30' : '#000000');

    // 道悪では芝もダートも濃く、少し光沢が出る
    this.turfMat.color.set(wet ? '#b8c8b0' : '#ffffff');
    this.turfMat.roughness = wet ? 0.7 : 0.95;
    this.dirtMat.color.set(wet ? '#8a7766' : going === 'yielding' ? '#d8cbbd' : '#ffffff');
    this.dirtMat.roughness = wet ? 0.55 : 1;

    const tex = boardTexture(boardLines);
    this.board.material[4].map?.dispose();
    this.board.material[4] = new THREE.MeshBasicMaterial({ map: tex });
  }

  /** 影を落とす範囲を注目地点に合わせる（広い競馬場全体に影を計算しないため） */
  focusShadow(x: number, z: number) {
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 400, this.sunDir.y * 400, z + this.sunDir.z * 400);
  }

  setShadows(on: boolean) {
    this.sun.castShadow = on;
  }

  dispose() {
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
