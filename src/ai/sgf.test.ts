import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { analyze, score } from "../core/analysis";
import { BLACK, WHITE } from "../core/board";
import { KOMI, finishRecord } from "./generate";
import { buildFeatures } from "./features";
import { GoGame, PASS } from "./go";
import { createEvaluator } from "./model";
import { MODEL_PATH } from "./protocol";
import { parseSgf } from "./sgf";

describe("parseSgf", () => {
  it("本譜・初期配置・コミ・結果を読む（分岐は最初だけ）", () => {
    const r = parseSgf(`(;FF[4]SZ[9]KM[6.5]RE[W+2.5]PB[a]PW[b\\]c]AB[aa:bb]
      ;B[cc];W[dd](;B[ee];W[])(;B[ff]))`);
    expect(r.size).toBe(9);
    expect(r.komi).toBe(6.5);
    expect(r.result).toBe("W+2.5");
    expect(r.white).toBe("b]c");
    expect(r.setup.map((m) => m.point)).toEqual([0, 1, 9, 10]);
    expect(r.moves).toEqual([
      { color: BLACK, point: 2 * 9 + 2 },
      { color: WHITE, point: 3 * 9 + 3 },
      { color: BLACK, point: 4 * 9 + 4 },
      { color: WHITE, point: PASS },
    ]);
  });

  it("壊れた SGF はエラー", () => {
    expect(() => parseSgf("(;SZ[9];B[aa]")).toThrow();
    expect(() => parseSgf("hello")).toThrow();
  });
});

describe("置き碁とパス", () => {
  // 2 子局（黒の置き石 2 個、白から打つ）。途中にパスがあり、その後も着手が続く
  const SGF = `(;FF[4]GM[1]SZ[9]HA[2]KM[0.5]RE[W+R]AB[cc][gg]
    ;W[ec];B[ce];W[];B[eg];W[ge];B[tt];W[gc])`;

  it("置き石を初期配置として読み、白から始まる手順とパスを読む", () => {
    const r = parseSgf(SGF);
    expect(r.setup).toEqual([
      { color: BLACK, point: 2 * 9 + 2 },
      { color: BLACK, point: 6 * 9 + 6 },
    ]);
    expect(r.moves.map((m) => [m.color, m.point])).toEqual([
      [WHITE, 2 * 9 + 4],
      [BLACK, 4 * 9 + 2],
      [WHITE, PASS],
      [BLACK, 6 * 9 + 4],
      [WHITE, 4 * 9 + 6],
      [BLACK, PASS],
      [WHITE, 2 * 9 + 6],
    ]);
  });

  it("置き石は KataGo の入力で着手と同じようにコミを補正する", () => {
    const g = new GoGame(9);
    g.setup(2 * 9 + 2, BLACK);
    g.setup(6 * 9 + 6, BLACK);
    g.toPlay = WHITE;
    // 白番: 白のコミ = 6.5 + 置き石 2 → 白から見て +8.5
    expect(buildFeatures(g, KOMI).global[5]).toBeCloseTo(8.5 / 20);
  });

  it("棋譜から局面を作れる（置き石・パス後の着手を含む）", async () => {
    ort.env.wasm.numThreads = 1;
    const evaluate = await createEvaluator(ort, new Uint8Array(readFileSync(`public/${MODEL_PATH}`)), KOMI);
    const game = await finishRecord(evaluate, parseSgf(SGF));
    const { board } = game.position;
    for (const p of [2 * 9 + 2, 6 * 9 + 6, 4 * 9 + 2, 6 * 9 + 4]) expect(board.cells[p]).toBe(BLACK);
    for (const p of [2 * 9 + 4, 4 * 9 + 6, 2 * 9 + 6]) expect(board.cells[p]).toBe(WHITE);
    expect(game.setup).toHaveLength(2);
    expect(game.moves).toHaveLength(7);
  }, 60_000);
});

describe("finishRecord（KataGo で死活判定）", () => {
  it("セキのサンプル: セキの眼と共有の呼吸点は地に数えない", async () => {
    ort.env.wasm.numThreads = 1;
    const evaluate = await createEvaluator(ort, new Uint8Array(readFileSync(`public/${MODEL_PATH}`)), KOMI);
    const record = parseSgf(readFileSync("public/samples/seki-9x9.sgf", "utf8"));
    const game = await finishRecord(evaluate, record);
    const { board } = game.position;
    expect(game.dameFills).toEqual([]);
    expect([...board.dead].every((d) => d === 0)).toBe(true);
    const { regions, regionOf } = analyze(board);
    expect(regions[regionOf[board.index(0, 0)]].territory).toBe(false); // 黒の眼
    expect(regions[regionOf[board.index(4, 0)]].territory).toBe(false); // 白の眼
    expect(regions[regionOf[board.index(2, 0)]].owner).toBeNull(); // 共有の呼吸点
    expect(score(game.position, WHITE)).toBe(12);
    expect(score(game.position, BLACK)).toBe(34);
  }, 60_000);
});
