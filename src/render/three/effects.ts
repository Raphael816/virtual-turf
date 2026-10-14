/** 砂煙（ダートは濃い砂、芝は芝くず）と雨のパーティクル */
import * as THREE from 'three';

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
      uniforms: { uScale: { value: 400 } },
      vertexShader: `attribute float psize; attribute float alpha; attribute vec3 pcolor;
        uniform float uScale; varying float vA; varying vec3 vC;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; vA = alpha; vC = pcolor; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.0, d)); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  /** 画面の高さに合わせて点の大きさを調整 */
  setViewportHeight(px: number) {
    this.mat.uniforms.uScale.value = px * 0.9;
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
      this.vel[k + 1] -= 2.5 * dt; // 重力（砂は軽く舞う）
      this.vel[k] *= 1 - 1.5 * dt;
      this.vel[k + 2] *= 1 - 1.5 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] = Math.max(0.05, this.pos[k + 1] + this.vel[k + 1] * dt);
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.max(0, t) * 0.55;
      this.size[i] += dt * 1.2;
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
  }
}

export class RainSystem {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat = new THREE.LineBasicMaterial({ color: '#b8c6d4', transparent: true, opacity: 0.4 });
  private readonly box = 90;

  constructor(private count: number) {
    this.pos = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) this.reset(i, 0, 0, 0, true);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  private reset(i: number, cx: number, cy: number, cz: number, anyHeight: boolean) {
    const x = cx + (Math.random() - 0.5) * this.box;
    const z = cz + (Math.random() - 0.5) * this.box;
    const y = cy + (anyHeight ? Math.random() : 1) * 50;
    this.pos.set([x, y, z, x + 0.15, y - 1.2, z], i * 6);
  }

  setIntensity(level: 0 | 1 | 2) {
    this.lines.visible = level > 0;
    this.geo.setDrawRange(0, level === 2 ? this.count * 2 : Math.floor(this.count * 0.8));
    this.mat.opacity = level === 2 ? 0.45 : 0.3;
  }

  update(dt: number, cam: THREE.Vector3) {
    if (!this.lines.visible) return;
    const fall = 28 * dt;
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      this.pos[k + 1] -= fall;
      this.pos[k + 4] -= fall;
      const dx = this.pos[k] - cam.x;
      const dz = this.pos[k + 2] - cam.z;
      if (this.pos[k + 4] < 0 || Math.abs(dx) > this.box / 2 || Math.abs(dz) > this.box / 2) this.reset(i, cam.x, 0, cam.z, false);
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
