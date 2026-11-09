/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/wasm";
import { mulberry32 } from "../core/random";
import { GenerationCancelled, KOMI, finishRecord, generateGame } from "./generate";
import { UnfilledDameError, type WorkerRequest, type WorkerResponse } from "./protocol";
import { Evaluator, createEvaluator } from "./model";
import { humanMetaRow, inverseRank } from "./humanSl";

let evaluator: Promise<Evaluator> | null = null;

function getEvaluator(modelUrl: string): Promise<Evaluator> {
  ort.env.wasm.numThreads = 1;
  evaluator ??= createEvaluator(ort, modelUrl, KOMI);
  return evaluator;
}

// Human SL ネットワーク。重いので、使うときに初めて読み込む。棋力は依頼ごとに切り替える
// （依頼は順番に処理するので、生成中に変わることはない）
let humanEvaluator: Promise<Evaluator> | null = null;
let humanInverseRank = inverseRank("1d");

function getHumanEvaluator(modelUrl: string, rank: string): Promise<Evaluator> {
  ort.env.wasm.numThreads = 1;
  humanInverseRank = inverseRank(rank);
  humanEvaluator ??= createEvaluator(ort, modelUrl, KOMI, (game) => humanMetaRow(humanInverseRank, game.size * game.size));
  return humanEvaluator;
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
async function handleRecord({ id, record, forCpu, rules, fillDame, modelUrl }: Extract<WorkerRequest, { type: "record" }>): Promise<void> {
  try {
    const evaluate = await getEvaluator(modelUrl);
    const { position, ...rest } = await finishRecord(evaluate, record, forCpu, rules, fillDame);
    self.postMessage({
      type: "done",
      id,
      game: { ...rest, cells: position.board.cells, dead: position.board.dead, trays: position.trays },
    } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
      dame: err instanceof UnfilledDameError ? err.dame : undefined,
    } satisfies WorkerResponse);
  }
}

async function handle({
  id,
  size,
  seed,
  forCpu,
  rules,
  modelUrl,
  humanRank,
  humanModelUrl,
}: Extract<WorkerRequest, { type: "generate" }>): Promise<void> {
  const post = (msg: WorkerResponse) => self.postMessage(msg);
  try {
    const evaluate = await getEvaluator(modelUrl);
    let human: Evaluator | undefined;
    if (humanRank) {
      if (!humanEvaluator) post({ type: "loading", id });
      try {
        human = await getHumanEvaluator(humanModelUrl, humanRank);
      } catch (err) {
        humanEvaluator = null;
        throw err;
      }
    }
    const game = await generateGame(evaluate, {
      size,
      random: mulberry32(seed),
      forCpu,
      rules,
      human,
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
