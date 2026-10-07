import type { GeneratedGame } from "./generate";

/** ページから見たネットワークのパス。Worker からは相対パスが解決できないので、絶対 URL にして渡す。 */
export const MODEL_PATH = "models/kata1-b6c96-s175395328-d26788732.onnx";

export type WorkerRequest =
  | { type: "generate"; id: number; size: number; seed: number; modelUrl: string }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "progress"; id: number; move: number }
  | { type: "done"; id: number; game: SerializedGame }
  | { type: "error"; id: number; message: string };

/** Worker 間で受け渡すための形（Board のメソッドは送れない）。 */
export type SerializedGame = Omit<GeneratedGame, "position"> & {
  cells: Uint8Array;
  dead: Uint8Array;
  trays: GeneratedGame["position"]["trays"];
};
