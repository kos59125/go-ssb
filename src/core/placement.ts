import { Board, Color, EMPTY } from "./board";

/** プレイヤーが持っている石。 */
export interface HeldStone {
  color: Color;
  dead: boolean;
}

/**
 * 持っている石をクリックした空点の周囲に置く（仕様書 §2.4）。
 *
 * クリックした空点と辺でつながっている空点にだけ、近い順（同じ距離なら上の行、
 * 左の列から）に、持った順で置く。空点が足りなければ残りを返す。
 *
 * @returns 石を置いた点のインデックスと、置ききれずに残った石
 */
export function placeStones(
  board: Board,
  start: number,
  stones: HeldStone[],
): { placed: number[]; remaining: HeldStone[] } {
  const placed: number[] = [];
  if (board.cells[start] !== EMPTY || stones.length === 0) {
    return { placed, remaining: stones };
  }

  const visited = new Set([start]);
  let layer = [start];
  const order: number[] = [];
  while (layer.length > 0 && order.length < stones.length) {
    layer.sort((a, b) => a - b);
    order.push(...layer);
    const next: number[] = [];
    for (const i of layer) {
      for (const j of board.neighbors(i)) {
        if (!visited.has(j) && board.cells[j] === EMPTY) {
          visited.add(j);
          next.push(j);
        }
      }
    }
    layer = next;
  }

  const count = Math.min(order.length, stones.length);
  for (let k = 0; k < count; k++) {
    const { x, y } = board.point(order[k]);
    board.set(x, y, stones[k].color, stones[k].dead);
    placed.push(order[k]);
  }
  return { placed, remaining: stones.slice(count) };
}
