/**
 * 端末内保存（localStorage）。読み書きに失敗する環境（プライベートモード等）では
 * メモリ上だけで動作する。
 */
import { type AppState, SCHEMA_VERSION } from './state';
import { createWorld } from './world';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'virtual-turf:v1';

export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export function defaultKV(): KV {
  try {
    const probe = '__vt_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryKV();
  }
}

export function loadState(kv: KV): AppState | null {
  try {
    const raw = kv.getItem(KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveState(kv: KV, state: AppState): boolean {
  try {
    kv.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearState(kv: KV): void {
  try {
    kv.removeItem(KEY);
  } catch {
    /* noop */
  }
}

/**
 * 古い形式の保存データを今の形式へ移行する。残高・台帳・購入履歴・監査ログ・開催はそのまま引き継ぐ。
 * 新しすぎる（未来の）形式や壊れたデータは読み込まない。
 */
export function migrate(raw: unknown): AppState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = { ...(raw as Record<string, unknown>) };
  let v = Number(s.version);
  if (!Number.isInteger(v) || v < 1 || v > SCHEMA_VERSION) return null;
  if (v === 1) {
    // v1 → v2：競馬界を追加
    s.world = createWorld();
    v = 2;
  }
  s.version = v;
  return s as unknown as AppState;
}
