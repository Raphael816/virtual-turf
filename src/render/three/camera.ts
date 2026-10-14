/**
 * 競馬中継風のカメラワーク（望遠レンズ・遠くからの撮影）。
 *
 * ショット：
 * - wide       スタンド屋上の主カメラから全馬を収める（全景）
 * - leaders    同じ主カメラで先頭集団に寄る
 * - side       外ラチ沿いを並走するカメラカー
 * - headon     ゴールの先から直線を正面に見る（望遠で馬群が圧縮される）
 * - finishline ゴール板の横
 * - follow     注目馬の後方
 * - gate       発馬機の横
 *
 * 画角は「撮りたい馬が画面に収まる」ように自動で決める。注視点は速度つきの追従フィルタで、
 * 時速60km近い馬に遅れずに滑らかに追う。ショットの切替はカット（瞬時）、ショット内は滑らかに動かす。
 */
import * as THREE from 'three';
import { type Course, isOnTurn, pointAt, raceU } from '../../core/track';
import type { CameraMode } from '../types';
import { STAND_Z } from './environment';

export type Shot = 'gate' | 'wide' | 'leaders' | 'side' | 'headon' | 'finishline' | 'follow';

export interface DirectorHorse {
  x: number;
  lane: number;
  wx: number;
  wz: number;
  heading: number;
  rank: number;
  finished: boolean;
  v: number;
}

export interface DirectorInput {
  time: number;
  dt: number;
  horses: DirectorHorse[];
  followIndex: number;
  course: Course;
  distance: number;
  started: boolean;
  aspect: number;
}

/**
 * 追従フィルタ。対象の速度（馬の速度から分かる）で先読みしてから、残りの差だけを指数平滑する。
 * 時間はレース時間で進めるので、フレームレートが低くても遅れず、一時停止中は止まる。
 */
class Tracker {
  p = new THREE.Vector3();
  private init = false;
  constructor(private rate: number) {}
  reset(x: THREE.Vector3) {
    this.p.copy(x);
    this.init = true;
  }
  update(target: THREE.Vector3, velocity: THREE.Vector3, dt: number): THREE.Vector3 {
    if (!this.init) this.reset(target);
    if (dt <= 0) return this.p;
    this.p.addScaledVector(velocity, dt);
    this.p.lerp(target, 1 - Math.exp(-dt * this.rate));
    return this.p;
  }
}

const MIN_SHOT = 4;

export class CameraDirector {
  mode: CameraMode = 'auto';
  reducedMotion = false;
  /** 被写界深度用：ピントを合わせる距離 */
  focusDistance = 50;
  /** 影の範囲などに使う：被写体の中心と大きさ */
  readonly focus = new THREE.Vector3();
  subjectRadius = 10;
  shot: Shot = 'gate';
  private shotStart = -100;
  private look = new Tracker(3.5);
  private camPos = new Tracker(2.5);
  private fov = 30;
  private firstFinish = Infinity;

  constructor(private camera: THREE.PerspectiveCamera) {}

  private chooseShot(inp: DirectorInput, leadX: number, homeStraight: boolean): Shot {
    if (!inp.started) return 'gate';
    const D = inp.distance;
    const rem = D - leadX;
    const finished = inp.horses.filter((h) => h.finished).length;
    switch (this.mode) {
      case 'follow':
        return 'follow';
      case 'overview':
        return 'wide';
      case 'leaders':
        return 'leaders';
      case 'side':
        return 'side';
      case 'finish':
        return rem < 45 || finished > 0 ? 'finishline' : 'headon';
      default:
        break;
    }
    // 自動（中継のカット割り）
    if (inp.time < 3) return 'gate';
    if (finished > 0) return finished >= Math.min(3, inp.horses.length) && inp.time - this.firstFinish > 3 ? 'leaders' : 'finishline';
    if (rem < 45) return 'finishline';
    if (homeStraight && rem < 420) return this.reducedMotion ? 'leaders' : 'headon';
    if (rem < 650) return 'leaders';
    const onTurn = isOnTurn(inp.course, raceU(inp.course, D, leadX));
    if (this.reducedMotion) return onTurn ? 'wide' : 'leaders';
    if (onTurn) return 'wide';
    if (inp.time < 12) return 'side';
    // 直線は並走カメラと主カメラを交互に
    const elapsed = inp.time - this.shotStart;
    if (this.shot === 'side') return elapsed > 11 ? 'leaders' : 'side';
    if (this.shot === 'leaders') return elapsed > 9 ? 'side' : 'leaders';
    return 'side';
  }

