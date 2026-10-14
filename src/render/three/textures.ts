/** Canvas で生成するテクスチャ（外部画像を使わないので権利処理が不要で、読み込みも軽い） */
import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, count: number) {
  for (let i = 0; i < count; i++) {
    const a = (Math.random() - 0.5) * amount;
    ctx.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function toTexture(c: HTMLCanvasElement, repeatU = 1, repeatV = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  t.anisotropy = 4;
  return t;
}

/** 芝：進行方向に沿った刈り込み模様（濃淡の縞） */
export function turfTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128);
  ctx.fillStyle = '#4f8f3e';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#5c9e48';
  ctx.fillRect(128, 0, 128, 128);
  noise(ctx, 256, 128, 0.18, 5000);
  return toTexture(c);
}

/** ダート：砂の粒感 */
export function dirtTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#9b7652';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.25, 6000);
  return toTexture(c);
}

/** コース外の芝生 */
export function grassTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#3d6e33';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.2, 5000);
  return toTexture(c, 300, 300);
}

/** ゼッケン（白地に黒の馬番） */
export function numberTexture(n: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 96);
  ctx.fillStyle = '#f5f5f2';
  ctx.fillRect(0, 0, 128, 96);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 64, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 内馬場の大型ビジョン */
export function boardTexture(lines: string[]): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 180);
  ctx.fillStyle = '#0b1622';
  ctx.fillRect(0, 0, 512, 180);
  ctx.strokeStyle = '#4fbf7a';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 500, 168);
  ctx.fillStyle = '#e9eff4';
  ctx.textAlign = 'center';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText(lines[0] ?? '', 256, 72);
  ctx.font = '30px system-ui, sans-serif';
  ctx.fillStyle = '#a3b4c3';
  ctx.fillText(lines[1] ?? '', 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** パーティクル用の柔らかい円 */
export function softDot(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
