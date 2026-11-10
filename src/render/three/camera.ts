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
 * - turn4      最終コーナー〜直線：コースの外側（直線ではスタンド前）から馬群を横に見て、ゴール前まで横長の画面で追う
 *              （正面からのカット headon は手動の選択肢にも使わない。実際の中継の直線は横からの追い撮りが中心）
 *
 * 遮蔽：カメラと馬の間に看板・照明塔・木・建物が入らないよう、ショットの切替時と0.5秒ごとに視線を確かめ、
 * 遮られていれば候補の中から見通しのよい位置（高さ・距離）へなめらかに移る。
 * 画角は「撮りたい馬が画面に収まる」ように自動で決める。注視点は速度つきの追従フィルタで、
 * 時速60km近い馬に遅れずに滑らかに追う。ショットの切替はカット（瞬時）、ショット内は滑らかに動かす。
 */
import * as THREE from 'three';
import { type Course, curvatureAt, isOnTurn, pointAt, raceU } from '../../core/track';
import type { CameraMode } from '../types';
import { STAND_BASE_Y, STAND_Z } from './environment';

export type Shot = 'gate' | 'wide' | 'leaders' | 'side' | 'corner' | 'turn4' | 'headon' | 'finishline' | 'follow';

export interface DirectorHorse {
  x: number;
  lane: number;
  wx: number;
  wy: number;
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
  /** from から各 targets への視線のうち、設備に遮られている割合（0〜1）。省略時は遮蔽を考えない */
  occlusion?: (from: THREE.Vector3, targets: THREE.Vector3[]) => number;
}

