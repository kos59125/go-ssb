/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/wasm";
import { mulberry32 } from "../core/random";
import { GenerationCancelled, KOMI, finishRecord, generateGame } from "./generate";
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
  queue = queue.then(() => (request.type === "record" ? handleRecord(request) : handle(request)));
};

/** 実戦の棋譜から整地用の局面を作る。 */
async function handleRecord({ id, record, forCpu, modelUrl }: Extract<WorkerRequest, { type: "record" }>): Promise<void> {
  try {
    const evaluate = await getEvaluator(modelUrl);
    const { position, ...rest } = await finishRecord(evaluate, record, forCpu);
    self.postMessage({
      type: "done",
      id,
      game: { ...rest, cells: position.board.cells, dead: position.board.dead, trays: position.trays },
    } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({ type: "error", id, message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
}

async function handle({ id, size, seed, forCpu, modelUrl }: Extract<WorkerRequest, { type: "generate" }>): Promise<void> {
  const post = (msg: WorkerResponse) => self.postMessage(msg);
  try {
    const evaluate = await getEvaluator(modelUrl);
    const game = await generateGame(evaluate, {
      size,
      random: mulberry32(seed),
      forCpu,
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
