import { afterEach, describe, expect, it, vi } from "vitest";
import { BLACK, WHITE } from "../core/board";
import { GameRecorder, fitsVideo } from "./recorder";

afterEach(() => vi.restoreAllMocks());

const state = (cells: number[], extra: Partial<Parameters<GameRecorder["capture"]>[0]> = {}) => ({
  started: true,
  cells: Uint8Array.from(cells),
  trays: { [BLACK]: 0, [WHITE]: 0 },
  marks: [],
  cursors: [],
  clocks: [{ label: "タイム", ms: 0, running: true }],
  ...extra,
});

describe("対局の記録（動画用）", () => {
  it("変わったときだけ記録し、時刻で引ける", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const r = new GameRecorder(2);
    r.capture(state([0, 0, 0, 0]));
    now = 1500;
    r.capture(state([0, 0, 0, 0])); // 同じ → 記録しない
    now = 2000;
    r.capture(state([1, 0, 0, 0]));
    expect(r.length).toBe(2);
    expect(r.duration).toBe(1000);
    expect([...r.at(500)!.cells]).toEqual([0, 0, 0, 0]);
    expect([...r.at(1200)!.cells]).toEqual([1, 0, 0, 0]);
  });

  it("5 分を超える対局は動画にできない", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const short = new GameRecorder(2);
    short.capture(state([0, 0, 0, 0]));
    now = 4 * 60_000;
    short.capture(state([1, 0, 0, 0]));
    expect(fitsVideo(short)).toBe(true);
    now = 0;
    const long = new GameRecorder(2);
    long.capture(state([0, 0, 0, 0]));
    now = 5 * 60_000;
    long.capture(state([1, 0, 0, 0]));
    expect(fitsVideo(long)).toBe(false);
  });

  it("盤を回して見せていたときは、黒番から見た向きに直して記録する", () => {
    vi.spyOn(performance, "now").mockImplementation(() => 0);
    const r = new GameRecorder(2, true);
    r.capture(state([1, 0, 0, 2], { marks: [0], cursors: [{ label: "CPU", color: "#000", point: 1 }] }));
    const snap = r.at(0)!;
    expect([...snap.cells]).toEqual([2, 0, 0, 1]);
    expect(snap.marks).toEqual([3]);
    expect(snap.cursors[0].point).toBe(2);
  });
});
