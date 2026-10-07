import { Color, EMPTY, WHITE, opponent } from "../core/board";
import { GoGame, PASS } from "./go";

export const NUM_SPATIAL = 22;
export const NUM_GLOBAL = 19;

/**
 * KataGo の入力特徴量（V7、モデルバージョン 8〜10）を作る。
 * cpp/neuralnet/nninputs.cpp の fillRowV7 に従う。
 *
 * ルールは日本ルール相当（地で数える、セキの地は数えない、単純なコウ）。
 * シチョウの特徴量（14〜17）とエンコア関連（7, 8, 18〜21）は使わず 0 のまま。
 */
export function buildFeatures(game: GoGame, komi: number): { spatial: Float32Array; global: Float32Array } {
  const area = game.size * game.size;
  const spatial = new Float32Array(NUM_SPATIAL * area);
  const global = new Float32Array(NUM_GLOBAL);
  const pla: Color = game.toPlay;
  const opp = opponent(pla);
  const libs = game.libertyCounts();
  const set = (feature: number, i: number) => (spatial[feature * area + i] = 1);

  for (let i = 0; i < area; i++) {
    set(0, i);
    const stone = game.cells[i];
    if (stone === EMPTY) continue;
    set(stone === pla ? 1 : 2, i);
    if (libs[i] >= 1 && libs[i] <= 3) set(2 + libs[i], i);
  }
  if (game.koPoint >= 0) set(6, game.koPoint);

  // 直近 5 手（相手・自分・相手…の順）
  const moves = game.moves;
  for (let k = 0; k < 5 && k < moves.length; k++) {
    const move = moves[moves.length - 1 - k];
    if (move.color !== (k % 2 === 0 ? opp : pla)) break;
    if (move.point === PASS) global[k] = 1;
    else set(9 + k, move.point);
  }

  const selfKomi = pla === WHITE ? komi : -komi;
  global[5] = selfKomi / 20;
  global[9] = 1; // 地で数える
  global[10] = 1; // セキの地は数えない
  global[14] = game.lastWasPass() ? 1 : 0; // パスで終局する
  return { spatial, global };
}
