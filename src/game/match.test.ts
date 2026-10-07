import { describe, expect, it } from "vitest";
import { BLACK, Color, EMPTY, WHITE, parseBoard } from "../core/board";
import { mulberry32 } from "../core/random";
import { Match, Player, byDistanceFrom } from "./match";

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

  it("一度に持てる石は上限まで（範囲選択でもトレイからでも）", () => {
    const match = new Match({ board: parseBoard(BOARD), trays: { [BLACK]: 3, [WHITE]: 3 } }, { undoOnPenalty: true });
    const black = new Player(match, { color: BLACK, handLimit: 2 });
    const white = new Player(match, { color: WHITE, handLimit: 4 });
    match.begin();
    // 黒: 白石 3 個を範囲選択しても 2 個だけ持つ（上の行から）
    expect(black.pickUp([0 * 9 + 4, 1 * 9 + 4, 2 * 9 + 4])).toBe(true);
    expect(black.hand!.stones.map((s) => (s.source as { point: number }).point)).toEqual([4, 13]);
    expect(black.board.cells[2 * 9 + 4]).toBe(WHITE);
    expect(black.pickUp([3 * 9 + 4])).toBe(false);
    expect(black.pickFromTray(BLACK)).toBe(false);
    // 白: トレイから 3 個持つと、残りは 1 個
    expect(white.pickFromTray(WHITE, 3)).toBe(true);
    expect(white.handRoom).toBe(1);
    expect(white.pickFromTray(WHITE, 3)).toBe(false); // トレイは空
    expect(white.pickUp([0 * 9 + 3, 1 * 9 + 3])).toBe(true);
    expect(white.hand!.stones.length).toBe(4);
  });

  it("範囲選択で上限を超えるときは、起点に近い石から持つ", () => {
    const match = new Match({ board: parseBoard(BOARD), trays: { [BLACK]: 3, [WHITE]: 3 } }, { undoOnPenalty: true });
    const black = new Player(match, { color: BLACK, handLimit: 3 });
    match.begin();
    // (4,0)〜(5,7) の範囲を、右下 (5,7) を起点に選ぶ
    const rect: number[] = [];
    for (let y = 0; y <= 7; y++) for (let x = 4; x <= 5; x++) rect.push(y * 9 + x);
    expect(black.pickUp(byDistanceFrom(9, rect, 7 * 9 + 5))).toBe(true);
    expect(black.hand!.stones.map((s) => (s.source as { point: number }).point)).toEqual([7 * 9 + 5, 6 * 9 + 5, 7 * 9 + 4]);
  });

  it("相手が石を持っている最中（目数が一時的に変わって見える）でも、正しく置いた側はペナルティにならない", () => {
    const { match, black, white } = battle(false);
    // 白が自分の塊の中央 (6,6) を持ち上げたまま（白地が一時的に 1 目増えて見える）
    expect(white.pickUp([6 * 9 + 6])).toBe(true);
    // 黒が白地にアゲハマを正しく埋める
    expect(black.pickFromTray(BLACK)).toBe(true);
    expect(black.placeAt(0 * 9 + 8, WHITE)).toBe(true);
    expect(black.penalties).toBe(0);
    expect(match.scores()).toEqual(match.initialScores);
    // 白が元に戻しても誰もペナルティにならない
    white.cancel();
    expect(white.penalties).toBe(0);
    expect(black.penalties).toBe(0);
  });
});

