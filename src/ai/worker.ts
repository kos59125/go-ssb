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
let humanReady = false;
let humanInverseRank = inverseRank("1d");
/** 読み込みの進み具合を知らせる依頼（読み込みが終わるまで）。 */
const loadingListeners = new Set<number>();
let loadingState: Extract<WorkerResponse, { type: "loading" }> | null = null;

function reportLoading(stage: "download" | "prepare", loaded: number): void {
  loadingState = { type: "loading", id: 0, stage, loaded };
  for (const id of loadingListeners) self.postMessage({ ...loadingState, id } satisfies WorkerResponse);
}

/** Human SL ネットワークを読み込む（読み込み中・読み込み済みならそれを使う）。進み具合は loadingListeners に知らせる。 */
function loadHumanEvaluator(modelUrl: string): Promise<Evaluator> {
  ort.env.wasm.numThreads = 1;
  if (humanEvaluator) return humanEvaluator;
  const promise = (async () => {
    reportLoading("download", 0);
    const response = await fetch(modelUrl);
    if (!response.ok || !response.body)
      throw new Error(`Human SL ネットワークを読み込めませんでした（${response.status}）`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (loaded - lastReport >= 512 * 1024) {
        lastReport = loaded;
        reportLoading("download", loaded);
      }
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    reportLoading("prepare", loaded);
    const evaluator = await createEvaluator(ort, bytes, KOMI, (game) =>
      humanMetaRow(humanInverseRank, game.size * game.size),
    );
    humanReady = true;
    return evaluator;
  })();
  humanEvaluator = promise;
  promise.then(
    () => loadingListeners.clear(),
    () => {
      humanEvaluator = null;
      loadingState = null;
      loadingListeners.clear();
    },
  );
  return promise;
}

// 推論セッションは同時に 1 つの対局しか扱えないので、依頼は順番に処理する
let queue = Promise.resolve();

const cancelled = new Set<number>();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const request = e.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    loadingListeners.delete(request.id);
    return;
  }
  // Human SL ネットワークは、前の依頼を待たずに読み込み始め、その進み具合を知らせる
  if (request.type === "generate" && request.humanRank && !humanReady) {
    loadingListeners.add(request.id);
    if (loadingState)
      self.postMessage({
        ...loadingState,
        id: request.id,
      } satisfies WorkerResponse);
    loadHumanEvaluator(request.humanModelUrl).catch(() => {});
  }
  queue = queue.then(() => (request.type === "record" ? handleRecord(request) : handle(request)));
};

/** 実戦の棋譜から整地用の局面を作る。 */
async function handleRecord({
  id,
  record,
  forCpu,
  rules,
  fillDame,
  modelUrl,
}: Extract<WorkerRequest, { type: "record" }>): Promise<void> {
  try {
    const evaluate = await getEvaluator(modelUrl);
    const { position, ...rest } = await finishRecord(evaluate, record, forCpu, rules, fillDame);
    self.postMessage({
      type: "done",
      id,
      game: {
        ...rest,
        cells: position.board.cells,
        dead: position.board.dead,
        trays: position.trays,
      },
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
      human = await loadHumanEvaluator(humanModelUrl);
      humanInverseRank = inverseRank(humanRank);
    }
    if (cancelled.has(id)) throw new GenerationCancelled();
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
      game: {
        ...rest,
        cells: position.board.cells,
        dead: position.board.dead,
        trays: position.trays,
      },
    });
  } catch (err) {
    if (!(err instanceof GenerationCancelled)) evaluator = null;
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cancelled.delete(id);
  }
}
