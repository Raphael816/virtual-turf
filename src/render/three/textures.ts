/**
 * Canvas で生成するテクスチャ。外部画像を使わないので権利処理が不要で、読み込みも軽い。
 * 地面系は「色」と「法線（凹凸）」の2枚を作り、光の当たり方で質感が出るようにする。
 */
import * as THREE from 'three';
import { fbm3, noise3 } from './noise';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** 高さマップから法線マップを作る */
function normalFromHeight(h: Float32Array, W: number, H: number, strength: number): HTMLCanvasElement {
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = h[y * W + ((x - 1 + W) % W)];
      const r = h[y * W + ((x + 1) % W)];
      const u = h[((y - 1 + H) % H) * W + x];
      const d = h[((y + 1) % H) * W + x];
      const nx = (l - r) * strength;
      const ny = (u - d) * strength;
      const len = Math.hypot(nx, ny, 1);
      const k = (y * W + x) * 4;
      img.data[k] = (nx / len) * 127.5 + 127.5;
      img.data[k + 1] = (ny / len) * 127.5 + 127.5;
      img.data[k + 2] = (1 / len) * 127.5 + 127.5;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** タイル状に繰り返せるノイズ（周期 period のトーラス上でサンプリング） */
function tileNoise(x: number, y: number, W: number, H: number, scale: number, seed: number, oct = 4): number {
  const a = (x / W) * Math.PI * 2;
  const b = (y / H) * Math.PI * 2;
  const rx = (W / (Math.PI * 2)) * scale;
  const ry = (H / (Math.PI * 2)) * scale;
  return fbm3(Math.cos(a) * rx + Math.sin(b) * 0.37 * ry, Math.sin(a) * rx, Math.cos(b) * ry, oct, seed);
}

export interface SurfaceTextures {
  map: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
}

/** 芝：細かな葉の筋と色ムラ（u = 進行方向） */
export function turfTextures(size = 512): SurfaceTextures {
  const W = size;
  const H = size;
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n1 = tileNoise(x, y, W, H, 0.02, 1, 3);
      const blade = noise3(x * 0.9, y * 0.18, 0, 3) * 0.6 + noise3(x * 2.2, y * 0.5, 2, 4) * 0.4;
      const v = 0.78 + 0.28 * n1 + 0.18 * (blade - 0.5);
      h[y * W + x] = blade;
      const k = (y * W + x) * 4;
      img.data[k] = 62 * v + 8 * (n1 - 0.5);
      img.data[k + 1] = 112 * v;
      img.data[k + 2] = 44 * v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: toTexture(c), normal: toTexture(normalFromHeight(h, W, H, 2.2), false) };
}

/** ダート：砂粒とハロー掛けの筋（u = 進行方向に筋が走る） */
export function dirtTextures(size = 512): SurfaceTextures {
  const W = size;
  const H = size;
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const furrow = Math.sin((y / H) * Math.PI * 2 * 26) * 0.5 + 0.5;
    for (let x = 0; x < W; x++) {
      const n = tileNoise(x, y, W, H, 0.03, 5, 4);
      const grain = noise3(x * 1.7, y * 1.7, 9, 6);
      const streak = noise3(x * 0.01, y * 0.7, 3, 8);
      const height = 0.5 * furrow * (0.6 + 0.4 * streak) + 0.35 * grain + 0.15 * n;
      h[y * W + x] = height;
      const v = 0.8 + 0.25 * n + 0.15 * (grain - 0.5) + 0.08 * (furrow - 0.5);
      const k = (y * W + x) * 4;
      img.data[k] = 160 * v;
      img.data[k + 1] = 124 * v;
      img.data[k + 2] = 88 * v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: toTexture(c), normal: toTexture(normalFromHeight(h, W, H, 3.0), false) };
}

/** コース外の芝生（やや粗い、色ムラ大きめ） */
export function grassTextures(size = 256): SurfaceTextures {
  const W = size;
  const H = size;
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = tileNoise(x, y, W, H, 0.04, 21, 4);
      const fine = noise3(x * 1.3, y * 1.3, 4, 22);
      h[y * W + x] = fine;
      const v = 0.75 + 0.35 * n + 0.12 * (fine - 0.5);
      const k = (y * W + x) * 4;
      img.data[k] = 58 * v;
      img.data[k + 1] = 98 * v;
      img.data[k + 2] = 46 * v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: toTexture(c), normal: toTexture(normalFromHeight(h, W, H, 1.5), false) };
}

