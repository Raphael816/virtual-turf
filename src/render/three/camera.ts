/**
 * 中継風のカメラワーク。
 * - 全景 / 先頭集団（並走）/ 注目馬（後方追従）/ ゴール前（固定）/ ゲート
 * - 自動：レースの局面に応じてカットで切り替える（動きを減らす設定では切替を最小限に）
 * ショット内の移動は指数補間で滑らかにし、ショットの切替はカット（瞬時）にする。
 */
import * as THREE from 'three';
import { type Course, pointAt, raceU } from '../../core/track';
import type { CameraMode } from '../types';

type Shot = 'gate' | 'overview' | 'leaders' | 'follow' | 'finish';

export interface DirectorInput {
  time: number;
  /** 各馬の走破距離・レーン・ワールド座標 */
  horses: { x: number; lane: number; wx: number; wz: number; heading: number; rank: number; finished: boolean }[];
  followIndex: number;
  course: Course;
  distance: number;
  started: boolean;
}

const STAND_Z = 216;

export class CameraDirector {
  mode: CameraMode = 'auto';
  reducedMotion = false;
  private shot: Shot = 'gate';
  private pos = new THREE.Vector3(0, 50, 300);
  private look = new THREE.Vector3();
  private targetPos = new THREE.Vector3();
  private targetLook = new THREE.Vector3();
  private fov = 40;
  focus = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {}

  private chooseShot(inp: DirectorInput): Shot {
    if (!inp.started) return 'gate';
    if (this.mode !== 'auto') return this.mode as Shot;
    const leadX = Math.max(...inp.horses.map((h) => h.x));
    const rem = inp.distance - leadX;
    const allDone = inp.horses.every((h) => h.finished);
    if (inp.time < 4) return 'gate';
    if (rem < 170 && !allDone) return 'finish';
    if (allDone || rem <= 0) return 'leaders';
    if (rem < 600 || this.reducedMotion) return 'leaders';
    // 中盤は「先頭集団」と「全景」を交互に
    const cycle = (inp.time - 4) % 26;
    return cycle < 15 ? 'leaders' : 'overview';
  }

  update(dt: number, inp: DirectorInput) {
    const { course, distance: D } = inp;
    const next = this.chooseShot(inp);
    const cut = next !== this.shot;
    this.shot = next;

    const ranked = [...inp.horses].sort((a, b) => a.rank - b.rank);
    const front = ranked.slice(0, Math.min(3, ranked.length));
    const packX = front.reduce((a, h) => a + h.x, 0) / front.length;
    const packLane = front.reduce((a, h) => a + h.lane, 0) / front.length;

    switch (this.shot) {
      case 'gate': {
        const u0 = raceU(course, D, 0);
        const p = pointAt(course, u0 + 10, course.width + 14);
        const l = pointAt(course, u0 - 2, course.width * 0.25);
        this.targetPos.set(p.x, 4.5, p.z);
        this.targetLook.set(l.x, 1.4, l.z);
        this.fov = 42;
        break;
      }
      case 'overview': {
        const c = pointAt(course, raceU(course, D, packX), packLane);
        // スタンド上空の前方から、隊列とコースの広がりを見渡す
        this.targetPos.set(c.x * 0.5, 115, STAND_Z + 50);
        this.targetLook.set(c.x, 0, c.z);
        this.fov = 24;
        break;
      }
      case 'leaders': {
        const u = raceU(course, D, packX);
        const p = pointAt(course, u + 3, course.width + 15);
        const l = pointAt(course, u - 3, packLane);
        this.targetPos.set(p.x, 6.5, p.z);
        this.targetLook.set(l.x, 1.3, l.z);
        this.fov = 32;
        break;
      }
      case 'follow': {
        const h = inp.horses[inp.followIndex] ?? ranked[0];
        const fx = Math.cos(h.heading);
        const fz = Math.sin(h.heading);
        // 進行方向の右手（外側）に少しずらした後方から
        this.targetPos.set(h.wx - fx * 13 - fz * 4, 4.6, h.wz - fz * 13 + fx * 4);
        this.targetLook.set(h.wx + fx * 9, 1.4, h.wz + fz * 9);
        this.fov = 48;
        break;
      }
      case 'finish': {
        const p = pointAt(course, course.finishU + 14, course.width + 20);
        const l = pointAt(course, raceU(course, D, Math.min(packX, D)), course.width * 0.35);
        this.targetPos.set(p.x, 7, p.z);
        this.targetLook.set(l.x, 1.3, l.z);
        this.fov = 26;
        break;
      }
    }

    const k = cut ? 1 : 1 - Math.exp(-dt * (this.shot === 'follow' ? 6 : 3.5));
    this.pos.lerp(this.targetPos, k);
    this.look.lerp(this.targetLook, k);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = cut ? this.fov : this.camera.fov + (this.fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
    }
    this.focus.copy(this.look);
  }
}
