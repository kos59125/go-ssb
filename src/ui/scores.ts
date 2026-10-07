/**
 * スコアボードの記録（仕様書 §2.9）。ブラウザーごとに localStorage に保存する。
 *
 * - ひとりで: 盤のサイズごとのベストタイム（ペナルティ込み）上位 10 件。
 * - vs CPU: 直近 10 戦の戦績。
 *
 * どの記録にも、そのゲームの設定（シード・整地ルール・棋譜など）を残し、「再プレイ」で同じゲームを始められる。
 */

const SCORES_KEY = "go-ssb:scores";
export const SOLO_LIMIT = 10;
export const CPU_LIMIT = 10;

export interface SoloRecord<S> {
  /** ペナルティ込みのタイム（ミリ秒）。 */
  time: number;
  penalties: number;
  /** 記録した日時（Date.now()）。 */
  date: number;
  size: number;
  settings: S;
}

export type CpuResult = "win" | "lose" | "giveup";

export interface CpuRecord<S> {
  date: number;
  result: CpuResult;
  size: number;
  /** 完了したときのタイム（ペナルティ込み）。未完了なら null。 */
  myTime: number | null;
  cpuTime: number | null;
  penalties: number;
  settings: S;
}

export interface Scores<S> {
  solo: SoloRecord<S>[];
  cpu: CpuRecord<S>[];
}

export function loadScores<S>(): Scores<S> {
  try {
    const raw = JSON.parse(localStorage.getItem(SCORES_KEY) ?? "{}");
    return {
      solo: Array.isArray(raw.solo) ? raw.solo : [],
      cpu: Array.isArray(raw.cpu) ? raw.cpu : [],
    };
  } catch {
    return { solo: [], cpu: [] };
  }
}

function saveScores<S>(scores: Scores<S>): void {
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
  } catch {
    // 保存できなくてもゲームは続けられる
  }
}

/** 盤のサイズごとのベストタイム（速い順、上位 10 件）。 */
export function soloRanking<S>(scores: Scores<S>, size: number): SoloRecord<S>[] {
  return scores.solo
    .filter((r) => r.size === size)
    .sort((a, b) => a.time - b.time || a.date - b.date)
    .slice(0, SOLO_LIMIT);
}

/**
 * ひとりでモードの記録を追加する。その盤のサイズで 10 位以内に入れば順位（1 始まり）、入らなければ null。
 * 10 位より下の記録は残さない。
 */
export function addSoloRecord<S>(record: SoloRecord<S>): number | null {
  const scores = loadScores<S>();
  scores.solo.push(record);
  const sizes = [...new Set(scores.solo.map((r) => r.size))];
  scores.solo = sizes.flatMap((size) => soloRanking(scores, size));
  saveScores(scores);
  const rank = soloRanking(scores, record.size).indexOf(record);
  return rank >= 0 ? rank + 1 : null;
}

/** vs CPU の戦績を追加する（新しい順に 10 件まで）。 */
export function addCpuRecord<S>(record: CpuRecord<S>): void {
  const scores = loadScores<S>();
  scores.cpu = [record, ...scores.cpu].slice(0, CPU_LIMIT);
  saveScores(scores);
}
