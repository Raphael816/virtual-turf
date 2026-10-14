/**
 * 地面の演出：蹄の着地に合わせた砂煙・土くれ／芝の跳ね・蹄跡、と雨。
 * 着地位置は歩様（gait.ts）が返すので、映像の脚の動きと一致する。
 */
import * as THREE from 'three';
import { dustSprite, hoofPrintTexture } from './textures';

/** 砂煙：太陽光で照らされる柔らかいスプライト */
export class DustSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private next = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;

  constructor(readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3).fill(-9999);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 400 }, uMap: { value: dustSprite() }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: `attribute float psize; attribute float alpha; attribute vec3 pcolor;
        uniform float uScale; varying float vA; varying vec3 vC; varying float vRot;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv;
          vA = alpha; vC = pcolor; vRot = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.283; }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uLight; varying float vA; varying vec3 vC; varying float vRot;
        void main(){ vec2 p = gl_PointCoord - 0.5; float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          vec4 t = texture2D(uMap, p); if (t.a < 0.01) discard;
          gl_FragColor = vec4(vC * uLight, vA * t.a); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  setViewportHeight(px: number) {
    this.mat.uniforms.uScale.value = px * 0.9;
  }

  /** 光の強さ（昼は明るく、夜は照明の色） */
  setLight(c: THREE.Color) {
    (this.mat.uniforms.uLight.value as THREE.Color).copy(c);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.color.set([c.r, c.g, c.b], i * 3);
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] = this.vel[k + 1] * (1 - 1.2 * dt) + 0.15 * dt; // 舞い上がってゆっくり漂う
      this.vel[k] *= 1 - 1.4 * dt;
      this.vel[k + 2] *= 1 - 1.4 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] = Math.max(0.1, this.pos[k + 1] + this.vel[k + 1] * dt);
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      // 出始めは素早く濃くなり、ゆっくり薄れる
      this.alpha[i] = Math.min(1, (1 - t) * 8) * t * 0.5;
      this.size[i] += dt * 1.6;
    }
    for (const name of ['position', 'psize', 'alpha', 'pcolor']) this.geo.getAttribute(name).needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    (this.mat.uniforms.uMap.value as THREE.Texture).dispose();
  }
}

/** 土くれ・芝の塊（蹄で後方へ跳ね上がる小片） */
export class ClodSystem {
  readonly mesh: THREE.InstancedMesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private rot: Float32Array;
  private life: Float32Array;
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(readonly capacity: number) {
    const geo = new THREE.DodecahedronGeometry(0.05, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1 }), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const c = new THREE.Color('#555');
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.mesh.setColorAt(i, c);
    }
  }

  emit(x: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([x, 0.08, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.rot[i] = Math.random() * 6;
    this.life[i] = 0.9;
    this.mesh.setColorAt(i, c);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= 9.8 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < 0.04) {
        this.pos[k + 1] = 0.04;
        this.vel[k] = this.vel[k + 1] = this.vel[k + 2] = 0;
      }
      this.rot[i] += dt * 8;
      const sc = this.life[i] > 0 ? Math.min(1, this.life[i] * 3) * (0.6 + (i % 5) * 0.15) : 0;
      this.p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      this.q.setFromEuler(this.e.set(this.rot[i], this.rot[i] * 0.7, 0));
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s.setScalar(sc)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** 蹄跡：着地位置に置き、時間とともに薄れる */
export class HoofPrints {
  readonly mesh: THREE.InstancedMesh;
  private age: Float32Array;
  private next = 0;
  private base: THREE.Matrix4[] = [];
  private tex = hoofPrintTexture();

  constructor(readonly capacity: number) {
    const geo = new THREE.PlaneGeometry(0.16, 0.18).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: -2 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.age = new Float32Array(capacity).fill(999);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.base.push(new THREE.Matrix4());
    }
  }

  add(x: number, z: number, heading: number, opacity: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.base[i].makeRotationY(-heading - Math.PI / 2).setPosition(x, 0.055, z);
    this.age[i] = 0;
    this.mesh.setMatrixAt(i, this.base[i].clone().scale(new THREE.Vector3(opacity, 1, opacity)));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    // 40秒で消える（個別の不透明度は使わず、縮小で目立たなくする）
    let changed = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] > 40) continue;
      this.age[i] += dt;
      if (this.age[i] > 40) {
        this.mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.age[i] = 999;
      this.mesh.setMatrixAt(i, zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
  }
}

export class RainSystem {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat = new THREE.LineBasicMaterial({ color: '#c3ccd6', transparent: true, opacity: 0.35 });
  private readonly box = 70;

  constructor(private count: number) {
    this.pos = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) this.reset(i, 0, 0, true);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  private reset(i: number, cx: number, cz: number, anyHeight: boolean) {
    const x = cx + (Math.random() - 0.5) * this.box;
    const z = cz + (Math.random() - 0.5) * this.box;
    const y = (anyHeight ? Math.random() : 1) * 22;
    this.pos.set([x, y, z, x + 0.05, y - 0.45, z], i * 6);
  }

  setIntensity(level: 0 | 1 | 2) {
    this.lines.visible = level > 0;
    this.geo.setDrawRange(0, level === 2 ? this.count * 2 : Math.floor(this.count * 0.9));
    this.mat.opacity = level === 2 ? 0.22 : 0.14;
  }

  /** カメラの前方に雨を降らせる（望遠でも見えるように注視点の周りに置く） */
  update(dt: number, center: THREE.Vector3) {
    if (!this.lines.visible) return;
    const fall = 26 * dt;
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      this.pos[k + 1] -= fall;
      this.pos[k + 4] -= fall;
      const dx = this.pos[k] - center.x;
      const dz = this.pos[k + 2] - center.z;
      if (this.pos[k + 4] < 0 || Math.abs(dx) > this.box / 2 || Math.abs(dz) > this.box / 2) this.reset(i, center.x, center.z, false);
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
