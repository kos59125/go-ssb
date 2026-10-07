import { Board } from "../core/board";
import type { GeneratedGame } from "./generate";
import type { GameRecord } from "./sgf";
import { MODEL_PATH, type SerializedGame, type WorkerRequest, type WorkerResponse } from "./protocol";

/**
 * 終局図の生成を Web Worker で行う。盤サイズとシードの組ごとに先読みしておける。
 * 同じ盤サイズとシードからは同じ終局図ができる。
 */
export class GameGenerator {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (g: GeneratedGame) => void; reject: (e: Error) => void; onProgress?: (move: number) => void }
  >();
  private readonly prefetched = new Map<string, { id: number; promise: Promise<GeneratedGame> }>();
  /** take() で待っている依頼。中断しない。 */
  private readonly taking = new Set<number>();

  /** 裏で 1 局生成しておく。ほかの先読みは中断する。 */
  prefetch(size: number, seed: number): void {
    const key = `${size}:${seed}`;
    for (const [other, entry] of this.prefetched) {
      if (other === key || this.taking.has(entry.id)) continue;
      this.worker?.postMessage({ type: "cancel", id: entry.id } satisfies WorkerRequest);
      this.prefetched.delete(other);
    }
    if (this.prefetched.has(key)) return;
    const id = this.nextId++;
    const promise = this.request(id, size, seed);
    promise.catch(() => {
      if (this.prefetched.get(key)?.id === id) this.prefetched.delete(key);
    });
    this.prefetched.set(key, { id, promise });
  }

  /** 生成済み（または生成中）の 1 局を受け取る。 */
  async take(size: number, seed: number, onProgress?: (move: number) => void): Promise<GeneratedGame> {
    const key = `${size}:${seed}`;
    this.prefetch(size, seed);
    const entry = this.prefetched.get(key)!;
    const listener = this.pending.get(entry.id);
    if (listener) listener.onProgress = onProgress;
    this.taking.add(entry.id);
    try {
      return await entry.promise;
    } finally {
      this.taking.delete(entry.id);
      this.prefetched.delete(key);
    }
  }

  /** 実戦の棋譜（SGF）から整地用の局面を作る。 */
  fromRecord(record: GameRecord): Promise<GeneratedGame> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "record", id, record, modelUrl: modelUrl() } satisfies WorkerRequest);
    });
  }

  private request(id: number, size: number, seed: number): Promise<GeneratedGame> {
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "generate", id, size, seed, modelUrl: modelUrl() } satisfies WorkerRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      if (msg.type === "progress") {
        entry.onProgress?.(msg.move);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "done") entry.resolve(deserialize(msg.game));
      else entry.reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      for (const entry of this.pending.values()) entry.reject(new Error(e.message));
      this.pending.clear();
      this.prefetched.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }
}

function deserialize(game: SerializedGame): GeneratedGame {
  const { cells, dead, trays, ...rest } = game;
  return { ...rest, position: { board: new Board(game.size, cells, dead), trays } };
}

/** ネットワークの絶対 URL。Worker からは相対パスが解決できないので、ページ側で作る。 */
function modelUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}${MODEL_PATH}`, document.baseURI).href;
}
