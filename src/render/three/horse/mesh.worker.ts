/// <reference lib="webworker" />
/** 馬体・騎手のメッシュ生成を画面と別スレッドで行う（高画質で約1〜2秒かかるため） */
import type { BuildType } from './anatomy';
import { type Detail, buildHorseMesh, buildJockeyMesh, transferables } from './mesh';

self.onmessage = (ev: MessageEvent<{ id: number; kind: 'horse' | 'jockey'; build: BuildType; detail: Detail }>) => {
  const { id, kind, build, detail } = ev.data;
  try {
    const data = kind === 'horse' ? buildHorseMesh(build, detail) : buildJockeyMesh(detail);
    (self as unknown as Worker).postMessage({ id, data }, transferables(data));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String(e) });
  }
};
