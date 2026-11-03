import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { anatomy, boneDefs, FORE, HIND } from '../src/render/three/horse/anatomy';
import { buildHorseMesh } from '../src/render/three/horse/mesh';
import { Shape } from '../src/render/three/horse/sdf';
import { REFERENCE_HORSE, specFromLook } from '../src/render/three/horse/spec';
import { CameraDirector, type DirectorHorse } from '../src/render/three/camera';
import { courseFor, isOnTurn, pointAt, raceU } from '../src/core/track';

describe('基準モデルの馬体（SDF → メッシュ）', () => {
  const mesh = buildHorseMesh('standard', 'low');
  const n = mesh.positions.length / 3;
  const defs = boneDefs();

  it('メッシュが生成され、体高・体長がサラブレッドの範囲に収まる', () => {
    expect(n).toBeGreaterThan(5000);
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, mesh.positions[i * 3]);
      maxX = Math.max(maxX, mesh.positions[i * 3]);
      minY = Math.min(minY, mesh.positions[i * 3 + 1]);
      maxY = Math.max(maxY, mesh.positions[i * 3 + 1]);
    }
    expect(minY).toBeGreaterThan(0.02); // 蹄（別のメッシュ）の上で止まり、地面に沈まない
    expect(minY).toBeLessThan(0.1);
    expect(maxY).toBeGreaterThan(2.0); // 項の高さ
    expect(maxY).toBeLessThan(2.2);
    expect(maxX - minX).toBeGreaterThan(2.4); // 尻端から鼻先まで
    expect(maxX - minX).toBeLessThan(3.1);
  });

  it('法線は単位ベクトルで、スキンの重みの合計は1', () => {
    for (let i = 0; i < n; i += 37) {
      const l = Math.hypot(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]);
      expect(l).toBeCloseTo(1, 3);
      const w = mesh.skinWeight.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b, 0);
      expect(w).toBeCloseTo(1, 4);
    }
  });

  it('脚先の頂点は、その脚の骨に付く（左右・前後を取り違えない）', () => {
    const check = (x: number, z: number, bone: string) => {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(mesh.positions[i * 3] - x, mesh.positions[i * 3 + 1] - 0.3, mesh.positions[i * 3 + 2] - z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const top = mesh.skinIndex[best * 4];
      expect(defs[top].name).toBe(bone);
    };
    check(FORE.knee[0], FORE.knee[2], 'fcannonR');
    check(FORE.knee[0], -FORE.knee[2], 'fcannonL');
    check(HIND.fetlock[0], HIND.fetlock[2], 'hcannonR');
    check(HIND.fetlock[0], -HIND.fetlock[2], 'hcannonL');
  });

  it('体型（細身・筋肉質）で筋肉の太さが変わる', () => {
    const thigh = (b: 'lean' | 'muscular') => new Shape(anatomy(b)).dist(-0.6, 1.05, 0.25);
    expect(thigh('muscular')).toBeLessThan(thigh('lean'));
  });
});

describe('馬ごとの仕様（個体差）', () => {
  const look = (id: string) => ({ id, coat: '栗毛', coatColor: '#a5582a', number: 1, capColor: '#fff' });
  it('同じ馬からは同じ仕様、違う馬では違う仕様', () => {
    expect(specFromLook(look('h1'))).toEqual(specFromLook(look('h1')));
    expect(specFromLook(look('h1')).gait).not.toEqual(specFromLook(look('h2')).gait);
  });
  it('個体差は基準モデルと同じ範囲の中に収まる', () => {
    for (let i = 0; i < 40; i++) {
      const s = specFromLook(look(`h${i}`));
      expect(s.build.length).toBeGreaterThan(0.96);
      expect(s.build.length).toBeLessThan(1.04);
      expect(s.gait.freqScale).toBeGreaterThan(0.95);
      expect(s.gait.freqScale).toBeLessThan(1.05);
      expect(['lean', 'standard', 'muscular']).toContain(s.build.type);
    }
    expect(REFERENCE_HORSE.build.type).toBe('standard');
  });
});

describe('最終コーナーのカメラ', () => {
  const course = courseFor('turf', 'outer');
  const D = 1600;
  // 最終コーナーの途中に先頭がいる地点を探す
  let lead = D - 700;
  while (!(isOnTurn(course, raceU(course, D, lead)) && D - lead < 700)) lead += 5;
  const horses: DirectorHorse[] = Array.from({ length: 8 }, (_, i) => {
    const x = lead - i * 2.5;
    const p = pointAt(course, raceU(course, D, x), 1 + (i % 4) * 1.2);
    return { x, lane: 1 + (i % 4) * 1.2, wx: p.x, wy: p.y, wz: p.z, heading: p.heading, rank: i + 1, finished: false, v: 16 };
  });
  const run = (occlusion?: (from: THREE.Vector3, t: THREE.Vector3[]) => number) => {
    const cam = new THREE.PerspectiveCamera(30, 16 / 9, 1, 5000);
    const dir = new CameraDirector(cam);
    dir.update({ time: 60, dt: 0.016, horses, followIndex: 0, course, distance: D, started: true, aspect: 16 / 9, occlusion });
    return { dir, cam };
  };

  it('自動では、最終コーナーで外側から横に見るショットになり、横長の画角で馬群を収める', () => {
    const { dir, cam } = run();
    expect(dir.shot).toBe('turn4');
    // カメラは馬群の外側（中心からの距離が馬群よりコースの外）にあり、視線はほぼ水平に近い（俯角 25°未満）
    const c = new THREE.Vector3();
    horses.forEach((h) => c.add(new THREE.Vector3(h.wx, h.wy, h.wz)));
    c.divideScalar(horses.length);
    const horiz = Math.hypot(cam.position.x - c.x, cam.position.z - c.z);
    const down = Math.atan2(cam.position.y - c.y, horiz);
    expect(down).toBeLessThan((25 * Math.PI) / 180);
    expect(horiz).toBeGreaterThan(30);
    // 馬群の前後（先頭〜8番手）が画面の横幅に収まる
    cam.updateMatrixWorld();
    for (const h of horses) {
      const p = new THREE.Vector3(h.wx, h.wy + 1.2, h.wz).project(cam);
      expect(Math.abs(p.x)).toBeLessThan(1);
      expect(Math.abs(p.y)).toBeLessThan(1);
    }
  });

  it('カメラの切替直後に遮られている位置は選ばず、見通しのよい候補へ移る', () => {
    const ground = horses[0].wy;
    // 低い位置（高さ13m未満）からの視線はすべて看板に遮られる、という条件
    const blockLow = (from: THREE.Vector3) => (from.y - ground < 13 ? 1 : 0);
    const { cam } = run(blockLow);
    expect(cam.position.y - ground).toBeGreaterThanOrEqual(13);
    const open = run(() => 0);
    expect(open.cam.position.y).toBeLessThan(cam.position.y);
  });
});
