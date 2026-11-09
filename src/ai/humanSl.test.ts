import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { KOMI } from "./generate";
import { GoGame } from "./go";
import { NUM_META, humanMetaRow, inverseRank } from "./humanSl";
import { createEvaluator } from "./model";
import { HUMAN_MODEL_PATH } from "./protocol";

describe("inverseRank", () => {
  it("KataGo の rank_XX と同じ（9 段 = 1、1 段 = 9、1 級 = 10、20 級 = 29）", () => {
    expect(inverseRank("9d")).toBe(1);
    expect(inverseRank("6d")).toBe(4);
    expect(inverseRank("1d")).toBe(9);
    expect(inverseRank("1k")).toBe(10);
    expect(inverseRank("10k")).toBe(19);
    expect(inverseRank("20k")).toBe(29);
    expect(() => inverseRank("21k")).toThrow();
    expect(() => inverseRank("10d")).toThrow();
  });
});

describe("humanMetaRow", () => {
  it("KataGo（python/katago/game/sgfmetadata.py）と同じ値になる（10 級、9 路）", () => {
    const row = humanMetaRow(19, 81);
    expect(row.length).toBe(NUM_META);
    // KataGo の get_metadata_row で求めた値
    const expected: Record<number, number> = {
      0: 1, 1: 1, 5: 0, 6: 1, 24: 1, 25: 0, 40: 1, 58: 1, 59: 0, 74: 0.5, 79: 1,
      82: 0.255547, 83: 0.130196, 84: 0.222955, 85: -0.201713, 86: -0.747214,
      87: -0.900969, 88: 0.433884, 149: 0.978944, 150: 0.204128, 153: 1,
    };
    for (const [i, v] of Object.entries(expected)) expect(row[Number(i)]).toBeCloseTo(v, 5);
    // 段級位の 1 は手番側・相手とも inverse rank の数だけ
    expect(row.slice(6, 40).reduce((s, x) => s + x, 0)).toBe(19);
    expect(row.slice(40, 74).reduce((s, x) => s + x, 0)).toBe(19);
  });
});

describe("Human SL ネットワーク", () => {
  it("棋力によって方策が変わる", async () => {
    ort.env.wasm.numThreads = 1;
    let inverse = inverseRank("10k");
    const evaluate = await createEvaluator(ort, new Uint8Array(readFileSync(`public/${HUMAN_MODEL_PATH}`)), KOMI, (g) =>
      humanMetaRow(inverse, g.size * g.size),
    );
    const game = new GoGame(9);
    for (const [x, y] of [[6, 2], [2, 6], [2, 2], [6, 6]]) game.play(y * 9 + x);
    const weak = await evaluate(game);
    inverse = inverseRank("6d");
    const strong = await evaluate(game);
    expect(weak.policy.length).toBe(82);
    expect(weak.policy.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 4);
    const diff = weak.policy.reduce((s, p, i) => s + Math.abs(p - strong.policy[i]), 0);
    expect(diff).toBeGreaterThan(0.05);
  }, 60_000);
});
