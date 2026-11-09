import { Position, analyze } from "../core/analysis";
import { BLACK, EMPTY, WHITE } from "../core/board";

/** 終局図の複雑さの内訳（局面の棋力を選ぶのに使う）。 */
export interface Complexity {
  /** 地の領域（区間のもと）の数。地が細かく分かれているほど多い。 */
  regions: number;
  /** 地に接する生きた石の数（境界線の長さの目安）を、盤の 1 辺で割ったもの。 */
  boundary: number;
  /** 死に石の数。 */
  dead: number;
  /** アゲハマの数。 */
  prisoners: number;
  /** 生きた石の連の数。 */
  chains: number;
}

export function complexityOf(position: Position): Complexity {
  const { board, trays } = position;
  const { regions } = analyze(board);
  const territories = regions.filter((r) => r.territory && r.owner !== null);
  const inTerritory = new Set(territories.flatMap((r) => r.points));
  let boundary = 0;
  let dead = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === EMPTY) continue;
    if (board.dead[i] === 1) {
      dead++;
      continue;
    }
    if (board.neighbors(i).some((j) => inTerritory.has(j))) boundary++;
  }
  const seen = new Uint8Array(board.cells.length);
  let chains = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (seen[i] || board.cells[i] === EMPTY || board.dead[i] === 1) continue;
    chains++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      for (const j of board.neighbors(k)) {
        if (!seen[j] && board.cells[j] === board.cells[k] && board.dead[j] !== 1) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return {
    regions: territories.length,
    boundary: boundary / board.size,
    dead,
    prisoners: trays[BLACK] + trays[WHITE],
    chains,
  };
}

/** 局面の難しさ（設定）。 */
export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: "かんたん", normal: "ふつう", hard: "むずかしい" };

export function isDifficulty(value: unknown): value is Difficulty {
  return value === "easy" || value === "normal" || value === "hard";
}

/**
 * 複雑さの各項目の平均と標準偏差（盤のサイズごと）。自動で作った終局図
 * （9 路 120 局・13 路 80 局・19 路 33 局）から求めた値。
 */
const NORMS: Record<number, Record<keyof Complexity, [number, number]>> = {
  9: { regions: [8.6, 2.669], boundary: [3.294, 0.571], chains: [7.3, 2.1], dead: [0.558, 1.596], prisoners: [15.733, 7.723] },
  13: { regions: [16.425, 4.012], boundary: [4.868, 0.589], chains: [14.463, 3.778], dead: [2.487, 4.814], prisoners: [30.8, 12.65] },
  19: { regions: [31.206, 6.885], boundary: [7.26, 0.656], chains: [30.735, 5.175], dead: [9.265, 10.03], prisoners: [64.265, 25.088] },
};
/** 項目の重み。形の複雑さ（地の分かれ方・境界線・連）を重く、作業の量（死に石・アゲハマ）を軽く見る。 */
const WEIGHTS: Record<keyof Complexity, number> = { regions: 1, boundary: 1, chains: 1, dead: 0.5, prisoners: 0.5 };

/**
 * 終局図の複雑さの点数。0 がその盤のサイズのふつう、正なら複雑、負なら単純。
 * サンプルでは 20% 点が約 −2.1、80% 点が約 +2.1。
 */
export function complexityScore(position: Position): number {
  const size = position.board.size;
  const key = [9, 13, 19].reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
  const norm = NORMS[key];
  const c = complexityOf(position);
  let score = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof Complexity)[]) score += (WEIGHTS[k] * (c[k] - norm[k][0])) / norm[k][1];
  return score;
}

/**
 * 難しさごとの点数の範囲（重なりを持たせて、どの難しさでも半分前後の局面が当てはまるようにする）。
 * かんたん: −0.5 未満、ふつう: −1.5〜1.5、むずかしい: 0.5 より大きい。
 */
const RANGES: Record<Difficulty, [number, number]> = { easy: [-Infinity, -0.5], normal: [-1.5, 1.5], hard: [0.5, Infinity] };

/** 点数が難しさの範囲から外れている量（範囲内なら 0）。 */
export function difficultyMiss(score: number, difficulty: Difficulty): number {
  const [lo, hi] = RANGES[difficulty];
  return score < lo ? lo - score : score > hi ? score - hi : 0;
}
