import { describe, expect, it } from "vitest";
import { analyze } from "../core/analysis";
import { BLACK, WHITE, parseBoard } from "../core/board";
import { dummyPosition } from "./dummy";
import { Session } from "./session";

/**
 * 黒地 (0..3, 0..4) と白地。白の死に石が黒地に 1 つ、黒の死に石が白地に 1 つ。
 */
const BOARD = `
  ....xo...
  ..O.xo...
  ....xo...
  ....xo...
  ....xo.X.
  xxxxxo...
  ...xxo...
  ...xxoooo
  ...xxo...
`;

function session(undoOnPenalty = true, trays = { [BLACK]: 0, [WHITE]: 0 }) {
  let t = 0;
  const s = new Session({ board: parseBoard(BOARD), trays }, { undoOnPenalty, now: () => t });
  return { s, tick: (ms: number) => (t += ms) };
}

describe("Session", () => {
  it("死に石を取り終えると整地フェーズに移る", () => {
    const { s } = session();
    expect(s.phase).toBe("removal");
    const b = s.board;
    expect(s.pickUp([b.index(2, 1)])).toBe(true);
    expect(s.dropToTray(BLACK)).toBe(true);
    expect(s.phase).toBe("removal");
    s.pickUp([b.index(7, 4)]);
    s.dropToTray(WHITE);
    expect(s.phase).toBe("arrange");
    expect(s.penalties).toBe(0);
    expect(s.position.trays).toEqual({ [BLACK]: 1, [WHITE]: 1 });
  });

  it("死に石取りで生きた石を取るとペナルティで、設定によらず元に戻る", () => {
    const { s } = session(false);
    const i = s.board.index(4, 0);
    s.pickUp([i]);
    s.dropToTray(WHITE);
    expect(s.penalties).toBe(1);
    expect(s.board.cells[i]).toBe(BLACK);
    expect(s.marks.size).toBe(0);
  });

  it("相手の地に置くとペナルティ。元に戻す設定なら戻る", () => {
    const { s } = session(true, { [BLACK]: 1, [WHITE]: 0 });
    removeDead(s);
    // 黒が取った白石を黒地に置く（誤り）
    s.pickFromTray(BLACK);
    s.placeAt(s.board.index(0, 0));
    expect(s.penalties).toBe(1);
    expect(s.board.get(0, 0)).toBe(0);
    expect(s.position.trays[BLACK]).toBe(2);
  });

  it("元に戻さない設定では印を付け、直すと印が消える", () => {
    const { s } = session(false, { [BLACK]: 1, [WHITE]: 0 });
    removeDead(s);
    const wrong = s.board.index(0, 0);
    s.pickFromTray(BLACK);
    s.placeAt(wrong);
    expect(s.penalties).toBe(1);
    expect([...s.marks]).toEqual([wrong]);

    // 黒地の別の場所に動かしても印は付いたまま
    s.pickUp([wrong]);
    expect(s.marks.size).toBe(0);
    s.placeAt(s.board.index(1, 1));
    expect(s.penalties).toBe(1);
    expect([...s.marks]).toEqual([s.board.index(1, 1)]);

    // 白地に置き直す
    s.pickUp([s.board.index(1, 1)]);
    expect(s.marks.size).toBe(0);
    s.placeAt(s.board.index(8, 8));
    expect(s.penalties).toBe(1);
    expect(s.marks.size).toBe(0);
    expect(s.scores()).toEqual(s.initialScores);
  });

  it("元の位置を再クリックすると持つのをやめる", () => {
    const { s } = session();
    const i = s.board.index(2, 1);
    s.pickUp([i]);
    expect(s.isOrigin(i)).toBe(true);
    s.cancel();
    expect(s.hand).toBeNull();
    expect(s.board.isDead(2, 1)).toBe(true);
  });

  it("完了の判定とタイム", () => {
    const { s, tick } = session();
    removeDead(s);
    tick(10_000);
    // まだ整地していない → ペナルティ
    const result = s.complete({ [BLACK]: 0, [WHITE]: 0 });
    expect(result.ok).toBe(false);
    expect(s.penalties).toBe(1);
    expect(s.elapsed()).toBe(15_000);
  });
});

function removeDead(s: Session) {
  const b = s.board;
  for (let i = 0; i < b.cells.length; i++) {
    if (b.dead[i] !== 1) continue;
    const color = b.cells[i];
    s.pickUp([i]);
    s.dropToTray(color === BLACK ? WHITE : BLACK);
  }
  expect(s.phase).toBe("arrange");
}

describe("dummyPosition", () => {
  it.each([9, 13, 19])("%i 路で、ダメがなく両方に地がある局面を作る", (size) => {
    for (let seed = 1; seed <= 20; seed++) {
      const { board } = dummyPosition(size, seed);
      const { regions } = analyze(board);
      expect(regions.every((r) => r.owner !== null)).toBe(true);
      expect(regions.some((r) => r.owner === BLACK)).toBe(true);
      expect(regions.some((r) => r.owner === WHITE)).toBe(true);
    }
  });
});
