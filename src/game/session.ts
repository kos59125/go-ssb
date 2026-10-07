import { Position, analyze, score } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { checkTerritory, isRemovalDone } from "../core/judge";

export const PENALTY_MS = 5000;

export type Phase = "removal" | "arrange" | "finished";

/** 持っている石の出どころ。持つのをやめたときはここへ戻す。 */
export type Source = { kind: "board"; point: number } | { kind: "tray"; owner: Color };

/** プレイヤーが持っている石。 */
export interface HeldStone {
  color: Color;
  dead: boolean;
  source: Source;
}

export interface Hand {
  /** 持った順。 */
  stones: HeldStone[];
  /** 盤上で石を持ち上げた点（印と「元の位置」の判定に使う）。 */
  origins: number[];
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
   * 石を持っている最中なら、持っている石に追加する（持った順番の最後に並ぶ）。
   */
  pickUp(points: number[]): boolean {
    if (this.phase === "finished") return false;
    const stones = points.filter((i) => this.board.cells[i] !== EMPTY);
    if (stones.length === 0) return false;
    const hand = this.ensureHand();
    for (const i of stones) {
      hand.stones.push({
        color: this.board.cells[i] as Color,
        dead: this.board.dead[i] === 1,
        source: { kind: "board", point: i },
      });
      hand.origins.push(i);
      if (this.marks.delete(i)) hand.carriedMark = true;
      const { x, y } = this.board.point(i);
      this.board.set(x, y, EMPTY);
    }
    return true;
  }

  /**
   * 死に石取り: 盤上の石を取り上げて、取った側のアゲハマトレイに入れる
   * （黒石は白のトレイ、白石は黒のトレイ）。持っている石があれば、それも一緒に入れる。
   * 死に石でなければ、手が空になった時点の判定でペナルティになり元に戻る。
   */
  capture(i: number): boolean {
    if (this.phase !== "removal" || !this.pickUp([i])) return false;
    this.dropToTray(BLACK);
    this.dropToTray(WHITE);
    return true;
  }

  /** アゲハマトレイから石を count 個持つ。石を持っている最中なら追加する。 */
  pickFromTray(owner: Color, count = 1): boolean {
    const n = Math.min(count, this.position.trays[owner]);
    if (this.phase !== "arrange" || n <= 0) return false;
    const hand = this.ensureHand();
    this.position.trays[owner] -= n;
    for (let k = 0; k < n; k++) {
      hand.stones.push({ color: opponent(owner), dead: false, source: { kind: "tray", owner } });
    }
    return true;
  }

  /** 持っている石を、それぞれ持ち出した場所に戻す。 */
  cancel(): void {
    const hand = this.hand;
    if (!hand) return;
    const left: HeldStone[] = [];
    for (const stone of hand.stones) {
      const { source } = stone;
      if (source.kind === "tray") {
        this.position.trays[source.owner]++;
        continue;
      }
      // 元の点が埋まっていたら、空いている別の元の点に戻す
      const point = this.board.cells[source.point] === EMPTY
        ? source.point
        : hand.origins.find((i) => this.board.cells[i] === EMPTY);
      if (point === undefined) {
        left.push(stone);
        continue;
      }
      const { x, y } = this.board.point(point);
      this.board.set(x, y, stone.color, stone.dead);
    }
    hand.stones = left;
    if (left.length > 0) return;
    this.hand = null;
    if (hand.placed.length > 0) this.settle(hand);
  }

  /** 持っている石の色。 */
  heldColors(): Set<Color> {
    return new Set(this.hand?.stones.map((s) => s.color) ?? []);
  }

  /**
   * 持っている石を 1 個、クリックした空点に置く。残りは持ったまま。置く石は次の順で選ぶ。
   * 1. その点から持ち上げた石（color を指定したときはその色の場合だけ）。元の位置に戻すのと同じ
   * 2. color の石のうち最初に持った石
   * 3. 最初に持った石
   */
  placeAt(i: number, color?: Color): boolean {
    const hand = this.hand;
    if (!hand || this.phase !== "arrange" || this.board.cells[i] !== EMPTY) return false;
    const own = hand.stones.findIndex(
      (s) => s.source.kind === "board" && s.source.point === i && (color === undefined || s.color === color),
    );
    const k = own >= 0 ? own : Math.max(0, hand.stones.findIndex((s) => s.color === color));
    const [stone] = hand.stones.splice(k, 1);
    const { x, y } = this.board.point(i);
    this.board.set(x, y, stone.color, stone.dead);
    hand.placed.push(i);
    if (hand.stones.length === 0) {
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
    const origins = hand.origins;
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

  private ensureHand(): Hand {
    this.hand ??= { stones: [], origins: [], placed: [], carriedMark: false, before: this.snapshot() };
    return this.hand;
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
