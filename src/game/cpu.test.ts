import { describe, expect, it } from "vitest";
import { BLACK, Board, WHITE } from "../core/board";
import { mulberry32 } from "../core/random";
import { CPU_LEVELS, Cpu, CpuLevel } from "./cpu";
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

function setup(humanColor: typeof BLACK | typeof WHITE, level?: CpuLevel, seed = 1, undoOnPenalty = true) {
  let t = 0;
  const position = { board: makeBoard(), trays: { [BLACK]: 4, [WHITE]: 4 } };
  const match = new Match(position, { undoOnPenalty, now: () => t });
  const human = new Player(match, { color: humanColor, restricted: true });
  const cpuPlayer = new Player(match, { color: humanColor === BLACK ? WHITE : BLACK });
  const layouts = planLayouts(position);
  const cpu = new Cpu(cpuPlayer, layouts, { level, random: mulberry32(seed) });
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

  for (const undoOnPenalty of [true, false]) {
    it(`弱い CPU は整地ミス（ペナルティ）や無駄な操作をしても、最後は完了する（ペナルティ時: ${undoOnPenalty ? "元に戻す" : "そのまま"}）`, () => {
      let mistakes = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const { human, cpuPlayer, cpu, match } = setup(BLACK, "beginner", seed, undoOnPenalty);
        human.capture(1 * 11 + 1);
        let steps = 0;
        while (cpuPlayer.phase !== "finished" && steps < 1000) {
          cpu.step();
          steps++;
        }
        expect(cpuPlayer.phase, `seed ${seed}`).toBe("finished");
        expect(human.penalties).toBe(0);
        expect(match.scores()).toEqual(match.initialScores);
        mistakes += cpuPlayer.penalties;
      }
      expect(mistakes).toBeGreaterThan(0);
    });
  }

  it("達人の CPU はミスをしない", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { human, cpuPlayer, cpu } = setup(BLACK, "expert", seed);
      human.capture(1 * 11 + 1);
      let steps = 0;
      while (cpuPlayer.phase !== "finished" && steps < 200) {
        cpu.step();
        steps++;
      }
      expect(cpuPlayer.phase).toBe("finished");
      expect(cpuPlayer.penalties).toBe(0);
    }
  });

  it("計画を立てた後に範囲の石が境界の石になったら、計画を立て直してその石を動かさない", () => {
    const { human, cpu, match } = setup(BLACK);
    human.capture(1 * 11 + 1);
    type Plan = { area: Set<number> } | null;
    const validPlan = (cpu as unknown as { validPlan(c: number): Plan }).validPlan.bind(cpu);
    const board = match.board;
    const area = validPlan(BLACK)!.area;
    // 範囲の黒石と、それに接する範囲外の黒石
    const inner = [...area].find((i) => board.cells[i] === BLACK && board.neighbors(i).some((j) => board.cells[j] === BLACK && !area.has(j)))!;
    const outside = board.neighbors(inner).find((j) => board.cells[j] === BLACK && !area.has(j))!;
    expect(inner).toBeDefined();
    // 相手が範囲外の石を白石に替えると、inner は境界の石になる
    board.set(outside % 11, Math.floor(outside / 11), WHITE);
    expect(validPlan(BLACK)?.area.has(inner) ?? false).toBe(false);
  });

  it("どの強さでも、どちらのペナルティ設定でも、最後は完了する", () => {
    for (const level of Object.keys(CPU_LEVELS) as CpuLevel[]) {
      for (const undoOnPenalty of [true, false]) {
        for (let seed = 1; seed <= 40; seed++) {
          const { human, cpuPlayer, cpu, match } = setup(BLACK, level, seed, undoOnPenalty);
          human.capture(1 * 11 + 1);
          let steps = 0;
          while (cpuPlayer.phase !== "finished" && steps < 1000) {
            cpu.step();
            steps++;
          }
          expect(cpuPlayer.phase, `${level} ${undoOnPenalty} seed ${seed}`).toBe("finished");
          expect(match.scores()).toEqual(match.initialScores);
        }
      }
    }
  });

  it("強い CPU は石をまとめて持ち、少ない操作で整地する", () => {
    const run = (level: CpuLevel) => {
      const { human, cpuPlayer, cpu } = setup(BLACK, level);
      human.capture(1 * 11 + 1);
      let steps = 0;
      let maxHand = 0;
      while (cpuPlayer.phase !== "finished" && steps < 200) {
        cpu.step();
        maxHand = Math.max(maxHand, cpuPlayer.hand?.stones.length ?? 0);
        steps++;
      }
      return { steps, maxHand };
    };
    const expert = run("expert");
    expect(expert.maxHand).toBeGreaterThan(1);
    expect(expert.steps).toBeLessThan(run("easy").steps);
  });
});
