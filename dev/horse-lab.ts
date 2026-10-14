// 開発用：馬モデルと歩様の確認ページ（本番ビルドには含まれない）
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HorseModel } from '../src/render/three/horseModel';

const params = new URLSearchParams(location.search);
const W = 1200, H = 700;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fb3c4');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const sun = new THREE.DirectionalLight('#fff3e0', 2.2);
sun.position.set(-4, 8, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#8a7a62', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// 地面の目盛り（滑りの確認用、1m間隔）
for (let i = -20; i <= 20; i++) {
  const l = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 6), new THREE.MeshBasicMaterial({ color: '#5a4d3c' }));
  l.rotation.x = -Math.PI / 2; l.position.set(i, 0.002, 0); scene.add(l);
}
const coats = [['鹿毛', '#7a4a2a'], ['芦毛', '#b9b4ab'], ['栗毛', '#a5582a']];
const horses = coats.map(([coat, color], i) => {
  const h = new HorseModel({ id: `lab${i}`, coat, coatColor: color, number: i + 3, capColor: ['#d92b2b', '#2463d1', '#f2cc1f'][i] }, (params.get('detail') as 'high') ?? 'high', { shadows: true, physical: true });
  scene.add(h.root);
  return h;
});
const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 200);
(window as any).renderAt = (v: number, t: number, view: string) => {
  const dt = 1 / 60;
  // 0 から t 秒までシミュレートして、位相とばねの状態を自然にする
  const steps = Math.round(t / dt);
  let x = 0;
  for (let s = 0; s <= steps; s++) {
    x += v * (s ? dt : 0);
    horses.forEach((h, i) => h.update(x + (i - 1) * 0.0, (i - 1) * 2.4, 0, v, s ? dt : 0, v > 14 ? 1 : 0));
  }
  const cx = x;
  if (view === 'side') { camera.fov = 30; camera.position.set(cx + 0.4, 1.4, 12); camera.lookAt(cx + 0.4, 1.1, 0); }
  else if (view === 'front') { camera.fov = 28; camera.position.set(cx + 7, 2.2, 6); camera.lookAt(cx, 1.2, 0); }
  else if (view === 'legs') { camera.fov = 22; camera.position.set(cx + 0.2, 0.6, 6); camera.lookAt(cx, 0.55, 2.4); }
  else if (view === 'rear') { camera.fov = 30; camera.position.set(cx - 8, 2.4, 4); camera.lookAt(cx, 1.2, 0); }
  camera.updateProjectionMatrix();
  sun.position.set(cx - 4, 8, 6); sun.target.position.set(cx, 0, 0); sun.target.updateMatrixWorld();
  renderer.render(scene, camera);
};
(window as any).ready = true;
