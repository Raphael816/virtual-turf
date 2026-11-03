// 開発用：馬モデルと歩様の確認ページ（本番ビルドには含まれない）
// ?model=new（既定）で基準モデル、?model=old で旧モデル。?bg=studio で暗い背景
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HorseModel } from '../src/render/three/horseModel';
import { type HorseView, RaceHorse } from '../src/render/three/horse/racehorse';
import { REFERENCE_HORSE, specFromLook } from '../src/render/three/horse/spec';

const params = new URLSearchParams(location.search);
const W = 1200, H = 700;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const studio = params.get('bg') !== 'field';
scene.background = new THREE.Color(studio ? '#16181b' : '#9fb3c4');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = studio ? 0.45 : 0.6;
const sun = new THREE.DirectionalLight('#fff3e0', 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight('#cfe0ff', studio ? 1.6 : 0.4);
scene.add(rim, rim.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: studio ? '#2a2c30' : '#8a7a62', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// 地面の目盛り（滑りの確認用、1m間隔）
for (let i = -20; i <= 20; i++) {
  const l = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 6), new THREE.MeshBasicMaterial({ color: studio ? '#3a3d42' : '#5a4d3c' }));
  l.rotation.x = -Math.PI / 2; l.position.set(i, 0.002, 0); scene.add(l);
}
const detail = (params.get('detail') as 'high' | 'medium' | 'low') ?? 'high';
const count = Number(params.get('count') ?? 1);
const horses: HorseView[] = [];
const looks = [['鹿毛', '#6e3d1f'], ['芦毛', '#b9b4ab'], ['栗毛', '#a5582a']];
async function init() {
  for (let i = 0; i < count; i++) {
    let h: HorseView;
    if (params.get('model') === 'old') {
      h = new HorseModel({ id: `lab${i}`, coat: looks[i][0], coatColor: looks[i][1], number: i + 3, capColor: '#d92b2b' }, detail, { shadows: true, physical: true });
    } else {
      const spec = i === 0 ? REFERENCE_HORSE : specFromLook({ id: `lab${i}`, coat: looks[i][0], coatColor: looks[i][1], number: i + 3, capColor: '#2463d1' });
      h = await RaceHorse.create(spec, detail, { shadows: true, physical: true });
    }
    scene.add(h.root);
    horses.push(h);
  }
  (window as any).ready = true;
}
const noJockey = params.get('jockey') === '0';
const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 200);
(window as any).renderAt = (v: number, t: number, view: string) => {
  const dt = 1 / 60;
  const steps = Math.round(t / dt);
  let x = 0;
  for (let s = 0; s <= steps; s++) {
    x += v * (s ? dt : 0);
    horses.forEach((h, i) => h.update(x, 0, (i - (count - 1) / 2) * 2.4, 0, 0, v, s ? dt : 0, v > 14 ? 1 : 0));
  }
  if (noJockey) horses.forEach((h) => (h as any).setJockeyVisible?.(false));
  const cx = x + 0.2;
  const views: Record<string, [number[], number[], number]> = {
    side: [[cx, 1.3, 9.5], [cx, 1.05, 0], 30],
    front: [[cx + 7, 1.6, 0.2], [cx, 1.1, 0], 26],
    frontq: [[cx + 5.2, 2.0, 5.2], [cx, 1.1, 0], 28],
    rearq: [[cx - 5.2, 2.2, 5.0], [cx, 1.1, 0], 28],
    rear: [[cx - 7, 1.7, 0.2], [cx, 1.1, 0], 26],
    head: [[cx + 2.2, 1.8, 2.0], [cx + 1.35, 1.6, 0], 24],
    legs: [[cx + 0.2, 0.6, 5], [cx, 0.55, 0], 26],
    far: [[cx - 2, 18, 60], [cx, 1, 0], 6],
  };
  const [p, l, fov] = views[view] ?? views.side;
  camera.fov = fov; camera.position.set(p[0], p[1], p[2]); camera.lookAt(l[0], l[1], l[2]);
  camera.updateProjectionMatrix();
  sun.position.set(cx + 4, 7, 6); sun.target.position.set(cx, 0, 0); sun.target.updateMatrixWorld();
  rim.position.set(cx - 6, 4, -5); rim.target.position.set(cx, 1, 0); rim.target.updateMatrixWorld();
  renderer.render(scene, camera);
};
init().catch((e) => { console.error(e); (window as any).ready = true; });
