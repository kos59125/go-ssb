import { Position } from "../core/analysis";
import { BLACK, WHITE } from "../core/board";
import { Match, MatchOptions, Player } from "./match";

export { PENALTY_MS } from "./match";
export type { CompleteResult, Hand, HeldStone, Phase, Source } from "./match";

export interface SessionOptions extends MatchOptions {
  /** 一度に持てる石の数の上限。 */
  handLimit?: number;
}

/**
 * ひとりでモードの 1 ゲーム（仕様書 §2, §3.2）。
 *
 * 黒白どちらの石も操作でき、黒地・白地の両方を整地する。
 */
export class Session extends Player {
  constructor(position: Position, options: SessionOptions) {
    super(new Match(position, options), { color: null, handLimit: options.handLimit });
  }

  /**
   * 終局図からやり直す。盤・アゲハマ・フェーズ・印を最初の状態に戻す。
   * タイマーとペナルティはそのまま続ける。
   */
  reset(): void {
    if (this.phase === "finished") return;
    const { initial } = this.match;
    this.board.cells.set(initial.board.cells);
    this.board.dead.set(initial.board.dead);
    this.position.trays[BLACK] = initial.trays[BLACK];
    this.position.trays[WHITE] = initial.trays[WHITE];
    this.marks.clear();
    this.match.markSettled();
    this.restartPhase();
  }
}
