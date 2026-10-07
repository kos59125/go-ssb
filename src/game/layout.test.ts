import { describe, expect, it } from "vitest";
import { BLACK, Board, WHITE } from "../core/board";
import { classifySection } from "../core/shapes";
import { planLayout } from "./layout";

/**
 * (2,2) から w x h の空点の領域を黒石で囲み、残りを白石で埋めた盤。黒地は w x h。
 * 囲みの黒石は白石に接するので、動かしてよい範囲（内側の石）に入らない。
 */
function regionBoard(w: number, h: number): Board {
  const size = Math.max(w, h) + 4;
  const board = new Board(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= 2 && x <= w + 1 && y >= 2 && y <= h + 1;
      const ring = x >= 1 && x <= w + 2 && y >= 1 && y <= h + 2;
      if (!inside) board.set(x, y, ring ? BLACK : WHITE);
    }
  }
  return board;
}

/** 計画の空点（区間）の外接矩形の幅・高さの一覧（連結成分ごと）。 */
function sectionShapes(board: Board, empties: Set<number>): string[] {
  const seen = new Set<number>();
  const result: string[] = [];
  for (const start of empties) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (const j of board.neighbors(i)) if (empties.has(j) && !seen.has(j)) (seen.add(j), stack.push(j));
    }
    const xs = comp.map((i) => i % board.size);
    const ys = comp.map((i) => Math.floor(i / board.size));
    result.push(`${Math.max(...xs) - Math.min(...xs) + 1}x${Math.max(...ys) - Math.min(...ys) + 1}:${comp.length}`);
  }
  return result.sort();
}

describe("planLayout の形", () => {
  it("10 目は 1x10 ではなく 2x5 にする", () => {
    const board = regionBoard(10, 2); // 20 目、アゲハマ 10 個 → 10 目
    const layout = planLayout(board, BLACK, 10)!;
    expect(sectionShapes(board, layout.empties)).toEqual(["5x2:10"]);
  });

  it("余り 7 目は 1x7 ではなく 2x3 にしっぽを付ける", () => {
    const board = regionBoard(7, 2); // 14 目、アゲハマ 7 個 → 7 目
    const layout = planLayout(board, BLACK, 7)!;
    const [shape] = sectionShapes(board, layout.empties);
    expect(shape).not.toBe("7x1:7");
    expect(shape.endsWith(":7")).toBe(true);
  });

  it("1 列しか作れない地では、設定で許されていれば 1 列の形を使う", () => {
    const board = regionBoard(10, 1);
    expect(sectionShapes(board, planLayout(board, BLACK, 0)!.empties)).toEqual(["10x1:10"]);
    expect(planLayout(board, BLACK, 0, undefined, { oneLineFrom: 10, allowFiveByOdd: false })).toBeNull();
  });

  it("5 × 奇数を認めるときだけ、3x5 = 15 目の区間を使う", () => {
    const board = regionBoard(5, 3); // 15 目、アゲハマなし
    expect(planLayout(board, BLACK, 0)).toBeNull();
    const layout = planLayout(board, BLACK, 0, undefined, { oneLineFrom: null, allowFiveByOdd: true })!;
    expect(sectionShapes(board, layout.empties)).toEqual(["5x3:15"]);
  });

  it("3x4−2 の形も使える", () => {
    // 3x4 の地（12 目）、アゲハマ 2 個 → 10 目。2x5 は入らないので 3x4−2（中央 2 点に石）
    const board = regionBoard(3, 4);
    const layout = planLayout(board, BLACK, 2)!;
    expect(layout.empties.size).toBe(10);
    // 中央の列 (3, 3)・(3, 4) が石
    expect(layout.empties.has(3 * board.size + 3)).toBe(false);
    expect(layout.empties.has(4 * board.size + 3)).toBe(false);
  });
});

describe("区間の形の設定", () => {
  const board = regionBoard(10, 2);
  const row = (n: number, y = 2) => Array.from({ length: n }, (_, k) => y * board.size + 2 + k);
  it("1 列の区間の制限", () => {
    expect(classifySection(board, row(10), BLACK).kind).toBe("multiple");
    expect(classifySection(board, row(10), BLACK, { oneLineFrom: 10, allowFiveByOdd: false }).kind).toBe("invalid");
    expect(classifySection(board, row(7), BLACK, { oneLineFrom: 10, allowFiveByOdd: false }).kind).toBe("remainder");
    expect(classifySection(board, row(7), BLACK, { oneLineFrom: 5, allowFiveByOdd: false }).kind).toBe("invalid");
    // 2x2+1 は 1 列ではない
    const tail = [...row(2, 2), ...row(2, 3), 2 * board.size + 4];
    expect(classifySection(board, tail, BLACK, { oneLineFrom: 5, allowFiveByOdd: false }).kind).toBe("remainder");
  });
  it("5 × 奇数", () => {
    const b = regionBoard(5, 3);
    const all = [2, 3, 4].flatMap((y) => [2, 3, 4, 5, 6].map((x) => y * b.size + x));
    expect(classifySection(b, all, BLACK).kind).toBe("invalid");
    expect(classifySection(b, all, BLACK, { oneLineFrom: null, allowFiveByOdd: true }).kind).toBe("multiple");
  });
  void WHITE;
});
