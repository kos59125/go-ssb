import { describe, expect, it } from "vitest";
import { BLACK, WHITE, parseBoard } from "../core/board";
import { complexityOf, complexityScore, difficultyMiss } from "./complexity";

describe("局面の複雑さ", () => {
  it("地が細かく分かれているほど点数が高い", () => {
    const simple = parseBoard(`
      ....xo...
      ....xo...
      ....xo...
      ....xo...
      ....xo...
      ....xo...
      ....xo...
      ....xo...
      ....xo...
    `);
    const busy = parseBoard(`
      .x.xo.o.o
      xx.xooo.o
      ..xxo..oo
      xxx.xo...
      ..x.xooo.
      x.xxxo..o
      .x.x.oo.o
      x..x.o.o.
      .x.xo.o..
    `);
    const trays = { [BLACK]: 0, [WHITE]: 0 };
    expect(complexityOf({ board: busy, trays }).regions).toBeGreaterThan(complexityOf({ board: simple, trays }).regions);
    expect(complexityScore({ board: busy, trays })).toBeGreaterThan(complexityScore({ board: simple, trays }));
  });

  it("難しさの範囲（重なりあり）", () => {
    expect(difficultyMiss(-2, "easy")).toBe(0);
    expect(difficultyMiss(0, "easy")).toBeCloseTo(0.5);
    expect(difficultyMiss(0, "normal")).toBe(0);
    expect(difficultyMiss(2, "normal")).toBeCloseTo(0.5);
    expect(difficultyMiss(1, "hard")).toBe(0);
    expect(difficultyMiss(-1, "hard")).toBeCloseTo(1.5);
  });
});