/** 観客席：座席の列（v 方向に段が並ぶ） */
export function seatTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#6d747a';
  g.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 16; row++) {
    const y = row * 16;
    g.fillStyle = '#4c5359';
    g.fillRect(0, y + 11, 256, 5); // 段の影
    for (let x = 0; x < 256; x += 8) {
      g.fillStyle = (row + x / 8) % 9 === 0 ? '#3a5f7a' : '#2f5470';
      g.fillRect(x + 1, y + 3, 6, 7);
    }
  }
  return toTexture(c);
}

/** ガラス張りの建物の窓（u: 横、v: 縦） */
export function facadeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#1e2a35';
  g.fillRect(0, 0, 256, 128);
  for (let y = 0; y < 128; y += 16) {
    g.fillStyle = '#8f9aa3';
    g.fillRect(0, y, 256, 2);
  }
  for (let x = 0; x < 256; x += 12) {
    g.fillStyle = '#7f8a93';
    g.fillRect(x, 0, 1, 128);
  }
  return toTexture(c);
}

/** 生垣（葉の茂み） */
export function hedgeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#2f4f27';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 0.6 + Math.random() * 0.7;
    g.fillStyle = `rgb(${46 * v},${82 * v},${38 * v})`;
    g.beginPath();
    g.arc(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c);
}

/** 雲の基になるノイズ（被覆率は呼び出し側でしきい値処理） */
export function cloudField(W = 512, H = 256): Float32Array {
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = (x / W) * Math.PI * 2;
      f[y * W + x] = fbm3(Math.cos(a) * 3, Math.sin(a) * 3, y * 0.035, 5, 31);
    }
  }
  return f;
}

export function cloudTexture(field: Float32Array, W: number, H: number, coverage: number, tint: string, existing?: THREE.CanvasTexture): THREE.CanvasTexture {
  const c = (existing?.image as HTMLCanvasElement) ?? canvas(W, H)[0];
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const col = new THREE.Color(tint);
  const th = 1 - coverage;
  for (let y = 0; y < H; y++) {
    // 天頂付近（y が小さい）ほど薄く、地平線付近は密に見える
    const horizon = Math.pow(y / H, 0.6);
    for (let x = 0; x < W; x++) {
      const v = field[y * W + x];
      const a = Math.max(0, Math.min(1, (v - th * 0.62 - 0.2) / 0.18));
      const shade = 0.82 + 0.18 * (1 - v);
      const k = (y * W + x) * 4;
      img.data[k] = col.r * 255 * shade;
      img.data[k + 1] = col.g * 255 * shade;
      img.data[k + 2] = col.b * 255 * shade;
      img.data[k + 3] = a * 255 * (0.35 + 0.65 * horizon);
    }
  }
  g.putImageData(img, 0, 0);
  if (existing) {
    existing.needsUpdate = true;
    return existing;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** 内馬場の大型ビジョン */
export function boardTexture(lines: string[]): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 180);
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, 512, 180);
  ctx.fillStyle = '#e9eff4';
  ctx.textAlign = 'center';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText(lines[0] ?? '', 256, 78);
  ctx.font = '30px system-ui, sans-serif';
  ctx.fillStyle = '#a3b4c3';
  ctx.fillText(lines[1] ?? '', 256, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 砂煙のスプライト（柔らかい雲状） */
export function dustSprite(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const d = Math.hypot(x - 32, y - 32) / 32;
      const n = fbm3(x * 0.12, y * 0.12, 0, 3, 41);
      const a = Math.max(0, 1 - d) ** 1.6 * (0.55 + 0.6 * n);
      const k = (y * 64 + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/** 蹄跡（三日月形のくぼみ） */
export function hoofPrintTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  const grd = g.createRadialGradient(32, 30, 4, 32, 32, 24);
  grd.addColorStop(0, 'rgba(40,26,14,0.75)');
  grd.addColorStop(0.7, 'rgba(60,40,22,0.45)');
  grd.addColorStop(1, 'rgba(60,40,22,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(32, 32, 20, 24, 0, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.ellipse(32, 44, 9, 10, 0, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

/** 照明灯の柔らかい光（控えめなグロー） */
export function glowSprite(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,250,235,0.9)');
  grd.addColorStop(0.25, 'rgba(255,245,225,0.35)');
  grd.addColorStop(1, 'rgba(255,245,225,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** ハロン棒の赤白 */
export function poleTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(8, 64);
  for (let y = 0; y < 64; y += 16) {
    g.fillStyle = '#c62828';
    g.fillRect(0, y, 8, 8);
    g.fillStyle = '#f2f2ee';
    g.fillRect(0, y + 8, 8, 8);
  }
  return toTexture(c);
}
