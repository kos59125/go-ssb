/**
 * KataGo の Human SL ネットワーク（b18c384nbt-humanv0）に渡す、対局のメタデータ。
 * 打ち手の段級位などを与えると、その棋力の人が打ちそうな手を方策として返す。
 *
 * cpp/neuralnet/sgfmetadata.cpp の fillMetadataRow（"version 1" のエンコード）と、
 * humanSLProfile の "rank_XX"（makeBasicRankProfile）に従う。
 */

export const NUM_META = 192;

/** Human SL で打たせる棋力。 */
export interface HumanRank {
  /** 表示用（例: "10 級"）。 */
  label: string;
  /**
   * KataGo の inverse rank。9 段 = 1、1 段 = 9、1 級 = 10、10 級 = 19、20 級 = 29。
   * 小さいほど強い。
   */
  inverse: number;
}

/** 段級位（例: "10k"、"1d"）から inverse rank を求める。KataGo の rank_XX と同じ範囲（20 級〜9 段）。 */
export function inverseRank(rank: string): number {
  const m = /^(\d+)([kd])$/.exec(rank);
  if (!m) throw new Error(`段級位の形式が違います: ${rank}`);
  const n = Number(m[1]);
  if (m[2] === "d" && n >= 1 && n <= 9) return 10 - n;
  if (m[2] === "k" && n >= 1 && n <= 20) return 9 + n;
  throw new Error(`段級位の範囲外です: ${rank}`);
}

/** 1970-01-01 からの日数。 */
function daysSinceEpoch(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * 両者が同じ棋力の人間どうしの対局（KGS、持ち時間 20 分 + 30 秒 5 回の秒読み、2020 年 3 月、
 * レーティング対局かは不明）としてのメタデータの入力 [192]。
 * 両者が同じ棋力なので、手番には依らない。
 */
export function humanMetaRow(inverse: number, boardArea: number): Float32Array {
  const row = new Float32Array(NUM_META);
  // 0, 1: 手番側・相手が人間
  row[0] = 1;
  row[1] = 1;
  // 2〜5: 段級位なし・不明（どちらも false）
  // 6〜39: 手番側の段級位、40〜73: 相手の段級位（inverse rank の数だけ 1 を立てる）
  const RANK_LEN = 34;
  for (let i = 0; i < Math.min(inverse, RANK_LEN); i++) {
    row[6 + i] = 1;
    row[6 + RANK_LEN + i] = 1;
  }
  // 74: レーティング対局か（不明 = 0.5）
  row[74] = 0.5;
  // 75〜81: 持ち時間の種類（79 = 秒読み）
  row[79] = 1;
  const mainTime = 1200;
  const periodTime = 30;
  const periods = 5;
  const canadianMoves = 0;
  row[82] = 0.4 * (Math.log(mainTime + 60) - 6.5);
  row[83] = 0.3 * (Math.log(periodTime + 1) - 3);
  row[84] = 0.5 * (Math.log(periods + 2) - 1.5);
  row[85] = 0.25 * (Math.log(canadianMoves + 2) - 1.5);
  // 86: 盤の広さ
  row[86] = 0.5 * Math.log(boardArea / 361);
  // 87〜150: 対局日（周期の異なる 32 組の cos / sin）
  const days = daysSinceEpoch(2020, 3, 1);
  const DATE_LEN = 32;
  const factor = Math.pow(80000, 1 / (DATE_LEN - 1));
  let period = 7;
  for (let i = 0; i < DATE_LEN; i++) {
    const revolutions = days / period;
    row[87 + 2 * i] = Math.cos(revolutions * 2 * Math.PI);
    row[87 + 2 * i + 1] = Math.sin(revolutions * 2 * Math.PI);
    period *= factor;
  }
  // 151〜166: 棋譜の出典（2 = KGS）
  row[151 + 2] = 1;
  return row;
}
