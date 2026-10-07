import { Position, analyze, score } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { checkTerritory, isRemovalDone } from "../core/judge";
import { HeldStone, placeStones } from "../core/placement";

export const PENALTY_MS = 5000;

export type Phase = "removal" | "arrange" | "finished";

export type Origin = { kind: "board"; points: number[] } | { kind: "tray"; owner: Color };

export interface Hand {
  stones: HeldStone[];
  origin: Origin;
  /** この手で石を置いた点。 */
  placed: number[];
  /** 印の付いた石を持ったか。 */
  carriedMark: boolean;
  /** 石を持つ前の状態。ペナルティで元に戻すときに使う。 */
  before: Snapshot;
}

interface Snapshot {
  cells: Uint8Array;
  dead: Uint8Array;
  trays: Record<Color, number>;
  scores: Record<Color, number>;
}

export interface SessionOptions {
  /** ペナルティの原因になった移動を自動で元に戻すか。 */
  undoOnPenalty: boolean;
  now?: () => number;
}

export type CompleteResult = { ok: true } | { ok: false; problems: string[] };

/**
 * ひとりでモードの 1 ゲーム（仕様書 §2, §3.2）。
 *
 * 黒白どちらの石も操作でき、黒地・白地の両方を整地する。
 */
export class Session {
  readonly position: Position;
  readonly initialScores: Record<Color, number>;
  readonly options: SessionOptions;
  hand: Hand | null = null;
  /** 間違えた箇所の印（点インデックス）。 */
  readonly marks = new Set<number>();
  phase: Phase = "removal";
  penalties = 0;
  readonly startedAt: number;
  finishedAt: number | null = null;

  constructor(position: Position, options: SessionOptions) {
    this.position = { board: position.board.clone(), trays: { ...position.trays } };
    this.options = options;
    this.initialScores = this.scores();
    this.startedAt = this.now();
    this.updatePhase();
  }

  get board(): Board {
    return this.position.board;
  }

  scores(): Record<Color, number> {
    const analysis = analyze(this.board);
    return {
      [BLACK]: score(this.position, BLACK, analysis),
      [WHITE]: score(this.position, WHITE, analysis),
    };
  }

  /** ペナルティ込みの経過時間（ミリ秒）。 */
  elapsed(): number {
    return (this.finishedAt ?? this.now()) - this.startedAt + this.penalties * PENALTY_MS;
  }

  /** 盤上の石を持つ。points は持つ順番に並べる。 */
  pickUp(points: number[]): boolean {
    if (this.hand || this.phase === "finished") return false;
    const stones = points.filter((i) => this.board.cells[i] !== EMPTY);
    if (stones.length === 0) return false;
    const before = this.snapshot();
    const carriedMark = stones.some((i) => this.marks.has(i));
    const held = stones.map((i) => {
      const stone: HeldStone = { color: this.board.cells[i] as Color, dead: this.board.dead[i] === 1 };
      const { x, y } = this.board.point(i);
      this.board.set(x, y, EMPTY);
      this.marks.delete(i);
      return stone;
    });
    this.hand = { stones: held, origin: { kind: "board", points: stones }, placed: [], carriedMark, before };
    return true;
  }

  /** アゲハマトレイから石を 1 つ持つ。同じトレイから持っている最中なら 1 つ追加する。 */
  pickFromTray(owner: Color): boolean {
    if (this.phase !== "arrange" || this.position.trays[owner] === 0) return false;
    if (this.hand) {
      const { origin } = this.hand;
      if (origin.kind !== "tray" || origin.owner !== owner || this.hand.placed.length > 0) return false;
    } else {
      this.hand = { stones: [], origin: { kind: "tray", owner }, placed: [], carriedMark: false, before: this.snapshot() };
    }
    this.position.trays[owner]--;
    this.hand.stones.push({ color: opponent(owner), dead: false });
    return true;
  }

  /** 持っている石を元の場所に戻す。 */
  cancel(): void {
    const hand = this.hand;
    if (!hand) return;
    if (hand.origin.kind === "tray") {
      this.position.trays[hand.origin.owner] += hand.stones.length;
    } else {
      const free = hand.origin.points.filter((i) => this.board.cells[i] === EMPTY);
      hand.stones.forEach((stone, k) => {
        const i = free[k];
        if (i === undefined) return;
        const { x, y } = this.board.point(i);
        this.board.set(x, y, stone.color, stone.dead);
      });
    }
    this.hand = null;
    if (hand.placed.length > 0) this.settle(hand);
  }

