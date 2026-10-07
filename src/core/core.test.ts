import { describe, expect, it } from "vitest";
import { Position, analyze, score } from "./analysis";
import { BLACK, Board, Color, WHITE, parseBoard } from "./board";
import { checkTerritory, isRemovalDone } from "./judge";
import { classifySection } from "./shapes";

/** (x, y) を含む領域の形を判定する。 */
function sectionAt(board: Board, x: number, y: number, color: Color = BLACK) {
  const { regions, regionOf } = analyze(board);
  return classifySection(board, regions[regionOf[board.index(x, y)]].points, color);
}

function position(text: string, trays = { [BLACK]: 0, [WHITE]: 0 }): Position {
  return { board: parseBoard(text), trays: { ...trays } };
}

describe("classifySection: 10 の倍数の区間", () => {
  it("3x4−2 は 10 目", () => {
    const board = parseBoard(`
      xxxxx
      x...x
      x.x.x
      x.x.x
      x...x
      xxxxx
    `);
    expect(sectionAt(board, 1, 1)).toEqual({ kind: "multiple", size: 10 });
  });

  it("4x3−2（90° 回転）も 10 目", () => {
    const board = parseBoard(`
      xxxxxx
      x....x
      x.xx.x
      x....x
      xxxxxx
    `);
    expect(sectionAt(board, 1, 1)).toEqual({ kind: "multiple", size: 10 });
  });

  it("盤端を使った 10x2 は 20 目", () => {
    const board = parseBoard(
      `
      ..........x
      ..........x
      xxxxxxxxxxx
    `,
      11,
    );
    expect(sectionAt(board, 0, 0)).toEqual({ kind: "multiple", size: 20 });
  });

  it("7x3−1 は 20 目", () => {
    const board = parseBoard(`
      xxxxxxxxx
      x.......x
      x...x...x
      x.......x
      xxxxxxxxx
    `);
    expect(sectionAt(board, 1, 1)).toEqual({ kind: "multiple", size: 20 });
  });

  it("7x6−2 は 40 目", () => {
    const board = parseBoard(`
      xxxxxxxxx
      x.......x
      x.......x
      x...x...x
      x...x...x
      x.......x
      x.......x
      xxxxxxxxx
    `);
    expect(sectionAt(board, 1, 1)).toEqual({ kind: "multiple", size: 40 });
  });

  it("4x4−6 は不可", () => {
    const board = parseBoard(`
      xxxxxx
      x....x
      x.xx.x
      x.xx.x
      x.xx.x
      xxxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });

  it("5x5−5 の十字は不可", () => {
    const board = parseBoard(`
      xxxxxxx
      x.....x
      x..x..x
      x.xxx.x
      x..x..x
      x.....x
      xxxxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });

  it("7x7+1 のしっぽ付きは不可", () => {
    const board = parseBoard(`
      xxxxxxxxx
      x.......x
      x.......x
      x.......x
      x.......x
      x.......x
      x.......x
      x.......x
      xxxxx.xxx
      xxxxxxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });

  it("10 の倍数でない矩形（3x4）は不可", () => {
    const board = parseBoard(`
      xxxxx
      x...x
      x...x
      x...x
      x...x
      xxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });

  it("内側の石が相手の色なら不可", () => {
    const board = parseBoard(`
      xxxxxxxxx
      x.......x
      x...o...x
      x.......x
      xxxxxxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });

  it("死に石が残っていれば不可", () => {
    const board = parseBoard(`
      xxxxxxxxxxxx
      x..........x
      x.....O....x
      xxxxxxxxxxxx
    `);
    expect(sectionAt(board, 1, 1).kind).toBe("invalid");
  });
});

describe("classifySection: 余りの区間", () => {
  it.each([
    ["2x3", "xxxxx\nx...x\nx...x\nxxxxx", 6],
    ["1x7", "xxxxxxxxx\nx.......x\nxxxxxxxxx", 7],
    ["2x2+1（しっぽ）", "xxxxx\nx..xx\nx...x\nxxxxx", 5],
    ["2x3+1（辺の途中のしっぽ）", "xxxxx\nx...x\nx...x\nxx.xx\nxxxxx", 7],
  ])("%s は余りの区間", (_, text, size) => {
    expect(sectionAt(parseBoard(text), 1, 1)).toEqual({ kind: "remainder", size });
  });

  it.each([
    ["偶数目のしっぽ付き（2x2+2）", "xxxxxx\nx..xxx\nx....x\nxxxxxx"],
    ["L 字（2+2+1）", "xxxxx\nx.xxx\nx.xxx\nx...x\nxxxxx"],
    ["しっぽが 2 つ（1x5+1+1）", "xxxxxxx\nx.....x\nxx.x.xx\nxxxxxxx"],
  ])("%s は不可", (_, text) => {
    expect(sectionAt(parseBoard(text), 1, 1).kind).toBe("invalid");
  });
});

/**
 * 黒: 4x5 = 20 と 3x3 = 9 の余り → 29 目
 * 白: 3x7−1 = 20 と 3x1 = 3 の余り → 23 目
 */
const FINISHED = `
  ....xo...
  ....xo...
  ....xo...
  ....xo.o.
  ....xo...
  xxxxxo...
  ...xxo...
  ...xxoooo
  ...xxo...
`;

describe("checkTerritory", () => {
  it("整地済みの地は完了", () => {
    const pos = position(FINISHED);
    expect(checkTerritory(pos, BLACK).complete).toBe(true);
    expect(checkTerritory(pos, WHITE).complete).toBe(true);
    expect(score(pos, BLACK)).toBe(29);
    expect(score(pos, WHITE)).toBe(23);
  });

  it("余りの区間が 2 つあれば未完了", () => {
    const pos = position(`
      ....xo...
      ....xo...
      ....xo...
      ....xo.o.
      xxxxxo...
      ....xo...
      xxxxxo...
      ...xxoooo
      ...xxo...
    `);
    const result = checkTerritory(pos, BLACK);
    expect(result.complete).toBe(false);
    expect(result.problems).toContain("余りの区間が 2 つある");
  });

  it("埋めていないアゲハマがあれば未完了", () => {
    const pos = position(FINISHED, { [BLACK]: 0, [WHITE]: 2 });
    expect(checkTerritory(pos, BLACK).complete).toBe(false);
    expect(score(pos, BLACK)).toBe(27);
  });

  it("地の空点がなくなれば、アゲハマが残っていても完了（目数はマイナス）", () => {
    const pos = position(
      `
      xxo
      x.o
      xxo
    `,
      { [BLACK]: 0, [WHITE]: 0 },
    );
    pos.board.set(1, 1, BLACK);
    pos.trays[WHITE] = 3;
    expect(checkTerritory(pos, BLACK).complete).toBe(true);
    expect(score(pos, BLACK)).toBe(-3);
  });

  it("区間どうしが頂点だけで接していても OK", () => {
    // 左上の 3x2 と右下の 4x5 は (2,1) と (3,2) の頂点で接する
    const pos = position(`
      ...xxxx
      ...xxxx
      xxx....
      xxx....
      xxx....
      xxx....
      xxx....
    `);
    const result = checkTerritory(pos, BLACK);
    expect(result.sections.map((s) => s.section)).toEqual([
      { kind: "remainder", size: 6 },
      { kind: "multiple", size: 20 },
    ]);
    expect(result.complete).toBe(true);
  });
});

describe("score の不変性", () => {
  it("死に石をトレイに移しても目数は変わらない", () => {
    const pos = position(`
      .....xo..
      ..O..xo..
      .....xo..
      .....xo.X
      .....xo..
      .....xo..
      .....xo..
      .....xo..
      .....xo..
    `);
    // 黒地 45 点（白の死に石の点を含む）− 盤上の黒の死に石 1 個
    expect(score(pos, BLACK)).toBe(44);
    const before = [score(pos, BLACK), score(pos, WHITE)];
    pos.board.set(2, 1, 0);
    pos.trays[BLACK]++;
    pos.board.set(8, 3, 0);
    pos.trays[WHITE]++;
    expect([score(pos, BLACK), score(pos, WHITE)]).toEqual(before);
  });

  it("アゲハマを正しい地に埋めれば目数は変わらず、間違えると変わる", () => {
    const pos = position(FINISHED, { [BLACK]: 1, [WHITE]: 1 });
    const black = score(pos, BLACK);
    const white = score(pos, WHITE);

    // 白が取った黒石を黒地に埋める → 変わらない
    pos.board.set(0, 0, BLACK);
    pos.trays[WHITE]--;
    expect(score(pos, BLACK)).toBe(black);

    // 黒が取った白石を黒地に埋める（誤り）→ 黒地が壊れる
    pos.board.set(1, 0, WHITE);
    pos.trays[BLACK]--;
    expect(score(pos, BLACK)).not.toBe(black);
    expect(score(pos, WHITE)).not.toBe(white);
  });
});

describe("セキ", () => {
  it("セキの石に接する領域は地に数えない", () => {
    const board = parseBoard(`
      .xxo.
      .xxo.
      .x.o.
      .xoo.
      .xoo.
    `);
    const pos: Position = { board, trays: { [BLACK]: 0, [WHITE]: 0 } };
    expect(score(pos, BLACK)).toBe(0);
    expect(score(pos, WHITE)).toBe(0);
  });
});

describe("isRemovalDone", () => {
  const board = parseBoard(`
    ..O..xo..
    .....xo..
    .....xo.X
    .....xo..
    .....xo..
    .....xo..
    .....xo..
    .....xo..
    .....xo..
  `);

  it("自分の地の中の相手の死に石だけを見る", () => {
    expect(isRemovalDone(board, BLACK)).toBe(false);
    expect(isRemovalDone(board, WHITE)).toBe(false);
    board.set(2, 0, 0);
    expect(isRemovalDone(board, BLACK)).toBe(true);
    expect(isRemovalDone(board, WHITE)).toBe(false);
  });

  it("色を省略するとすべての死に石を見る", () => {
    const b = board.clone();
    b.set(2, 0, 0);
    expect(isRemovalDone(b)).toBe(false);
    b.set(8, 2, 0);
    expect(isRemovalDone(b)).toBe(true);
  });
});
