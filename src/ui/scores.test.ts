import { beforeEach, describe, expect, it } from "vitest";
import { addCpuRecord, addSoloRecord, loadScores, soloRanking } from "./scores";

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

const solo = (time: number, size = 9) => ({ time, penalties: 0, date: time, size, settings: { seed: String(time) } });

describe("スコアボード", () => {
  it("ひとりで: 盤のサイズごとに速い順で 10 位まで残し、順位を返す", () => {
    for (let k = 1; k <= 12; k++) addSoloRecord(solo(k * 1000));
    addSoloRecord(solo(500, 13));
    expect(addSoloRecord(solo(2500))).toBe(3);
    expect(addSoloRecord(solo(99_000))).toBeNull();
    const ranking = soloRanking(loadScores(), 9);
    expect(ranking.map((r) => r.time)).toEqual([1000, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
    expect(soloRanking(loadScores(), 13).map((r) => r.settings)).toEqual([{ seed: "500" }]);
  });

  it("vs CPU: 新しい順に 10 戦まで", () => {
    for (let k = 1; k <= 12; k++) {
      addCpuRecord({ date: k, result: k % 2 ? "win" : "lose", size: 9, myTime: k, cpuTime: null, penalties: 0, settings: {} });
    }
    expect(loadScores().cpu.map((r) => r.date)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });
});