/** 最終コーナーのカメラの候補（コースの外側への距離 m・高さ m）。上から順に優先 */
const TURN4_SPOTS = [
  { out: 34, h: 12 },
  { out: 28, h: 15 },
  { out: 46, h: 19 },
  { out: 22, h: 10 },
  { out: 40, h: 26 },
];
/** 直線：スタンド前のカメラ位置（スタンドの建物に入らないよう外ラチに近い） */
const STRAIGHT_SPOTS = [
  { out: 16, h: 13 },
  { out: 12, h: 16 },
  { out: 22, h: 20 },
  { out: 9, h: 11 },
];
/** その他の固定カメラ：遮られたときに持ち上げる高さ */
const LIFTS = [0, 6, 12, 20];
/** 最終コーナーを含む最後の区間（ゴールまでの距離） */
const FINAL_TURN_REM = 760;

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
  /** 開発時の確認用：注視点 */
  readonly lookPoint = new THREE.Vector3();
  private shotStart = -100;
  private look = new Tracker(3.5);
  private camPos = new Tracker(2.5);
  private fov = 30;
  private firstFinish = Infinity;
  private spot = 0;
  private inStraight = false;
  private lift = 0;
  private lastCheck = -100;

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
      case 'corner':
        if (rem < FINAL_TURN_REM && rem > 300) return 'turn4';
        return isOnTurn(inp.course, raceU(inp.course, D, leadX)) ? 'corner' : 'leaders';
      case 'stretch':
        return rem < 45 || finished > 0 ? 'finishline' : 'turn4';
      case 'finish':
        return 'finishline';
      default:
        break;
    }
    // 自動（中継のカット割り）
    if (inp.time < 3) return 'gate';
    if (finished > 0) return finished >= Math.min(3, inp.horses.length) && inp.time - this.firstFinish > 3 ? 'leaders' : 'finishline';
    if (rem < 45) return 'finishline';
    const onTurn = isOnTurn(inp.course, raceU(inp.course, D, leadX));
    // 最終コーナー〜直線〜ゴール前：実際の中継のように、外側（直線ではスタンド側）から馬群を横に追う。正面からのカットは使わない
    if (rem < FINAL_TURN_REM && (onTurn || homeStraight || this.shot === 'turn4')) return this.reducedMotion ? 'leaders' : 'turn4';
    if (rem < 650) return 'leaders';
    if (this.reducedMotion) return onTurn ? 'wide' : 'leaders';
    // コーナーは全景で入り、途中から内側のコーナーカメラへ
    if (onTurn) {
      if (this.shot === 'corner') return 'corner';
      if (this.shot === 'wide') return inp.time - this.shotStart > 6 ? 'corner' : 'wide';
      return 'wide';
    }
    if (inp.time < 12) return 'side';
    // 直線は並走カメラと主カメラを交互に
    const elapsed = inp.time - this.shotStart;
    if (this.shot === 'side') return elapsed > 11 ? 'leaders' : 'side';
    if (this.shot === 'leaders') return elapsed > 9 ? 'side' : 'leaders';
    return 'side';
  }

  /**
   * 候補の位置（make(i)）のうち、被写体（先頭3頭と馬群の中心）が遮られないものを選ぶ。
   * 確認はショットの切替時と0.5秒ごと。今の候補が見通せる間は変えない（無駄に動かさない）。
   */
  private chooseSpot(inp: DirectorInput, cut: boolean, group: DirectorHorse[], make: (i: number) => THREE.Vector3, n: number, kind: 'spot' | 'lift' = 'spot'): THREE.Vector3 {
    let cur = kind === 'spot' ? this.spot : this.lift;
    if (cut) cur = 0;
    const check = inp.occlusion && (cut || inp.time - this.lastCheck > 0.5 || inp.time < this.lastCheck);
    if (check && inp.occlusion) {
      this.lastCheck = inp.time;
      const targets = group.slice(0, 3).map((h) => new THREE.Vector3(h.wx, h.wy + 1.4, h.wz));
      const c = new THREE.Vector3();
      group.forEach((h) => c.add(new THREE.Vector3(h.wx, h.wy + 1.2, h.wz)));
      targets.push(c.divideScalar(Math.max(1, group.length)));
      if (inp.occlusion(make(cur), targets) > 0) {
        let best = cur;
        let bestBlocked = Infinity;
        for (let i = 0; i < n; i++) {
          const b = inp.occlusion(make(i), targets);
          if (b < bestBlocked) {
            best = i;
            bestBlocked = b;
          }
          if (b === 0) break;
        }
        cur = best;
      }
    }
    if (kind === 'spot') this.spot = cur;
    else this.lift = cur;
    return make(cur);
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
      case 'turn4':
        // 先頭だけでなく後続の馬群も入れる（最大8頭）
        group = ranked.slice(0, Math.min(7, ranked.length));
        minR = 10;
        break;
      default:
        group = ranked.slice(0, Math.min(5, ranked.length));
        minR = this.shot === 'side' ? 6.5 : 9;
    }
    const center = new THREE.Vector3();
    group.forEach((h) => center.add(new THREE.Vector3(h.wx, h.wy + 1.3, h.wz)));
    center.divideScalar(group.length);
    let radius = minR;
    group.forEach((h) => (radius = Math.max(radius, Math.hypot(h.wx - center.x, h.wz - center.z) + 3)));
    radius = Math.min(radius, this.shot === 'wide' ? 140 : this.shot === 'turn4' ? 34 : 40);
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
        pos.set(p.x, p.y + 3.6, p.z);
        margin = 1.15;
        break;
      }
      case 'wide':
      case 'leaders': {
        // スタンド屋根の前端に据えた主カメラ。左右に少しだけドリーして角度を保つ
        pos.set(THREE.MathUtils.clamp(center.x * 0.35, -220, 120), STAND_BASE_Y + 37.5, STAND_Z + 1);
        margin = this.shot === 'wide' ? 1.08 : 1.3;
        break;
      }
      case 'side': {
        const u = raceU(course, D, packX);
        const p = pointAt(course, u + 3, course.width + (course.surface === 'dirt' ? 5 : 9));
        pos.set(p.x, p.y + 3.4, p.z);
        const l = pointAt(course, u - 1, packLane);
        lookTarget = new THREE.Vector3(l.x, l.y + 1.35, l.z);
        margin = 1.35;
        break;
      }
      case 'corner': {
        // コーナーの内側（内馬場）から、隊列が回ってくるのを見る
        const u = raceU(course, D, packX);
        const k = Math.max(1 / 400, Math.abs(curvatureAt(course, u)));
        const p = pointAt(course, u + 30, -Math.min(0.55 / k, 80));
        pos.set(p.x, p.y + 17, p.z);
        margin = 1.3;
        break;
      }
      case 'turn4': {
        // コースの外側（右回りでは進行方向の左）の撮影台から、馬群と同じ位置で横に見る
        const u = raceU(course, D, packX) - 4;
        // 直線に入ったらスタンド前の位置へ（カメラは追従フィルタでなめらかに移る）
        const inStraight = !isOnTurn(course, u) && u <= course.finishU + 20;
        const spots = inStraight ? STRAIGHT_SPOTS : TURN4_SPOTS;
        if (inStraight !== this.inStraight) {
          this.inStraight = inStraight;
          this.spot = Math.min(this.spot, spots.length - 1);
        }
        const spot = this.chooseSpot(inp, cut, group, (i) => {
          const sp = spots[Math.min(i, spots.length - 1)];
          const q = pointAt(course, u, course.width + sp.out);
          return new THREE.Vector3(q.x, q.y + sp.h, q.z);
        }, spots.length);
        pos.copy(spot);
        margin = 1.18;
        break;
      }
      case 'headon': {
        // 直線の先（1コーナー手前）の外側から、直線を正面に見る
        const p = pointAt(course, course.finishU + 85, course.width + 5);
        pos.set(p.x, p.y + 9, p.z);
        margin = 1.15;
        break;
      }
      case 'finishline': {
        const p = pointAt(course, course.finishU + 3, course.width + 16);
        pos.set(p.x, p.y + 6.5, p.z);
        margin = 1.6;
        break;
      }
      case 'follow': {
        const h = group[0];
        const fx = Math.cos(h.heading);
        const fz = Math.sin(h.heading);
        // 進行方向の外側（右回りでは左）に少しずらした後方から
        pos.set(h.wx - fx * 15 + fz * 5, h.wy + 3.4, h.wz - fz * 15 - fx * 5);
        lookTarget = new THREE.Vector3(h.wx + fx * 4, h.wy + 1.3, h.wz + fz * 4);
        margin = 1.6;
        break;
      }
    }

    // 固定カメラ：遮られていれば持ち上げる（ショットの切替時と0.5秒ごとに確認）
    if (this.shot !== 'turn4' && this.shot !== 'follow') {
      const base = pos.clone();
      const lifted = this.chooseSpot(inp, cut, group, (i) => base.clone().add(new THREE.Vector3(0, LIFTS[i], 0)), LIFTS.length, 'lift');
      pos.copy(lifted);
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
    if (this.shot === 'side' || this.shot === 'leaders' || this.shot === 'wide' || this.shot === 'turn4') lookTarget.addScaledVector(vel, 0.15);
    // 最終コーナーは注視点の高さを固定し、縦に振らない
    if (this.shot === 'turn4') lookTarget.y = group.reduce((a, h) => a + h.wy, 0) / group.length + 1.2;
    const movingCam = this.shot === 'side' || this.shot === 'follow' || this.shot === 'turn4';
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
    this.lookPoint.copy(look);
    this.focusDistance = cam.distanceTo(center);
  }
}
