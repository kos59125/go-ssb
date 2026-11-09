import type { GeneratedGame } from "./generate";
import type { ShapeRules } from "../core/shapes";
import type { GameRecord } from "./sgf";

/** ページから見たネットワークのパス。Worker からは相対パスが解決できないので、絶対 URL にして渡す。 */
export const MODEL_PATH = "models/kata1-b6c96-s175395328-d26788732.onnx";
/** Human SL ネットワーク（終局図の打ち手の棋力を指定するとき、本局の手を選ぶのに使う）。 */
export const HUMAN_MODEL_PATH = "models/b18c384nbt-humanv0-int8.onnx";

export type WorkerRequest =
  | {
      type: "generate";
      id: number;
      size: number;
      seed: number;
      forCpu: boolean;
      rules: ShapeRules;
      modelUrl: string;
      /** 本局の打ち手の棋力（例: "10k"、"1d"）。null なら従来のネットワークだけで打つ。 */
      humanRank: string | null;
      humanModelUrl: string;
    }
  | {
      type: "record";
      id: number;
      record: GameRecord;
      forCpu: boolean;
      rules: ShapeRules;
      /** ダメが残っていたら、エラーにせずに埋めて進める。 */
      fillDame: boolean;
      modelUrl: string;
    }
  | { type: "cancel"; id: number };

export type WorkerResponse =
  | { type: "progress"; id: number; move: number }
  /** Human SL ネットワークを読み込み中（初回のみ）。 */
  | { type: "loading"; id: number }
  | { type: "done"; id: number; game: SerializedGame }
  | { type: "error"; id: number; message: string; dame?: DameInfo };

/** 棋譜の終局図にダメが残っているときの詳細（どこがダメかを盤に示すため）。 */
export interface DameInfo {
  size: number;
  /** 棋譜の終局図の石。 */
  cells: Uint8Array;
  /** ダメ（詰めていない、両方の色に接する空点）。 */
  points: number[];
}

/** 棋譜の終局図のダメが詰まっていない。 */
export class UnfilledDameError extends Error {
  readonly dame: DameInfo;
  constructor(message: string, dame: DameInfo) {
    super(message);
    this.dame = dame;
  }
}

/** Worker 間で受け渡すための形（Board のメソッドは送れない）。 */
export type SerializedGame = Omit<GeneratedGame, "position"> & {
  cells: Uint8Array;
  dead: Uint8Array;
  trays: GeneratedGame["position"]["trays"];
};
