import { Board, Color, EMPTY } from "./board";

export type Section =
  | { kind: "multiple"; size: number }
  | { kind: "remainder"; size: number }
  | { kind: "invalid"; size: number; reason: string };

/**
 * 10 の倍数の区間で、内側に石を置く形。
 * 座標は区間の外接矩形の左上を (0, 0) とする。
 */
const HOLE_PATTERNS: { w: number; h: number; holes: [number, number][] }[] = [
  // 3x4−2 = 10
  { w: 3, h: 4, holes: [[1, 1], [1, 2]] },
  { w: 4, h: 3, holes: [[1, 1], [2, 1]] },
  // 7x3−1 = 20
  { w: 7, h: 3, holes: [[3, 1]] },
  { w: 3, h: 7, holes: [[1, 3]] },
  // 7x6−2 = 40
  { w: 7, h: 6, holes: [[3, 2], [3, 3]] },
  { w: 6, h: 7, holes: [[2, 3], [3, 3]] },
];

/**
 * 地の 1 区間（空点の連結領域）の形を判定する。
 *
 * @param points 区間に含まれる点のインデックス
 * @param color 地の色。内側に置く石はこの色の生きた石でなければならない
 */
export function classifySection(board: Board, points: number[], color: Color): Section {
  const size = points.length;
  if (points.some((i) => board.cells[i] !== EMPTY)) {
    return { kind: "invalid", size, reason: "死に石が残っている" };
  }

  const inRegion = new Set(points);
  const { minX, minY, w, h } = bounds(board, points);
  const holes: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inRegion.has(board.index(minX + x, minY + y))) holes.push([x, y]);
    }
  }

  if (holes.length === 0) {
    if (size % 10 === 0) return { kind: "multiple", size };
    if (size < 10) return { kind: "remainder", size };
    return { kind: "invalid", size, reason: `${w}x${h} の矩形は 10 の倍数でない` };
  }

  const pattern = HOLE_PATTERNS.find((p) => p.w === w && p.h === h);
  if (pattern && sameHoles(pattern.holes, holes)) {
    const allStones = holes.every(([x, y]) => {
      const i = board.index(minX + x, minY + y);
      return board.cells[i] === color && board.isLiveStone(i);
    });
    if (allStones) return { kind: "multiple", size };
  }

  if (size < 10 && size % 2 === 1 && isRectangleWithTail(board, points)) {
    return { kind: "remainder", size };
  }

  return { kind: "invalid", size, reason: "許可されていない形" };
}

function bounds(board: Board, points: number[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of points) {
    const { x, y } = board.point(i);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function sameHoles(expected: [number, number][], actual: [number, number][]): boolean {
  return (
    expected.length === actual.length &&
    expected.every(([x, y]) => actual.some(([ax, ay]) => ax === x && ay === y))
  );
}

/** 矩形の辺に 1 マスのしっぽが付いた形か。 */
function isRectangleWithTail(board: Board, points: number[]): boolean {
  const inRegion = new Set(points);
  for (const tail of points) {
    const inner = board.neighbors(tail).filter((j) => inRegion.has(j));
    if (inner.length !== 1) continue;
    const rest = points.filter((i) => i !== tail);
    const { w, h } = bounds(board, rest);
    if (w * h === rest.length) return true;
  }
  return false;
}
