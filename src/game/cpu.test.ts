import { describe, expect, it } from "vitest";
import { BLACK, Board, WHITE } from "../core/board";
import { Cpu } from "./cpu";
import { planLayouts } from "./layout";
import { Match, Player } from "./match";
import { Session } from "./session";

/**
 * 11 路。左上 5x5 が黒地（白の死に石 (1,1)）、右下 5x5 が白地（黒の死に石 (8,8)）、
 * ほかは石で埋めてある。どちらの地も、アゲハマ 5 個（死に石を含む）を埋めて 5x4 = 20 目にできる。
 */
function makeBoard(): Board {
  const board = new Board(11);
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 11; x++) {
      if ((x < 5 && y < 5) || (x > 5 && y > 5)) continue;
      board.set(x, y, x >= 5 && y >= 5 ? WHITE : BLACK);
    }
  }
  board.set(1, 1, WHITE, true);
  board.set(8, 8, BLACK, true);
  return board;
}

function setup(humanColor: typeof BLACK | typeof WHITE) {
  let t = 0;
  const position = { board: makeBoard(), trays: { [BLACK]: 4, [WHITE]: 4 } };
  const match = new Match(position, { undoOnPenalty: true, now: () => t });
  const human = new Player(match, { color: humanColor, restricted: true });
  const cpuPlayer = new Player(match, { color: humanColor === BLACK ? WHITE : BLACK });
  const layouts = planLayouts(position);
  const cpu = new Cpu(cpuPlayer, layouts);
  match.begin();
  return { match, human, cpuPlayer, cpu, tick: (ms: number) => (t += ms) };
}

describe("Cpu", () => {
  it("死に石を取り、相手の死に石が取られるのを待ってから整地して完了する", () => {
    const { human, cpuPlayer, cpu } = setup(BLACK);
    // CPU（白）は自分の地の中の黒の死に石 (8,8) を取る
    expect(cpu.step()).toEqual({ kind: "capture", point: 8 * 11 + 8 });
    expect(cpuPlayer.phase).toBe("arrange");
    // 担当の黒地に白の死に石 (1,1) が残っている間は待つ
    expect(cpu.step()).toEqual({ kind: "idle" });
    // 人（黒）が白の死に石を取る
    expect(human.capture(1 * 11 + 1)).toBe(true);

    let steps = 0;
    while (cpuPlayer.phase !== "finished" && steps < 200) {
      cpu.step();
      steps++;
    }
    expect(cpuPlayer.phase).toBe("finished");
    expect(cpuPlayer.penalties).toBe(0);
    expect(human.penalties).toBe(0);
    expect(cpuPlayer.position.trays[WHITE]).toBe(0); // 白が取った黒石はすべて黒地に埋めた
  });

  it("人が白でも、CPU（黒）が白地を整地して完了する", () => {
    const { human, cpuPlayer, cpu } = setup(WHITE);
    human.capture(8 * 11 + 8); // 人（白）は白地の中の黒の死に石を取る
    let steps = 0;
    while (cpuPlayer.phase !== "finished" && steps < 200) {
      cpu.step();
      steps++;
    }
    expect(cpuPlayer.phase).toBe("finished");
    expect(cpuPlayer.penalties).toBe(0);
  });

  it("担当外の石を制限する設定では、相手の色の石と自分のトレイしか使えない", () => {
    const { human } = setup(BLACK);
    // 人（黒）は白地を整地する: 黒石は持てない、白石は持てる
    expect(human.canPick(0 * 11 + 6)).toBe(false); // 黒石 (6,0)
    expect(human.canPick(6 * 11 + 5)).toBe(true); // 白石 (5,6)
    expect(human.canUseTray(BLACK)).toBe(true);
    expect(human.canUseTray(WHITE)).toBe(false);
    // 自分の地（黒地、CPU が整地する）には置けない
    expect(human.canPlace(0)).toBe(false);
  });

  it("ひとりでモードのおまかせ（ギブアップ）: 黒地・白地の両方を整地して完了する", () => {
    const position = { board: makeBoard(), trays: { [BLACK]: 4, [WHITE]: 4 } };
    const session = new Session(position, { undoOnPenalty: true });
    session.begin();
    const auto = new Cpu(session, planLayouts(position));
    let steps = 0;
    while (session.phase !== "finished" && steps < 300) {
      auto.step();
      steps++;
    }
    expect(session.phase).toBe("finished");
    expect(session.penalties).toBe(0);
  });
});