  update(inp: DirectorInput) {
    const { course, distance: D, dt } = inp;
    const ranked = [...inp.horses].sort((a, b) => a.rank - b.rank);
    if (!ranked.length) return;
    const leadX = Math.max(...ranked.map((h) => h.x));
    if (this.firstFinish === Infinity && ranked.some((h) => h.finished)) this.firstFinish = inp.time;
    if (!ranked.some((h) => h.finished)) this.firstFinish = Infinity;
    const uLead = raceU(course, D, Math.min(leadX, D));
    const homeStraight = uLead <= course.finishU + 20 && !isOnTurn(course, uLead);

    const seekedBack = inp.time < this.shotStart;
    let next = this.chooseShot(inp, leadX, homeStraight);
    // 最低限のショットの長さを守る（ゴール前・発走・リプレイの巻き戻しは優先）
    if (this.mode === 'auto' && !seekedBack && next !== this.shot && inp.time - this.shotStart < MIN_SHOT && next !== 'finishline' && next !== 'gate' && this.shot !== 'gate') next = this.shot;
    const cut = next !== this.shot || seekedBack;
    if (cut) {
      this.shot = next;
      this.shotStart = inp.time;
    }

    // 被写体：ショットに応じて対象の馬を選び、中心と半径を求める
    let group: DirectorHorse[];
    let minR: number;
    switch (this.shot) {
      case 'wide':
        group = ranked;
        minR = 16;
        break;
      case 'follow':
        group = [inp.horses[inp.followIndex] ?? ranked[0]];
        minR = 4;
        break;
      case 'finishline':
        group = ranked.slice(0, 3);
        minR = 7;
        break;
      case 'gate':
        group = ranked;
        minR = 9;
        break;
      default:
        group = ranked.slice(0, Math.min(5, ranked.length));
        minR = this.shot === 'side' ? 6.5 : 9;
    }
    const center = new THREE.Vector3();
    group.forEach((h) => center.add(new THREE.Vector3(h.wx, 1.3, h.wz)));
    center.divideScalar(group.length);
    let radius = minR;
    group.forEach((h) => (radius = Math.max(radius, Math.hypot(h.wx - center.x, h.wz - center.z) + 3)));
    radius = Math.min(radius, this.shot === 'wide' ? 140 : 40);
    this.subjectRadius = radius;
    const packX = group.reduce((a, h) => a + h.x, 0) / group.length;
    const packLane = group.reduce((a, h) => a + h.lane, 0) / group.length;

    // カメラ位置と注視点
    const pos = new THREE.Vector3();
    let lookTarget = center.clone();
    let margin = 1.25;
    switch (this.shot) {
      case 'gate': {
        const u0 = raceU(course, D, 0);
        const p = pointAt(course, u0 + 22, course.width + 10);
        pos.set(p.x, 3.6, p.z);
        margin = 1.15;
        break;
      }
      case 'wide':
      case 'leaders': {
        // スタンド屋根の前端に据えた主カメラ。左右に少しだけドリーして角度を保つ
        pos.set(THREE.MathUtils.clamp(center.x * 0.35, -150, 150), 37.5, STAND_Z + 1);
        margin = this.shot === 'wide' ? 1.08 : 1.3;
        break;
      }
      case 'side': {
        const u = raceU(course, D, packX);
        const p = pointAt(course, u + 3, course.width + (course.surface === 'dirt' ? 5 : 9));
        pos.set(p.x, 3.4, p.z);
        const l = pointAt(course, u - 1, packLane);
        lookTarget = new THREE.Vector3(l.x, 1.35, l.z);
        margin = 1.35;
        break;
      }
      case 'headon': {
        const p = pointAt(course, course.finishU + 160, course.width * 0.5);
        pos.set(p.x, 8, p.z);
        margin = 1.15;
        break;
      }
      case 'finishline': {
        const p = pointAt(course, course.finishU + 3, course.width + 16);
        pos.set(p.x, 6.5, p.z);
        margin = 1.6;
        break;
      }
      case 'follow': {
        const h = group[0];
        const fx = Math.cos(h.heading);
        const fz = Math.sin(h.heading);
        pos.set(h.wx - fx * 15 - fz * 5, 3.4, h.wz - fz * 15 + fx * 5);
        lookTarget = new THREE.Vector3(h.wx + fx * 4, 1.3, h.wz + fz * 4);
        margin = 1.6;
        break;
      }
    }

    if (cut) {
      this.look.reset(lookTarget);
      this.camPos.reset(pos);
    }
    // 被写体の平均速度（先読み用）
    const vel = new THREE.Vector3();
    group.forEach((h) => vel.add(new THREE.Vector3(Math.cos(h.heading) * h.v, 0, Math.sin(h.heading) * h.v)));
    vel.divideScalar(group.length);
    // 進行方向に少し空間を空ける（リードルーム）。正面・後方からのショットでは不要
    if (this.shot === 'side' || this.shot === 'leaders' || this.shot === 'wide') lookTarget.addScaledVector(vel, 0.15);
    const movingCam = this.shot === 'side' || this.shot === 'follow';
    const look = this.look.update(lookTarget, vel, dt);
    const cam = this.camPos.update(pos, movingCam ? vel : new THREE.Vector3(), dt);

    // 画角：被写体の半径が水平方向に収まるように（遠いほど狭く＝望遠）
    const dist = cam.distanceTo(look);
    const hHalf = Math.atan((radius * margin) / Math.max(1, dist));
    let vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hHalf) / Math.max(0.5, inp.aspect)));
    vfov = THREE.MathUtils.clamp(vfov, 2.2, 42);
    if (cut) this.fov = vfov;
    else this.fov += (vfov - this.fov) * Math.min(1, dt * 2.2);

    this.camera.position.copy(cam);
    this.camera.lookAt(look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.focus.copy(center);
    this.focusDistance = cam.distanceTo(center);
  }
}
