import { describe, expect, it } from "vitest";
import { BLACK, Color, EMPTY, WHITE, parseBoard } from "../core/board";
import { mulberry32 } from "../core/random";
import { Match, Player } from "./match";

/** 左が黒地、右が白地。白の 3x3 の塊 (5..7, 5..7) がある。 */
const BOARD = `
  ...xo....
  ...xo....
  ...xo....
  ...xo....
  ...xooooo
  ...xooooo
  ...xooooo
  ...xooooo
  ...x.o...
`;

function battle(restricted: boolean) {
  const match = new Match({ board: parseBoard(BOARD), trays: { [BLACK]: 3, [WHITE]: 3 } }, { undoOnPenalty: true });
  const black = new Player(match, { color: BLACK, restricted });
  const white = new Player(match, { color: WHITE, restricted });
  match.begin();
  return { match, black, white };
}

describe("対戦（2 人で同じ盤を操作）", () => {
  it("制限ありでは、白（黒地を整地）は黒石と境界線の白石だけ持てる（白の塊の中央は抜けない）", () => {
    const { white, black } = battle(true);
    expect(white.canPick(6 * 9 + 6)).toBe(false); // 白の塊の中央
    expect(white.canPick(4 * 9 + 5)).toBe(false); // 白地側の白石
    expect(white.canPick(0 * 9 + 4)).toBe(true); // 黒石に接する境界線の白石
    expect(white.canPick(0 * 9 + 3)).toBe(true); // 黒石
    expect(black.canPick(0 * 9 + 3)).toBe(true); // 黒も境界線の黒石は持てる
    expect(black.canPick(0 * 9 + 2)).toBe(false); // 空点
    expect(white.pickUp([6 * 9 + 6])).toBe(false);
    expect(white.board.get(6, 6)).toBe(WHITE);
  });

  it("境界が開いている間に目数を変えたのが白なら、境界を閉じた時点で白だけがペナルティになる", () => {
    const { match, black, white } = battle(false);
    // 黒が境界の黒石 (3,0) を駄目 (4,8) に動かす → 境界が開く（目数は変えない）
    black.pickUp([3]);
    black.placeAt(8 * 9 + 4, BLACK);
    expect(match.boundaryOpen).toBe(true);
    expect(black.penalties).toBe(0);
    // 白が白のトレイの黒石（アゲハマ）を (3,0) に置いて境界を閉じる → 黒の目数が 1 増える
    white.pickFromTray(WHITE);
    white.placeAt(3, BLACK);
    expect(white.penalties).toBe(1);
    expect(black.penalties).toBe(0);
    // 白の操作だけが元に戻る（黒の動かした石はそのまま）
    expect(match.board.cells[3]).toBe(EMPTY);
    expect(match.board.cells[8 * 9 + 4]).toBe(BLACK);
    expect(match.position.trays[WHITE]).toBe(3);
  });

  it("でたらめに操作し合っても、境界が閉じて手が空なら目数は開始時のまま（変化を見逃さない）", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
      const { match, black, white } = battle(false);
      const size = match.board.size;
      for (let step = 0; step < 300; step++) {
        const p = random() < 0.5 ? black : white;
        const cells = [...match.board.cells.keys()];
        if (p.hand) {
          if (random() < 0.1) p.dropToTray(p.color!);
          else p.placeAt(pick(cells.filter((i) => match.board.cells[i] === EMPTY)), pick([BLACK, WHITE]) as Color);
        } else if (random() < 0.2) {
          p.pickFromTray(p.color!);
        } else {
          p.pickUp([pick(cells.filter((i) => match.board.cells[i] !== EMPTY))]);
        }
        if (!black.hand && !white.hand && !match.boundaryOpen) {
          expect(match.scores(), `seed ${seed} step ${step}`).toEqual(match.initialScores);
        }
      }
      void size;
    }
  });
});
