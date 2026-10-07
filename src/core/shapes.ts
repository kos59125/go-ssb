import { Board, Color, EMPTY } from "./board";

export type Section =
  | { kind: "multiple"; size: number }
  | { kind: "remainder"; size: number }
  | { kind: "invalid"; size: number; reason: string };

/** 区間の形の追加ルール（ゲーム設定）。 */
export interface ShapeRules {
  /** この目数以上の区間は 1 列（幅か高さが 1）で作れない。null なら制限なし。 */
  oneLineFrom: number | null;
  /** 5 × 奇数（3x5 = 15、5x5 = 25 など）の矩形も区間として認めるか。 */
  allowFiveByOdd: boolean;
}

export const DEFAULT_SHAPE_RULES: ShapeRules = { oneLineFrom: null, allowFiveByOdd: false };

/** 5 × 奇数（3 以上）の矩形か。 */
export function isFiveByOdd(w: number, h: number): boolean {
  return (w === 5 && h % 2 === 1 && h >= 3) || (h === 5 && w % 2 === 1 && w >= 3);
}

/**
 * 10 の倍数の区間で、内側に石を置く形。
 * 座標は区間の外接矩形の左上を (0, 0) とする。
 */
export const HOLE_PATTERNS: { w: number; h: number; holes: [number, number][] }[] = [
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
export function classifySection(
  board: Board,
  points: number[],
  color: Color,
  rules: ShapeRules = DEFAULT_SHAPE_RULES,
): Section {
  const size = points.length;
  if (points.some((i) => board.cells[i] !== EMPTY)) {
    return { kind: "invalid", size, reason: "死に石が残っている" };
  }
  const section = classifyShape(board, points, color, rules);
  if (section.kind !== "invalid" && rules.oneLineFrom !== null && size >= rules.oneLineFrom && isOneLine(board, points)) {
    return { kind: "invalid", size, reason: `${rules.oneLineFrom} 目以上の区間は 1 列にできない（設定）` };
  }
  return section;
}

/**
 * 1 列の形か: 幅か高さが 1 の矩形、またはそれにしっぽを付けた形。
 */
export function isOneLine(board: Board, points: number[]): boolean {
  const { w, h } = bounds(board, points);
  if (w === 1 || h === 1) return true;
  const base = rectangleWithTailBase(board, points);
  return base !== null && (base.w === 1 || base.h === 1);
}

function classifyShape(board: Board, points: number[], color: Color, rules: ShapeRules): Section {
  const size = points.length;

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
    if (rules.allowFiveByOdd && isFiveByOdd(w, h)) return { kind: "multiple", size };
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
  return rectangleWithTailBase(board, points) !== null;
}

/** 矩形の辺に 1 マスのしっぽが付いた形なら、しっぽを除いた矩形の大きさ。 */
function rectangleWithTailBase(board: Board, points: number[]): { w: number; h: number } | null {
  const inRegion = new Set(points);
  let found: { w: number; h: number } | null = null;
  for (const tail of points) {
    const inner = board.neighbors(tail).filter((j) => inRegion.has(j));
    if (inner.length !== 1) continue;
    const rest = points.filter((i) => i !== tail);
    const { w, h } = bounds(board, rest);
    if (w * h !== rest.length) continue;
    // 2 列以上として読めるなら、そちらを採る（例: 2x2+1 は 1x4+1 とは読まない）
    if (w > 1 && h > 1) return { w, h };
    found ??= { w, h };
  }
  return found;
}
