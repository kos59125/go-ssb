import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { analyze } from "../core/analysis";
import { BLACK, EMPTY, WHITE } from "../core/board";
import { Session } from "../game/session";
import { buildFeatures } from "./features";
import { KOMI, generateGame } from "./generate";
import { GoGame, PASS } from "./go";
import { createEvaluator } from "./model";
import { MODEL_PATH } from "./protocol";

function play(game: GoGame, ...points: [number, number][]) {
  for (const [x, y] of points) game.play(x < 0 ? PASS : y * game.size + x);
}

describe("GoGame", () => {
  it("呼吸点のなくなった石を取る", () => {
    const g = new GoGame(5);
    // 黒 (1,0) を白が囲んで取る
    play(g, [1, 0], [0, 0], [4, 4], [2, 0], [4, 3], [1, 1]);
    expect(g.cells[1]).toBe(EMPTY);
    expect(g.captures[WHITE]).toBe(1);
  });

  it("自殺手は打てない", () => {
    const g = new GoGame(5);
    play(g, [1, 0], [4, 4], [0, 1], [4, 3]);
    expect(g.isLegal(0, WHITE)).toBe(false);
    expect(g.isLegal(0, BLACK)).toBe(true);
  });

  it("コウはすぐには取り返せない", () => {
    const g = new GoGame(5);
    // 黒: (1,0) (0,1) (2,1)... 白: (2,0) (3,1) (2,2)... の形でコウを作る
    play(g, [1, 1], [2, 1], [0, 2], [3, 2], [1, 3], [2, 3], [2, 2], [4, 4], [-1, -1], [1, 2]);
    // 白 (1,2) が黒 (2,2) を取った → 黒はすぐ (2,2) に打てない
    expect(g.cells[2 * 5 + 2]).toBe(EMPTY);
    expect(g.koPoint).toBe(2 * 5 + 2);
    expect(g.isLegal(2 * 5 + 2)).toBe(false);
  });

  it("連続 2 回のパスで終局", () => {
    const g = new GoGame(5);
    play(g, [-1, -1]);
    expect(g.isOver()).toBe(false);
    play(g, [-1, -1]);
    expect(g.isOver()).toBe(true);
  });
});

describe("buildFeatures", () => {
  it("手番側から見た石と呼吸点、直前の手、コミ", () => {
    const g = new GoGame(5);
    play(g, [0, 0], [1, 0]);
    const { spatial, global } = buildFeatures(g, KOMI);
    const at = (f: number, x: number, y: number) => spatial[f * 25 + y * 5 + x];
    // 黒番: 黒 (0,0) が自分の石で呼吸点 1、白 (1,0) が相手の石で呼吸点 2
    expect(at(1, 0, 0)).toBe(1);
    expect(at(2, 1, 0)).toBe(1);
    expect(at(3, 0, 0)).toBe(1);
    expect(at(4, 1, 0)).toBe(1);
    expect(at(9, 1, 0)).toBe(1); // 直前の相手の手
    expect(at(10, 0, 0)).toBe(1); // その前の自分の手
    expect(global[5]).toBeCloseTo(-KOMI / 20);
  });
});

describe("generateGame（KataGo）", () => {
  it("9 路の終局図を作り、棋譜とダメ埋めから同じ局面を再現できる", async () => {
    ort.env.wasm.numThreads = 1;
    const evaluate = await createEvaluator(ort, new Uint8Array(readFileSync(`public/${MODEL_PATH}`)), KOMI);
    const game = await generateGame(evaluate, { size: 9 });
    const { board, trays } = game.position;

    expect(game.result).toMatch(/^[BW]\+\d+\.5$/);

    // 黒の初手は右上
    const first = game.moves.find((m) => m.color === BLACK && m.point !== PASS)!;
    expect(first.point % 9).toBeGreaterThanOrEqual(4);
    expect(Math.floor(first.point / 9)).toBeLessThanOrEqual(4);

    // 棋譜を並べてダメを埋めると、終局図と一致する
    const replay = new GoGame(9);
    for (const m of game.moves) replay.play(m.point);
    for (const m of game.dameFills) replay.cells[m.point] = m.color;
    expect([...replay.cells]).toEqual([...board.cells]);
    expect(trays).toEqual({ [BLACK]: replay.captures[BLACK], [WHITE]: replay.captures[WHITE] });

    // 死に石取りから始められ、ダメは残っていない（中立の空点はセキだけ）
    const neutral = analyze(board)
      .regions.filter((r) => r.owner === null)
      .flatMap((r) => r.points)
      .filter((i) => board.cells[i] === EMPTY);
    expect(neutral.length).toBeLessThanOrEqual(4);
    expect(() => new Session(game.position, { undoOnPenalty: true })).not.toThrow();
  }, 60_000);
});
