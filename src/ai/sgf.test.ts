import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { analyze, score } from "../core/analysis";
import { BLACK, WHITE } from "../core/board";
import { KOMI, finishRecord } from "./generate";
import { PASS } from "./go";
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
