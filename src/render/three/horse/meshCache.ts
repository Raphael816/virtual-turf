/**
 * メッシュデータのキャッシュ。体型 × 画質ごとに1回だけ生成する。
 * Worker が使えない環境では本体で生成する（遅いが動く）。
 */
import type { BuildType } from './anatomy';
import { type Detail, type MeshData, buildHorseMesh, buildJockeyMesh } from './mesh';

const cache = new Map<string, Promise<MeshData>>();
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (d: MeshData) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; data?: MeshData; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.data) p.resolve(ev.data.data);
      else p.reject(new Error(ev.data.error ?? 'mesh worker failed'));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message));
      pending.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function request(kind: 'horse' | 'jockey', build: BuildType, detail: Detail): Promise<MeshData> {
  const key = `${kind}:${build}:${detail}`;
  let p = cache.get(key);
  if (p) return p;
  const w = getWorker();
  if (w) {
    p = new Promise<MeshData>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, kind, build, detail });
    });
  } else {
    p = Promise.resolve().then(() => (kind === 'horse' ? buildHorseMesh(build, detail) : buildJockeyMesh(detail)));
  }
  // 失敗した要求はキャッシュから外し、次回に作り直せるようにする
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  return p;
}

export const horseMesh = (build: BuildType, detail: Detail) => request('horse', build, detail);
export const jockeyMesh = (detail: Detail) => request('jockey', 'standard', detail);
