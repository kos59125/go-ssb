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
  s.begin();
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

  it("終局図からやり直すと盤とアゲハマが戻り、タイマーとペナルティは続く", () => {
    const { s, tick } = session(true, { [BLACK]: 1, [WHITE]: 0 });
    removeDead(s);
    s.pickFromTray(BLACK);
    s.placeAt(s.board.index(0, 0)); // 誤り → ペナルティ
    tick(3000);
    s.pickUp([s.board.index(4, 0)]);
    s.reset();
    expect(s.hand).toBeNull();
    expect(s.phase).toBe("removal");
    expect(s.board.isDead(2, 1)).toBe(true);
    expect(s.board.get(4, 0)).toBe(BLACK);
    expect(s.position.trays).toEqual({ [BLACK]: 1, [WHITE]: 0 });
    expect(s.penalties).toBe(1);
    expect(s.elapsed()).toBe(3000 + 5000);
  });

  it("合図の前はタイムが進まない", () => {
    let t = 0;
    const s = new Session({ board: parseBoard(BOARD), trays: { [BLACK]: 0, [WHITE]: 0 } }, { undoOnPenalty: true, now: () => t });
    t = 5000;
    expect(s.elapsed()).toBe(0);
    s.begin();
    t = 7000;
    expect(s.elapsed()).toBe(2000);
  });

  it("トレイには 1 回に 1 個ずつ入れる", () => {
    const { s } = session(true, { [BLACK]: 3, [WHITE]: 0 });
    removeDead(s);
    s.pickFromTray(BLACK, 3);
    expect(s.dropToTray(BLACK)).toBe(true);
    expect(s.hand?.stones).toHaveLength(2);
    expect(s.position.trays[BLACK]).toBe(2);
  });

  it("死に石取りでは、クリックした石がそのままアゲハマトレイに入る", () => {
    const { s } = session();
    expect(s.capture(s.board.index(2, 1))).toBe(true);
    expect(s.hand).toBeNull();
    expect(s.position.trays[BLACK]).toBe(1);
    expect(s.capture(s.board.index(7, 4))).toBe(true);
    expect(s.position.trays[WHITE]).toBe(1);
    expect(s.phase).toBe("arrange");
    // 生きた石はペナルティで元に戻る
    const { s: t } = session();
    t.capture(t.board.index(4, 0));
    expect(t.penalties).toBe(1);
    expect(t.rejected).toEqual([{ point: t.board.index(4, 0), color: BLACK }]);
    expect(t.board.get(4, 0)).toBe(BLACK);
    expect(t.hand).toBeNull();
  });

  it("死に石取りで、境界でない生きた石（目数が変わらない石）を取ってもペナルティ", () => {
    // 黒地の中の黒石 (1,1) は取っても「地 +1・アゲハマ +1」で目数が変わらない
    const board = parseBoard(`
      ....xo...
      .x..xo...
      ..O.xo...
      ....xo...
      xxxxxo...
      .....o...
      ooooooooo
      .........
      .........
    `);
    const s = new Session({ board, trays: { [BLACK]: 0, [WHITE]: 0 } }, { undoOnPenalty: false });
    s.capture(board.index(1, 1));
    expect(s.penalties).toBe(1);
    expect(s.board.get(1, 1)).toBe(BLACK);
    expect(s.position.trays[WHITE]).toBe(0);
    expect(s.rejected).toEqual([{ point: board.index(1, 1), color: BLACK }]);
  });

  it("整地中は、アゲハマの総数より多くトレイに入れられない", () => {
    const { s } = session(true, { [BLACK]: 1, [WHITE]: 0 });
    removeDead(s);
    // 黒のトレイ: 対局中のアゲハマ 1 + 白の死に石 1 = 2 個まで
    expect(s.trayCapacity[BLACK]).toBe(2);
    // 盤上の白石をトレイに入れようとしても入らない
    s.pickUp([s.board.index(5, 0)]);
    expect(s.dropToTray(BLACK)).toBe(false);
    s.cancel();
    // トレイから出した分は戻せる
    s.pickFromTray(BLACK, 1);
    expect(s.dropToTray(BLACK)).toBe(true);
    expect(s.position.trays[BLACK]).toBe(2);
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

  it("石を持っている最中に別の石を追加で持てる", () => {
    const { s } = session();
    const a = s.board.index(4, 0);
    const b = s.board.index(4, 1);
    expect(s.pickUp([a])).toBe(true);
    expect(s.pickUp([b])).toBe(true);
    expect(s.hand?.stones).toHaveLength(2);
    // 元に戻すと両方戻る
    s.cancel();
    expect(s.board.get(4, 0)).toBe(BLACK);
    expect(s.board.get(4, 1)).toBe(BLACK);
    expect(s.penalties).toBe(0);
  });

  it("複数持っているときは、クリックごとに持った順で 1 個ずつ置く", () => {
    const { s } = session(true, { [BLACK]: 0, [WHITE]: 0 });
    removeDead(s);
    // 黒の壁 (4,0) (4,1) を持ち、1 個ずつ置き直す
    const a = s.board.index(4, 0);
    const b = s.board.index(4, 1);
    s.pickUp([a, b]);
    expect(s.placeAt(b)).toBe(true);
    expect(s.hand?.stones).toHaveLength(1);
    expect(s.board.get(4, 1)).toBe(BLACK);
    expect(s.board.get(4, 0)).toBe(0);
    expect(s.placeAt(a)).toBe(true);
    expect(s.hand).toBeNull();
    expect(s.penalties).toBe(0);
  });

  it("アゲハマと盤上の石を混ぜて持て、やめるとそれぞれ元の場所に戻る", () => {
    const { s } = session(true, { [BLACK]: 2, [WHITE]: 0 });
    removeDead(s);
    const trays = { ...s.position.trays };
    expect(s.pickFromTray(BLACK, 2)).toBe(true);
    expect(s.pickUp([s.board.index(4, 0)])).toBe(true);
    expect(s.hand?.stones.map((x) => x.color)).toEqual([WHITE, WHITE, BLACK]);
    s.cancel();
    expect(s.hand).toBeNull();
    expect(s.position.trays).toEqual(trays);
    expect(s.board.get(4, 0)).toBe(BLACK);
  });

  it("色を指定して置ける（白黒の入れ替え）", () => {
    const { s } = session();
    removeDead(s);
    const black = s.board.index(4, 2);
    const white = s.board.index(5, 2);
    s.pickUp([black, white]);
    // 黒を指定して白の元の点に置き、残りの白を黒の元の点に置く（持っていない色を指定したら残りの石）
    expect(s.placeAt(white, BLACK)).toBe(true);
    expect(s.board.get(5, 2)).toBe(BLACK);
    expect(s.placeAt(black, BLACK)).toBe(true);
    expect(s.board.get(4, 2)).toBe(WHITE);
  });

  describe("境界の石を動かす", () => {
    // 黒地 14 点、白地 21 点。黒は白石を 1 個取っている
    const WALL = `
      ..xo...
      ..xo...
      ..xo...
      ..xo...
      ..xo...
      ..xo...
      ..xo...
    `;
    const start = (undoOnPenalty = true) =>
      new Session({ board: parseBoard(WALL), trays: { [BLACK]: 1, [WHITE]: 0 } }, { undoOnPenalty });

    it("境界が開いている間は判定せず、閉じたときに目数が同じならペナルティなし", () => {
      const s = start();
      const before = s.scores();
      // 黒石に接する白の壁 (3,3) を白地の中へ → 境界が開く
      s.pickUp([s.board.index(3, 3)]);
      s.placeAt(s.board.index(6, 6));
      expect(s.boundaryOpen).toBe(true);
      expect(s.penalties).toBe(0);
      // 空いた壁をアゲハマ（白石）で塞ぐ → 白地 −1、アゲハマ −1 で目数は同じ
      s.pickFromTray(BLACK);
      s.placeAt(s.board.index(3, 3));
      expect(s.boundaryOpen).toBe(false);
      expect(s.penalties).toBe(0);
      expect(s.scores()).toEqual(before);
    });

    it("閉じたときに目数が変わっていれば、境界が開く前まで戻してペナルティ", () => {
      const s = new Session(
        { board: parseBoard(WALL), trays: { [BLACK]: 1, [WHITE]: 1 } },
        { undoOnPenalty: true },
      );
      // 白の壁 (3,3) を白地側に 1 つずらす → (3,3) が中立になり境界が開く
      s.pickUp([s.board.index(3, 3)]);
      s.placeAt(s.board.index(4, 3));
      expect(s.boundaryOpen).toBe(true);
      expect(s.penalties).toBe(0);
      // 黒のアゲハマ（黒石）で塞ぐ → 境界は閉じるが目数が変わる
      s.pickFromTray(WHITE);
      s.placeAt(s.board.index(3, 3));
      expect(s.penalties).toBe(1);
      expect(s.board.get(3, 3)).toBe(WHITE);
      expect(s.board.get(4, 3)).toBe(0);
      expect(s.position.trays[WHITE]).toBe(1);
      expect(s.boundaryOpen).toBe(false);
    });

    it("境界が開いている間でも、相手の地に置けばその場でペナルティ", () => {
      const s = new Session(
        { board: parseBoard(WALL), trays: { [BLACK]: 1, [WHITE]: 1 } },
        { undoOnPenalty: true },
      );
      s.pickUp([s.board.index(3, 3)]);
      s.placeAt(s.board.index(6, 6));
      // 黒石を白地に置く
      s.pickFromTray(WHITE);
      s.placeAt(s.board.index(5, 0));
      expect(s.penalties).toBe(1);
      expect(s.board.get(5, 0)).toBe(0);
    });

    it("盤上の石を相手の地に動かしても、境界が閉じるまではペナルティにしない", () => {
      const s = start();
      // 黒の壁 (2,0) を白地の (4,0) へ（境界線をずらす途中）
      s.pickUp([s.board.index(2, 0)]);
      s.placeAt(s.board.index(4, 0));
      expect(s.penalties).toBe(0);
      expect(s.boundaryOpen).toBe(true);
    });

    it("境界が開いたままでは完了できない", () => {
      const s = start();
      s.pickUp([s.board.index(3, 3)]);
      s.placeAt(s.board.index(6, 6));
      const result = s.complete(s.initialScores);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems).toContain("境界が開いている");
    });
  });

  it("元の位置に置くと、その点から持ち上げた石が戻る", () => {
    const { s } = session();
    removeDead(s);
    const a = s.board.index(4, 0);
    const b = s.board.index(5, 0);
    s.pickUp([a, b]);
    // 最初に持ったのは黒だが、白 (5,0) の元の位置には白が戻る
    s.placeAt(b);
    expect(s.board.get(5, 0)).toBe(WHITE);
    s.placeAt(a);
    expect(s.board.get(4, 0)).toBe(BLACK);
    expect(s.penalties).toBe(0);
  });

  it("完了に失敗したら、形の違う区間の場所と目数の違う色を返す", () => {
    const { s } = session();
    removeDead(s);
    const result = s.complete({ [BLACK]: s.initialScores[BLACK], [WHITE]: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.wrongAnswers).toEqual([WHITE]);
    // 白地 (6..8, 0..6) は 3x7=21 目で 10 の倍数でも余りでもない。黒地 4x5=20 目は正しい
    expect(result.errorPoints).toContain(s.board.index(6, 0));
    expect(result.errorPoints).not.toContain(s.board.index(0, 0));
  });

  it("地に別の色の石が混ざっていたら、その石の場所を返す", () => {
    const { s } = session(false, { [BLACK]: 1, [WHITE]: 0 });
    removeDead(s);
    s.pickFromTray(BLACK);
    s.placeAt(s.board.index(1, 1)); // 白石を黒地に（ペナルティになり、印が付く）
    const result = s.complete(s.initialScores);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorPoints).toContain(s.board.index(1, 1));
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
