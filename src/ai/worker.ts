/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/wasm";
import { mulberry32 } from "../core/random";
import { GenerationCancelled, KOMI, generateGame } from "./generate";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { Evaluator, createEvaluator } from "./model";

let evaluator: Promise<Evaluator> | null = null;

function getEvaluator(modelUrl: string): Promise<Evaluator> {
  ort.env.wasm.numThreads = 1;
  evaluator ??= createEvaluator(ort, modelUrl, KOMI);
  return evaluator;
}

// 推論セッションは同時に 1 つの対局しか扱えないので、依頼は順番に処理する
let queue = Promise.resolve();

const cancelled = new Set<number>();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const request = e.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }
  queue = queue.then(() => handle(request));
};

async function handle({ id, size, seed, modelUrl }: Extract<WorkerRequest, { type: "generate" }>): Promise<void> {
  const post = (msg: WorkerResponse) => self.postMessage(msg);
  try {
    const evaluate = await getEvaluator(modelUrl);
    const game = await generateGame(evaluate, {
      size,
      random: mulberry32(seed),
      onMove: (move) => post({ type: "progress", id, move }),
      shouldStop: () => cancelled.has(id),
    });
    const { position, ...rest } = game;
    post({
      type: "done",
      id,
      game: { ...rest, cells: position.board.cells, dead: position.board.dead, trays: position.trays },
    });
  } catch (err) {
    if (!(err instanceof GenerationCancelled)) evaluator = null;
    post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    cancelled.delete(id);
  }
}
