import { Position } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";

/**
 * KataGo による終局図の生成（仕様書 §5）を実装するまでの仮の局面生成。
 *
 * 盤を上下に分ける境界線を引き、上を黒地、下を白地にする。
 * 地の中にでこぼこの石と相手の死に石を置き、アゲハマも少し持たせる。
 */
export function dummyPosition(size: number, seed = Date.now()): Position {
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const board = new Board(size);

  // 列ごとの境界の高さ（この行までが黒の領域）
  const heights: number[] = [];
  let h = int(Math.floor(size / 2) - 1, Math.floor(size / 2) + 1);
  for (let x = 0; x < size; x++) {
    h = Math.max(2, Math.min(size - 4, h + int(-1, 1)));
    heights.push(h);
  }
  const isBlackArea = (x: number, y: number) => y <= heights[x];

  // 境界に接する点を壁にする
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const black = isBlackArea(x, y);
      const touchesOther = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([nx, ny]) => board.inBounds(nx, ny) && isBlackArea(nx, ny) !== black);
      if (touchesOther) board.set(x, y, black ? BLACK : WHITE);
    }
  }

  const empties = (color: Color) => {
    const result: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (board.get(x, y) === EMPTY && isBlackArea(x, y) === (color === BLACK)) result.push(board.index(x, y));
      }
    }
    return result;
  };
  const neighborsOf = (i: number, color: Color) =>
    board.neighbors(i).filter((j) => board.cells[j] === color && board.dead[j] === 0);

  for (const color of [BLACK, WHITE] as const) {
    // 壁から地の中に張り出した石（でこぼこ）
    const bumps = int(1, Math.max(2, Math.floor(size / 3)));
    for (let k = 0; k < bumps; k++) {
      const candidates = empties(color).filter((i) => neighborsOf(i, color).length > 0);
      if (candidates.length === 0) break;
      const { x, y } = board.point(candidates[int(0, candidates.length - 1)]);
      board.set(x, y, color);
    }

    // 地の中の相手の死に石（相手の生きた石には接しない場所）
    const enemy = opponent(color);
    const deadCount = int(1, Math.max(2, Math.floor(size / 4)));
    for (let k = 0; k < deadCount; k++) {
      const candidates = empties(color).filter(
        (i) => neighborsOf(i, enemy).length === 0 && board.neighbors(i).length === 4,
      );
      if (candidates.length === 0) break;
      const { x, y } = board.point(candidates[int(0, candidates.length - 1)]);
      board.set(x, y, enemy, true);
    }
  }

  return { board, trays: { [BLACK]: int(0, Math.floor(size / 3)), [WHITE]: int(0, Math.floor(size / 3)) } };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
