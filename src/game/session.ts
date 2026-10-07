import { Position, analyze, score } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { checkTerritory, isRemovalDone } from "../core/judge";

export const PENALTY_MS = 5000;

export type Phase = "removal" | "arrange" | "finished";

/** プレイヤーが持っている石。 */
export interface HeldStone {
  color: Color;
  dead: boolean;
}

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
  /** 開始時の中立の空点（セキ）の数。これより多ければ境界が開いている。 */
  private readonly baseOpen: number;
  /** 最後に境界が閉じていた時点の状態。境界を開いたまま誤った場合はここまで戻す。 */
  private settled!: Snapshot;
  /** settled の時点で各点がどちらの地だったか（地でなければ EMPTY）。 */
  private settledOwner!: Uint8Array;
  /** 境界が開いてから置いた石と、持ち上げた元の点。 */
  private pending = { placed: [] as number[], origins: [] as number[], carriedMark: false };
  readonly startedAt: number;
  finishedAt: number | null = null;

  constructor(position: Position, options: SessionOptions) {
    this.position = { board: position.board.clone(), trays: { ...position.trays } };
    this.options = options;
    this.initialScores = this.scores();
    this.baseOpen = openPoints(this.board);
    this.markSettled();
    this.startedAt = this.now();
    this.updatePhase();
  }

  /** 境界が開いているか（どちらの地でもない空点が開始時より多い）。 */
  get boundaryOpen(): boolean {
    return openPoints(this.board) > this.baseOpen;
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

  /**
   * 盤上の石を持つ。points は持つ順番に並べる。
   * 盤上から持っている最中なら、持っている石に追加する（持った順番の最後に並ぶ）。
   */
  pickUp(points: number[]): boolean {
    if (this.phase === "finished") return false;
    const hand = this.hand;
    if (hand && hand.origin.kind !== "board") return false;
    const stones = points.filter((i) => this.board.cells[i] !== EMPTY);
    if (stones.length === 0) return false;
    const before = hand?.before ?? this.snapshot();
    const carriedMark = stones.some((i) => this.marks.has(i));
    const held = stones.map((i) => {
      const stone: HeldStone = { color: this.board.cells[i] as Color, dead: this.board.dead[i] === 1 };
      const { x, y } = this.board.point(i);
      this.board.set(x, y, EMPTY);
      this.marks.delete(i);
      return stone;
    });
    if (hand && hand.origin.kind === "board") {
      hand.stones.push(...held);
      hand.origin.points.push(...stones);
      hand.carriedMark ||= carriedMark;
    } else {
      this.hand = { stones: held, origin: { kind: "board", points: stones }, placed: [], carriedMark, before };
    }
    return true;
  }

  /** アゲハマトレイから石を 1 つ持つ。同じトレイから持っている最中なら 1 つ追加する。 */
  pickFromTray(owner: Color): boolean {
    if (this.phase !== "arrange" || this.position.trays[owner] === 0) return false;
    if (this.hand) {
      const { origin } = this.hand;
      if (origin.kind !== "tray" || origin.owner !== owner) return false;
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

  /** 持っている石のうち、最初に持った 1 個をクリックした空点に置く。残りは持ったまま。 */
  placeAt(i: number): boolean {
    const hand = this.hand;
    if (!hand || this.phase !== "arrange" || this.board.cells[i] !== EMPTY) return false;
    // 石は 1 個ずつ、持った順に置く
    const [stone, ...remaining] = hand.stones;
    const { x, y } = this.board.point(i);
    this.board.set(x, y, stone.color, stone.dead);
    hand.placed.push(i);
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
    if (this.boundaryOpen) problems.push("境界が開いている");
    else if (!sameScores(scores, this.initialScores)) problems.push("間違えて置いた石がある");
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

  /**
   * 手が空になった時点でペナルティを判定する（仕様書 §2.5）。
   *
   * - 相手の地に石を置いたなど明らかな誤りは、その場でペナルティ。
   * - 境界が開いている間は判定を保留し、閉じた時点で目数を比べる。
   *   境界の石を動かしても、目数が変わらなければペナルティにしない。
   */
  private settle(hand: Hand): void {
    const origins = hand.origin.kind === "board" ? hand.origin.points : [];
    if (this.phase === "removal") {
      this.settleRemoval(hand);
      return;
    }

    if (this.placedInEnemyTerritory(hand.placed)) {
      if (hand.carriedMark) {
        // 間違えた石を別の誤った場所に動かしただけなら、印も一緒に動かす
        for (const i of hand.placed) this.marks.add(i);
      } else {
        this.penalize(hand.before, hand.placed, origins);
      }
      return;
    }

    const pending = this.pending;
    pending.placed.push(...hand.placed);
    pending.origins.push(...origins);
    pending.carriedMark ||= hand.carriedMark;
    if (this.boundaryOpen) return;

    this.pending = { placed: [], origins: [], carriedMark: false };
    const scores = this.scores();
    if (sameScores(scores, this.initialScores)) {
      this.marks.clear();
    } else if (sameScores(scores, this.settled.scores)) {
      if (pending.carriedMark) for (const i of pending.placed) this.marks.add(i);
    } else {
      this.penalize(this.settled, pending.placed, pending.origins);
      return;
    }
    this.markSettled();
  }

  /** 死に石取りのフェーズ: 生きた石を取ったら、設定によらず元に戻す。 */
  private settleRemoval(hand: Hand): void {
    if (!sameScores(this.scores(), this.initialScores)) {
      this.penalties++;
      this.restore(hand.before);
    }
    this.updatePhase();
    this.markSettled();
  }

  /** ペナルティを科し、設定に応じて restoreTo まで戻すか、印を付ける。 */
  private penalize(restoreTo: Snapshot, placed: number[], origins: number[]): void {
    this.penalties++;
    this.pending = { placed: [], origins: [], carriedMark: false };
    if (this.options.undoOnPenalty) {
      this.restore(restoreTo);
    } else {
      for (const i of [...placed, ...origins]) this.marks.add(i);
    }
    if (sameScores(this.scores(), this.initialScores)) this.marks.clear();
    if (!this.boundaryOpen) this.markSettled();
  }

  private markSettled(): void {
    this.settled = this.snapshot();
    this.settledOwner = new Uint8Array(this.board.cells.length);
    for (const region of analyze(this.board).regions) {
      if (!region.territory || region.owner === null) continue;
      for (const i of region.points) this.settledOwner[i] = region.owner;
    }
  }

  /**
   * 置いた石のどれかが相手の地の中にあるか。境界が開いている間も判定できるよう、
   * 最後に境界が閉じていた時点の地で判定する。
   */
  private placedInEnemyTerritory(placed: number[]): boolean {
    return placed.some((i) => this.settledOwner[i] === opponent(this.board.cells[i] as Color));
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

/** どちらの地でもない空点の数。 */
function openPoints(board: Board): number {
  let n = 0;
  for (const region of analyze(board).regions) {
    if (region.owner !== null) continue;
    for (const i of region.points) if (board.cells[i] === EMPTY) n++;
  }
  return n;
}

function sameScores(a: Record<Color, number>, b: Record<Color, number>): boolean {
  return a[BLACK] === b[BLACK] && a[WHITE] === b[WHITE];
}