  /** 元の位置の再クリックか（持つのをやめる操作）。 */
  isOrigin(i: number): boolean {
    const origin = this.hand?.origin;
    return origin?.kind === "board" && origin.points.includes(i) && this.board.cells[i] === EMPTY;
  }

  /** 持っている石を、クリックした空点の周囲に置く。 */
  placeAt(i: number): boolean {
    const hand = this.hand;
    if (!hand || this.phase !== "arrange" || this.board.cells[i] !== EMPTY) return false;
    const { placed, remaining } = placeStones(this.board, i, hand.stones);
    if (placed.length === 0) return false;
    hand.placed.push(...placed);
    hand.stones = remaining;
    if (remaining.length === 0) {
      this.hand = null;
      this.settle(hand);
    }
    return true;
  }

  /**
   * 持っている石をアゲハマトレイに移す。トレイ owner には相手の色の石だけが入る。
   * 入らない色の石は持ったままにする。
   */
  dropToTray(owner: Color): boolean {
    const hand = this.hand;
    if (!hand) return false;
    const color = opponent(owner);
    const fits = hand.stones.filter((s) => s.color === color);
    if (fits.length === 0) return false;
    this.position.trays[owner] += fits.length;
    hand.stones = hand.stones.filter((s) => s.color !== color);
    if (hand.stones.length === 0) {
      this.hand = null;
      this.settle(hand);
    }
    return true;
  }

  /**
   * 完了を宣言する（仕様書 §2.6）。answer は黒地・白地の目数。
   * 誤りならペナルティを科し、そのまま続ける。
   */
  complete(answer: Record<Color, number>): CompleteResult {
    if (this.phase === "finished") return { ok: true };
    const problems: string[] = [];
    if (this.hand) problems.push("石を持っている");
    if (this.phase === "removal") problems.push("死に石が残っている");
    const scores = this.scores();
    if (!sameScores(scores, this.initialScores)) problems.push("間違えて置いた石がある");
    const analysis = analyze(this.board);
    for (const color of [BLACK, WHITE] as const) {
      const name = color === BLACK ? "黒地" : "白地";
      const check = checkTerritory(this.position, color, analysis);
      problems.push(...check.problems.map((p) => `${name}: ${p}`));
      if (answer[color] !== this.initialScores[color]) problems.push(`${name}の目数が違う`);
    }
    if (problems.length > 0) {
      this.penalties++;
      return { ok: false, problems };
    }
    this.phase = "finished";
    this.finishedAt = this.now();
    return { ok: true };
  }

  /** 手が空になった時点でペナルティを判定する（仕様書 §2.5）。 */
  private settle(hand: Hand): void {
    const scores = this.scores();
    const correct = sameScores(scores, this.initialScores);
    if (!correct && sameScores(scores, hand.before.scores)) {
      // 間違えた石を別の場所に動かしただけなら、印も一緒に動かす
      if (hand.carriedMark) for (const i of hand.placed) this.marks.add(i);
    } else if (!correct) {
      this.penalties++;
      // 死に石取りのフェーズでは、間違えて取った石は設定によらず元に戻す
      if (this.options.undoOnPenalty || this.phase === "removal") {
        this.restore(hand.before);
      } else {
        for (const i of hand.placed) this.marks.add(i);
        if (hand.origin.kind === "board") {
          for (const i of hand.origin.points) this.marks.add(i);
        }
      }
    }
    if (sameScores(this.scores(), this.initialScores)) this.marks.clear();
    this.updatePhase();
  }

  private updatePhase(): void {
    if (this.phase === "removal" && isRemovalDone(this.board)) this.phase = "arrange";
  }

  private snapshot(): Snapshot {
    return {
      cells: this.board.cells.slice(),
      dead: this.board.dead.slice(),
      trays: { ...this.position.trays },
      scores: this.scores(),
    };
  }

  private restore(s: Snapshot): void {
    this.board.cells.set(s.cells);
    this.board.dead.set(s.dead);
    this.position.trays[BLACK] = s.trays[BLACK];
    this.position.trays[WHITE] = s.trays[WHITE];
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function sameScores(a: Record<Color, number>, b: Record<Color, number>): boolean {
  return a[BLACK] === b[BLACK] && a[WHITE] === b[WHITE];
}
