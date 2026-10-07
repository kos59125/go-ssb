import type { InferenceSession, Tensor } from "onnxruntime-web";
import { BLACK } from "../core/board";
import { NUM_GLOBAL, NUM_SPATIAL, buildFeatures } from "./features";
import { GoGame } from "./go";

/** ネットワークの評価結果。すべて黒から見た値に直してある。 */
export interface Evaluation {
  /** 着手の確率（盤の点 + 最後がパス）。手番側の着手。 */
  policy: Float32Array;
  /** 黒の勝率。 */
  blackWinrate: number;
  /** 黒のリード（目）。 */
  blackLead: number;
  /** 各点の所有権（+1 黒、−1 白）。 */
  ownership: Float32Array;
}

/** area: 中国ルール相当（石と地で数える）で評価する。 */
export type Evaluator = (game: GoGame, options?: { area?: boolean }) => Promise<Evaluation>;

type Ort = {
  InferenceSession: typeof InferenceSession;
  Tensor: typeof Tensor;
};

/** ONNX に変換した KataGo のネットワークで評価する関数を作る。 */
export async function createEvaluator(ort: Ort, model: string | Uint8Array, komi: number): Promise<Evaluator> {
  const session =
    typeof model === "string" ? await ort.InferenceSession.create(model) : await ort.InferenceSession.create(model);
  return async (game, options) => {
    const n = game.size;
    const { spatial, global } = buildFeatures(game, komi, options?.area);
    const out = await session.run({
      spatial: new ort.Tensor("float32", spatial, [1, NUM_SPATIAL, n, n]),
      global: new ort.Tensor("float32", global, [1, NUM_GLOBAL]),
    });
    const sign = game.toPlay === BLACK ? 1 : -1;

    const logits = out.policy.data as Float32Array;
    const policy = softmax(logits);

    const v = softmax(out.value.data as Float32Array);
    const score = out.score.data as Float32Array;
    // score: [scoreMean, scoreStdev, lead, ...]（/20 されている）
    const lead = (score.length > 2 ? score[2] : score[0]) * 20;

    const own = out.ownership.data as Float32Array;
    const ownership = new Float32Array(own.length);
    for (let i = 0; i < own.length; i++) ownership[i] = sign * Math.tanh(own[i]);

    return {
      policy,
      blackWinrate: sign === 1 ? v[0] : v[1],
      blackLead: sign * lead,
      ownership,
    };
  };
}

function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (const l of logits) max = Math.max(max, l);
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}
