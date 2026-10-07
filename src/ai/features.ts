import { Color, EMPTY, WHITE, opponent } from "../core/board";
import { GoGame, PASS } from "./go";

export const NUM_SPATIAL = 22;
export const NUM_GLOBAL = 19;

/**
 * KataGo の入力特徴量（V7、モデルバージョン 8〜10）を作る。
 * cpp/neuralnet/nninputs.cpp の fillRowV7 に従う。
 *
 * ルールは通常は日本ルール相当（地で数える、セキの地は数えない、単純なコウ）。
 * area を true にすると中国ルール相当（石と地で数える）になる。終局後の後始末
 * （ダメ埋めと手入れ）で、KataGo にダメや手入れの価値を認識させるために使う。
 * シチョウの特徴量（14〜17）、パスで生きが確定した領域（18, 19）、
 * エンコア関連（7, 8, 20, 21）は使わず 0 のまま。
 */
export function buildFeatures(
  game: GoGame,
  komi: number,
  area = false,
): { spatial: Float32Array; global: Float32Array } {
  const points = game.size * game.size;
  const spatial = new Float32Array(NUM_SPATIAL * points);
  const global = new Float32Array(NUM_GLOBAL);
  const pla: Color = game.toPlay;
  const opp = opponent(pla);
  const libs = game.libertyCounts();
  const set = (feature: number, i: number) => (spatial[feature * points + i] = 1);

  for (let i = 0; i < points; i++) {
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

  // 地で数えるとき、KataGo は着手 1 回ごとに 1 目を相手に足してネットワークに渡す
  // （boardhistory.cpp の whiteBonusScore）。ネットワークはアゲハマの数を見られないため、
  // 「地 + アゲハマ」を「石 + 地 − 着手数」として扱う
  let whiteBonus = 0;
  if (!area) {
    for (const move of moves) {
      if (move.point !== PASS) whiteBonus += move.color === WHITE ? -1 : 1;
    }
  }
  const whiteKomi = komi + whiteBonus;
  const selfKomi = pla === WHITE ? whiteKomi : -whiteKomi;
  global[5] = selfKomi / 20;
  if (area) {
    global[18] = komiParityWave(selfKomi, points);
  } else {
    global[9] = 1; // 地で数える
    global[10] = 1; // セキの地は数えない
  }
  global[14] = game.lastWasPass() ? 1 : 0; // パスで終局する
  return { spatial, global };
}

/** コミの偶奇の特徴量（石と地で数えるルールのとき）。fillRowV7 の末尾と同じ計算。 */
function komiParityWave(selfKomi: number, points: number): number {
  const drawableKomisAreEven = points % 2 === 0;
  const komiFloor = drawableKomisAreEven
    ? Math.floor(selfKomi / 2) * 2
    : Math.floor((selfKomi - 1) / 2) * 2 + 1;
  const delta = Math.min(2, Math.max(0, selfKomi - komiFloor));
  if (delta < 0.5) return delta;
  if (delta < 1.5) return 1 - delta;
  return delta - 2;
}
