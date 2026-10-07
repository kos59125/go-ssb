import { describe, expect, it } from "vitest";
import { analyze } from "../core/analysis";
import { BLACK, WHITE, parseBoard } from "../core/board";
import { Session } from "./session";

// 黒 (2,0)(2,1) と白 (4,0)(4,1) が (3,0)(3,1) を共有してセキ。外側の石は大きな地を持つ
const BOARD = `
  .ox.ox...
  .ox.ox...
  .ooox....
  ...ox....
  ...ox....
  ...ox....
  ...ox....
  ...ox....
  ...ox....
`;
const at = (x: number, y: number) => y * 9 + x;

describe("セキ", () => {
  it("セキの点: セキの石・共有の呼吸点・それに接する境界の石", () => {
    const { seki } = analyze(parseBoard(BOARD));
    expect([...seki].sort((a, b) => a - b)).toEqual(
      [at(2, 0), at(3, 0), at(4, 0), at(2, 1), at(3, 1), at(4, 1), at(3, 2)].sort((a, b) => a - b),
    );
  });

  it("セキの石を持とうとするとペナルティ（石は動かない）。範囲選択ではほかの石だけ持つ", () => {
    const session = new Session({ board: parseBoard(BOARD), trays: { [BLACK]: 0, [WHITE]: 0 } }, { undoOnPenalty: true });
    session.begin();
    expect(session.phase).toBe("arrange");
    expect(session.pickUp([at(2, 0)])).toBe(false);
    expect(session.penalties).toBe(1);
    expect(session.board.cells[at(2, 0)]).toBe(BLACK);
    expect(session.rejected.map((r) => r.point)).toEqual([at(2, 0)]);
    // 範囲選択: (1,0)(2,0) → (1,0) だけ持ち、ペナルティ 1 回
    expect(session.pickUp([at(1, 0), at(2, 0)])).toBe(true);
    expect(session.penalties).toBe(2);
    expect(session.hand!.stones.length).toBe(1);
  });

  it("セキの中の空点に置こうとするとペナルティ（石は持ったまま）", () => {
    const session = new Session({ board: parseBoard(BOARD), trays: { [BLACK]: 0, [WHITE]: 0 } }, { undoOnPenalty: true });
    session.begin();
    session.pickUp([at(1, 0)]);
    expect(session.placeAt(at(3, 0), WHITE)).toBe(false);
    expect(session.penalties).toBe(1);
    expect(session.hand!.stones.length).toBe(1);
    expect(session.board.cells[at(3, 0)]).toBe(0);
    // 元に戻すのは問題ない
    expect(session.placeAt(at(1, 0), WHITE)).toBe(true);
    expect(session.penalties).toBe(1);
  });
});
