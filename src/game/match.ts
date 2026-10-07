import { Position, analyze, countDead, score } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { checkTerritory, isRemovalDone } from "../core/judge";
import { DEFAULT_SHAPE_RULES, ShapeRules } from "../core/shapes";

export const PENALTY_MS = 5000;

export type Phase = "removal" | "arrange" | "finished";

/** 石の置き場所（持ち出した場所・置いた場所）。 */
export type Source = { kind: "board"; point: number } | { kind: "tray"; owner: Color };

/** プレイヤーが持っている石。 */
export interface HeldStone {
  color: Color;
  dead: boolean;
  source: Source;
  /** 間違いの印が付いていた石か。 */
  marked?: boolean;
}

/** 石を 1 個動かした記録。ペナルティで元に戻すときは逆順にたどる。 */
interface Move {
  color: Color;
  dead: boolean;
  from: Source;
  to: Source;
}

export interface Hand {
  /** 持った順。 */
  stones: HeldStone[];
  /** 盤上で石を持ち上げた点（印と「元の位置」の判定に使う）。 */
  origins: number[];
  /** この手で石を置いた点。 */
  placed: number[];
  /** そのうちアゲハマ（トレイから持った石）と、印の付いていた石を置いた点。 */
  placedPrisoners: number[];
  /** 印の付いた石を持ったか。 */
  carriedMark: boolean;
  /** この手で動かした石。 */
  moves: Move[];
}

export interface MatchOptions {
  /** ペナルティの原因になった移動を自動で元に戻すか。 */
  undoOnPenalty: boolean;
  /** 区間の形の追加ルール（1 列の区間の制限）。 */
  shapeRules?: ShapeRules;
  now?: () => number;
}

export interface PlayerOptions {
  /**
   * 自分の石の色。対戦では相手の地を整地する（仕様書 §3.1）。
   * null はひとりでモード（黒地・白地の両方を整地し、両方のトレイを使う）。
   */
  color: Color | null;
  /** 対戦で、担当外の石を操作できないようにするか（仕様書 §3.1）。 */
  restricted?: boolean;
  /** 一度に持てる石の数の上限（仕様書 §2.3）。省略すると上限なし。 */
  handLimit?: number;
}

/** 一度に持てる石の数の上限の初期値。 */
export const DEFAULT_HAND_LIMIT = 10;

export type CompleteResult =
  | { ok: true }
  | {
      ok: false;
      problems: string[];
      /** 誤りのある場所（形が違う区間、境界に別の色が混ざっている所など）。 */
      errorPoints: number[];
      /** 入力した目数が違う色。 */
      wrongAnswers: Color[];
    };

/**
 * 1 つの盤面を共有する整地（仕様書 §2）。プレイヤー（Player）が 1 人ならひとりでモード、
 * 2 人なら対戦になる。盤・アゲハマ・境界の判定・印はプレイヤー間で共有する。
 */
export class Match {
  readonly position: Position;
  readonly initialScores: Record<Color, number>;
  readonly options: MatchOptions;
  readonly players: Player[] = [];
  /** 間違えた箇所の印（点インデックス）。 */
  readonly marks = new Set<number>();
  /** 各トレイに入れられる石の上限（アゲハマの総数）。生きた石をアゲハマにはできない。 */
  readonly trayCapacity: Record<Color, number> = { [BLACK]: 0, [WHITE]: 0 };
  /** 開始の合図（begin）の時刻。合図の前は null。 */
  startedAt: number | null = null;
  /** 終局図（やり直し用）。 */
  readonly initial: Position;
  /** 開始時の中立の空点（セキ）。 */
  private readonly baseOpenPoints = new Set<number>();
  /** 最後に境界が閉じていた時点の目数。 */
  settledScores!: Record<Color, number>;
  /** 最後に境界が閉じていた時点で、各点がどちらの地だったか（地でなければ EMPTY）。 */
  settledOwner!: Uint8Array;
  /** 最後に境界が閉じていた時点の各点の持ち主（生きた石の色、または地の色）。 */
  private settledColor!: Uint8Array;

  constructor(position: Position, options: MatchOptions) {
    this.position = { board: position.board.clone(), trays: { ...position.trays } };
    this.initial = { board: position.board.clone(), trays: { ...position.trays } };
    this.options = options;
    this.initialScores = this.scores();
    for (const region of analyze(this.board).regions) {
      if (region.owner !== null) continue;
      for (const i of region.points) if (this.board.cells[i] === EMPTY) this.baseOpenPoints.add(i);
    }
    // トレイに入るアゲハマの総数 = 対局中に取った石 + 盤上の相手の死に石
    for (const owner of [BLACK, WHITE] as const) {
      this.trayCapacity[owner] = this.position.trays[owner] + countDead(this.board, opponent(owner));
    }
    this.markSettled();
  }

  get board(): Board {
    return this.position.board;
  }

  get shapeRules(): ShapeRules {
    return this.options.shapeRules ?? DEFAULT_SHAPE_RULES;
  }

  get started(): boolean {
    return this.startedAt !== null;
  }

  /** 開始の合図。ここからタイムを計る。 */
  begin(): void {
    this.startedAt ??= this.now();
  }

  /**
   * 判定に使う局面: プレイヤーが持っている石を、すべて持ち出した場所（盤の点かトレイ）に戻したとみなす。
   * 対戦では相手が石を持っている最中にも自分の判定が行われるので、持っている石で目数や境界が
   * 一時的に変わって見えても、それを自分のせいにしないため。
   */
  restingPosition(): Position {
    if (this.players.every((p) => !p.hand)) return this.position;
    const board = this.board.clone();
    const trays = { ...this.position.trays };
    for (const p of this.players) {
      for (const stone of p.hand?.stones ?? []) {
        const { source } = stone;
        if (source.kind === "tray") trays[source.owner]++;
        else if (board.cells[source.point] === EMPTY) {
          board.set(source.point % board.size, Math.floor(source.point / board.size), stone.color, stone.dead);
        }
      }
    }
    return { board, trays };
  }

  /** 目数（持っている石は元の場所にあるとみなす）。 */
  scores(): Record<Color, number> {
    const position = this.restingPosition();
    const analysis = analyze(position.board);
    return {
      [BLACK]: score(position, BLACK, analysis),
      [WHITE]: score(position, WHITE, analysis),
    };
  }

  /** 境界が開いているか（どちらの地でもない空点が開始時より多い。持っている石は元の場所にあるとみなす）。 */
  get boundaryOpen(): boolean {
    return openPoints(this.restingPosition().board) > this.baseOpenPoints.size;
  }

  /**
   * 境界が開いている間に目数を変えたプレイヤー。ほかのプレイヤーが境界を開いてから
   * 動かした石を元に戻した盤で、境界が閉じていて目数が変わっていれば、そのプレイヤーの操作だけで
   * 目数が変わったと分かる。
   */
  culprits(): Player[] {
    return this.players.filter((p) => {
      if (p.pendingMoves.length === 0) return false;
      const resting = this.restingPosition();
      const position = { board: resting.board.clone(), trays: { ...resting.trays } };
      for (const other of this.players) if (other !== p) revertMoves(position, other.pendingMoves);
      if (openPoints(position.board) > this.baseOpenPoints.size) return false;
      const analysis = analyze(position.board);
      const scores = { [BLACK]: score(position, BLACK, analysis), [WHITE]: score(position, WHITE, analysis) };
      return !sameScores(scores, this.settledScores);
    });
  }

  /**
   * 境界が開いている所（開始時のセキを除く、両方の色に接する領域）。
   * 接している石の少ない方の色が 3 個以下なら、その石（地に混ざった別の色の石）を返す。
   * そうでなければ、両方の色に接している空点（境界の切れ目）を返す。
   */
  openSpots(analysis = analyze(this.board)): number[] {
    const spots: number[] = [];
    for (const region of analysis.regions) {
      if (region.owner !== null) continue;
      const empties = region.points.filter((i) => this.board.cells[i] === EMPTY && !this.baseOpenPoints.has(i));
      if (empties.length === 0) continue;
      const touching: Record<Color, Set<number>> = { [BLACK]: new Set(), [WHITE]: new Set() };
      for (const i of region.points) {
        for (const j of this.board.neighbors(i)) {
          if (this.board.isLiveStone(j)) touching[this.board.cells[j] as Color].add(j);
        }
      }
      const minority = touching[BLACK].size <= touching[WHITE].size ? touching[BLACK] : touching[WHITE];
      if (minority.size <= 3) {
        spots.push(...minority);
      } else {
        spots.push(
          ...empties.filter((i) => {
            const colors = new Set(
              this.board.neighbors(i).filter((j) => this.board.isLiveStone(j)).map((j) => this.board.cells[j]),
            );
            return colors.size === 2;
          }),
        );
      }
    }
    return spots;
  }

  /** 境界が閉じていて目数が正しい状態として記録する。 */
  markSettled(): void {
    const board = this.restingPosition().board;
    this.settledScores = this.scores();
    this.settledOwner = new Uint8Array(board.cells.length);
    for (const region of analyze(board).regions) {
      if (!region.territory || region.owner === null) continue;
      for (const i of region.points) this.settledOwner[i] = region.owner;
    }
    this.settledColor = colorMap(board);
    for (const p of this.players) p.clearPending();
  }

  /** 最後に境界が閉じていた時点から、持ち主（石の色または地の色、どちらでもない）が変わった点。 */
  changedPoints(): number[] {
    const now = colorMap(this.restingPosition().board);
    const points: number[] = [];
    for (let i = 0; i < now.length; i++) if (this.settledColor[i] !== now[i]) points.push(i);
    return points;
  }

  /** 最後に境界が閉じていた時点から、持ち主（石の色または地の色）が黒⇔白で入れ替わった点。 */
  flippedPoints(): number[] {
    const now = colorMap(this.restingPosition().board);
    const points: number[] = [];
    for (let i = 0; i < now.length; i++) {
      const before = this.settledColor[i];
      if (before !== EMPTY && now[i] !== EMPTY && before !== now[i]) points.push(i);
    }
    return points;
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/**
 * 盤を操作する 1 人のプレイヤー。持っている石・ペナルティ・フェーズ・完了時刻を持つ。
 */
export class Player {
  readonly match: Match;
  readonly color: Color | null;
  readonly restricted: boolean;
  /** 一度に持てる石の数の上限。 */
  readonly handLimit: number;
  hand: Hand | null = null;
  phase: Phase = "removal";
  penalties = 0;
  finishedAt: number | null = null;
  /** 死に石取りで、死に石でないために元に戻した石の点（演出用）。読んだら clearRejected で消す。 */
  rejected: { point: number; color: Color }[] = [];
  /** 開始から自分が動かした石（元に戻した分は逆向きの移動として記録）。ギブアップで巻き戻す。 */
  private history: Move[] = [];
  /** 境界が開いてから自分が動かした石。 */
  private pending = { moves: [] as Move[], placed: [] as number[], origins: [] as number[], carriedMark: false };

  constructor(match: Match, options: PlayerOptions) {
    this.match = match;
    this.color = options.color;
    this.restricted = options.restricted ?? false;
    this.handLimit = Math.max(1, options.handLimit ?? Infinity);
    match.players.push(this);
    this.updatePhase();
  }

  // --- 共有状態の読み出し（画面から使う） ---

  get position(): Position {
    return this.match.position;
  }
  get board(): Board {
    return this.match.board;
  }
  get marks(): Set<number> {
    return this.match.marks;
  }
  get initialScores(): Record<Color, number> {
    return this.match.initialScores;
  }
  get trayCapacity(): Record<Color, number> {
    return this.match.trayCapacity;
  }
  get boundaryOpen(): boolean {
    return this.match.boundaryOpen;
  }
  get started(): boolean {
    return this.match.started;
  }
  get startedAt(): number | null {
    return this.match.startedAt;
  }
  begin(): void {
    this.match.begin();
  }
  scores(): Record<Color, number> {
    return this.match.scores();
  }

  /** 整地を担当する地の色。対戦では相手の地、ひとりでモードでは両方。 */
  get assigned(): Color[] {
    return this.color === null ? [BLACK, WHITE] : [opponent(this.color)];
  }

  /** 使えるアゲハマトレイ。対戦では自分のトレイだけ。 */
  canUseTray(owner: Color): boolean {
    return this.color === null || owner === this.color;
  }

  /**
   * 盤上のこの石を持てるか。担当外の石の操作を制限する設定のときは、担当の地（相手の地）の
   * 整地に関わる石だけ: 相手の色の石と、相手の石（または担当の地）に接している自分の色の石
   * （黒白の境界線の石）。自分の地の側の石（例: 自分の石の塊の中央）は持てない。
   */
  canPick(i: number): boolean {
    const cell = this.board.cells[i];
    if (cell === EMPTY) return false;
    if (!this.restricted || this.color === null || cell === opponent(this.color)) return true;
    const target = opponent(this.color);
    return this.board
      .neighbors(i)
      .some((j) => this.match.settledOwner[j] === target || (this.board.cells[j] === target && this.board.isLiveStone(j)));
  }

  /** この点に置けるか（制限する設定のとき、自分の地（相手が整地する地）には置けない）。 */
  canPlace(i: number): boolean {
    if (this.board.cells[i] !== EMPTY) return false;
    return !this.restricted || this.color === null || this.match.settledOwner[i] !== this.color;
  }

  clearRejected(): void {
    this.rejected = [];
  }

  /** ペナルティ込みの経過時間（ミリ秒）。 */
  elapsed(): number {
    const start = this.match.startedAt;
    if (start === null) return 0;
    return (this.finishedAt ?? this.match.now()) - start + this.penalties * PENALTY_MS;
  }

  // --- 操作 ---

  /**
   * 盤上の石を持つ。points は持つ順番に並べる。
   * 石を持っている最中なら、持っている石に追加する（持った順番の最後に並ぶ）。
   */
  /** あと何個持てるか。 */
  get handRoom(): number {
    return this.handLimit - (this.hand?.stones.length ?? 0);
  }

  /**
   * 盤上の石を持つ（範囲選択では範囲内の石すべて）。持てる数の上限を超える分は、
   * points の順で後ろの石を残す（範囲選択では起点に近い順に並べて渡す。byDistanceFrom）。
   */
  pickUp(points: number[]): boolean {
    if (this.phase === "finished") return false;
    const stones = points.filter((i) => this.canPick(i)).slice(0, Math.max(0, this.handRoom));
    if (stones.length === 0) return false;
    const hand = this.ensureHand();
    for (const i of stones) {
      const marked = this.marks.delete(i);
      hand.stones.push({
        color: this.board.cells[i] as Color,
        dead: this.board.dead[i] === 1,
        source: { kind: "board", point: i },
        marked,
      });
      hand.origins.push(i);
      if (marked) hand.carriedMark = true;
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
    if (this.phase !== "removal") return false;
    // 対戦では自分のトレイにしか入れられないので、自分の色の石は取れない
    if (this.color !== null && this.board.cells[i] === this.color) return false;
    if (!this.pickUp([i])) return false;
    for (const owner of [BLACK, WHITE] as const) if (this.canUseTray(owner)) this.dropToTray(owner, Infinity);
    return true;
  }

  /** アゲハマトレイから石を count 個持つ。石を持っている最中なら追加する。 */
  pickFromTray(owner: Color, count = 1): boolean {
    const n = Math.min(count, this.position.trays[owner], this.handRoom);
    if (this.phase !== "arrange" || n <= 0 || !this.canUseTray(owner)) return false;
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
      const point =
        this.board.cells[source.point] === EMPTY ? source.point : hand.origins.find((i) => this.board.cells[i] === EMPTY);
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
    if (hand.moves.length > 0) this.settle(hand);
  }

  /**
   * 持っている石を 1 個、クリックした空点に置く。残りは持ったまま。置く石は次の順で選ぶ。
   * 1. その点から持ち上げた石（color を指定したときはその色の場合だけ）。元の位置に戻すのと同じ
   * 2. color の石のうち最初に持った石
   * 3. 最初に持った石
   */
  placeAt(i: number, color?: Color): boolean {
    const hand = this.hand;
    if (!hand || this.phase !== "arrange" || !this.canPlace(i)) return false;
    const own = hand.stones.findIndex(
      (s) => s.source.kind === "board" && s.source.point === i && (color === undefined || s.color === color),
    );
    const k = own >= 0 ? own : Math.max(0, hand.stones.findIndex((s) => s.color === color));
    const [stone] = hand.stones.splice(k, 1);
    const { x, y } = this.board.point(i);
    this.board.set(x, y, stone.color, stone.dead);
    hand.placed.push(i);
    hand.moves.push({ color: stone.color, dead: stone.dead, from: stone.source, to: { kind: "board", point: i } });
    // アゲハマと、間違いの印が付いていた石は、相手の地に置いたらその場で判定する
    if (stone.source.kind === "tray" || stone.marked) hand.placedPrisoners.push(i);
    if (hand.stones.length === 0) {
      this.hand = null;
      this.settle(hand);
    }
    return true;
  }

  /**
   * 持っている石をアゲハマトレイに移す。トレイ owner には相手の色の石だけが入る。
   * 盤に置くときと同じく、持った順に count 個（既定は 1 個）ずつ入れる。入らない色の石は持ったまま。
   */
  dropToTray(owner: Color, count = 1): boolean {
    const hand = this.hand;
    if (!hand || !this.canUseTray(owner)) return false;
    const color = opponent(owner);
    // 死に石取りでは死に石かどうかを手が空になった時点で判定するので、ここでは制限しない
    const room = this.phase === "removal" ? Infinity : this.trayCapacity[owner] - this.position.trays[owner];
    const limit = Math.min(count, room);
    let moved = 0;
    hand.stones = hand.stones.filter((s) => {
      if (moved >= limit || s.color !== color) return true;
      moved++;
      hand.moves.push({ color: s.color, dead: s.dead, from: s.source, to: { kind: "tray", owner } });
      return false;
    });
    if (moved === 0) return false;
    this.position.trays[owner] += moved;
    if (hand.stones.length === 0) {
      this.hand = null;
      this.settle(hand);
    }
    return true;
  }

  /**
   * 完了を宣言する（仕様書 §2.6）。answer は担当した地の目数。
   * 誤りならペナルティを科し、そのまま続ける。
   */
  complete(answer: Partial<Record<Color, number>>): CompleteResult {
    if (this.phase === "finished") return { ok: true };
    const problems: string[] = [];
    if (this.hand) problems.push("石を持っている");
    if (this.phase === "removal") problems.push("死に石が残っている");
    const scores = this.scores();
    if (this.boundaryOpen) problems.push("境界が開いている");
    else if (!sameScores(scores, this.initialScores)) problems.push("間違えて置いた石がある");
    const analysis = analyze(this.board);
    const errorPoints = new Set<number>();
    const wrongAnswers: Color[] = [];
    for (const color of this.assigned) {
      const name = color === BLACK ? "黒地" : "白地";
      const check = checkTerritory(this.position, color, analysis, this.match.shapeRules);
      problems.push(...check.problems.map((p) => `${name}: ${p}`));
      const remainders = check.sections.filter((s) => s.section.kind === "remainder");
      for (const { points, section } of check.sections) {
        if (section.kind === "invalid" || (section.kind === "remainder" && remainders.length > 1)) {
          for (const i of points) errorPoints.add(i);
        }
      }
      if (answer[color] !== this.initialScores[color]) {
        problems.push(`${name}の目数が違う`);
        wrongAnswers.push(color);
      }
    }
    for (const i of this.match.openSpots(analysis)) errorPoints.add(i);
    if (problems.length > 0) {
      this.penalties++;
      return { ok: false, problems, errorPoints: [...errorPoints], wrongAnswers };
    }
    this.phase = "finished";
    this.finishedAt = this.match.now();
    return { ok: true };
  }

  /**
   * 自分が開始から動かした石をすべて元に戻す（ギブアップ用）。ほかのプレイヤーの操作には触れない。
   * フェーズは死に石取りからやり直す。
   */
  /**
   * ギブアップのとき、ここまでの整地を CPU に引き継げるか。持っている石は先に戻しておく。
   * 境界が閉じていて目数が変わっておらず、間違いの印もなければ引き継げる。
   */
  canHandOver(): boolean {
    return !this.hand && !this.boundaryOpen && this.marks.size === 0 && sameScores(this.scores(), this.initialScores);
  }

  revertAll(): void {
    this.cancel();
    const history = this.history;
    this.history = [];
    this.undo(history);
    this.history = [];
    this.marks.clear();
    this.restartPhase();
    if (!this.boundaryOpen) this.match.markSettled();
  }

  clearPending(): void {
    this.pending = { moves: [], placed: [], origins: [], carriedMark: false };
  }

  /** 終局図に戻したときなど、フェーズを最初からやり直す。 */
  protected restartPhase(): void {
    this.hand = null;
    this.rejected = [];
    this.clearPending();
    this.phase = "removal";
    this.updatePhase();
  }

  // --- 判定 ---

  /**
   * 手が空になった時点でペナルティを判定する（仕様書 §2.5）。
   *
   * - アゲハマを相手の地に置いた明らかな誤りは、その場でペナルティ。
   * - 境界が開いている間は判定を保留し、閉じた時点で目数を比べる。
   *   境界の石を動かしても、目数が変わらなければペナルティにしない。
   *   目数が変わっていたら、境界を閉じたプレイヤーのペナルティとする。
   */
  private settle(hand: Hand): void {
    this.history.push(...hand.moves);
    if (this.phase === "removal") {
      this.settleRemoval(hand);
      return;
    }

    if (this.placedInEnemyTerritory(hand.placedPrisoners)) {
      if (hand.carriedMark) {
        // 間違えた石を別の誤った場所に動かしただけなら、印も一緒に動かす
        for (const i of hand.placed) this.marks.add(i);
      } else {
        this.penalize(hand.moves, hand.placed, hand.origins);
      }
      return;
    }

    const pending = this.pending;
    pending.moves.push(...hand.moves);
    pending.placed.push(...hand.placed);
    pending.origins.push(...hand.origins);
    pending.carriedMark ||= hand.carriedMark;
    if (this.boundaryOpen) return;

    const match = this.match;
    const scores = this.scores();
    if (sameScores(scores, this.initialScores)) {
      this.marks.clear();
    } else if (sameScores(scores, match.settledScores)) {
      if (pending.carriedMark) for (const i of pending.placed) this.marks.add(i);
    } else {
      // 目数を変えたプレイヤーを特定する: 境界が開く前と比べて持ち主が変わった点に、
      // 石を置いたり、そこから石を持ち出したりしたプレイヤー。見つからなければ境界を閉じた自分
      let culprits = match.culprits();
      if (culprits.length === 0) {
        const changed = new Set(match.changedPoints());
        culprits = match.players.filter((pl) => pl.touched(changed));
      }
      // 持ち主が黒⇔白で入れ替わった点が原因（例: 白の壁石を黒石に置き換えた）。
      // 見つからなければ、境界が開いてから動かした石すべてに印を付ける
      const flipped = match.flippedPoints();
      for (const pl of culprits.length > 0 ? culprits : [this]) pl.penalizePending(flipped);
      if (!this.boundaryOpen) match.markSettled();
      return;
    }
    match.markSettled();
  }

  /**
   * 死に石取りのフェーズ: 死に石以外の石を取ったら、設定によらず元に戻す。
   * 目数では判定しない（自分の地の中の生きた石を取ると、地が 1 増えアゲハマも 1 増えて
   * 目数が変わらないため）。
   */
  private settleRemoval(hand: Hand): void {
    const live = hand.moves.filter((m) => !m.dead && m.from.kind === "board");
    if (live.length > 0) {
      this.penalties++;
      this.rejected = live.map((m) => ({ point: (m.from as { point: number }).point, color: m.color }));
      this.undo(hand.moves);
    }
    this.updatePhase();
    if (!this.boundaryOpen) this.match.markSettled();
  }

  /** ペナルティを科し、設定に応じて自分の動かした石を元に戻すか、印を付ける。 */
  /** 境界が開いてから動かした石。 */
  get pendingMoves(): readonly Move[] {
    return this.pending.moves;
  }

  /** 境界が開いてから自分が動かした石が、points のどれかに触れているか。 */
  touched(points: Set<number>): boolean {
    return this.pending.moves.some(
      (m) => (m.from.kind === "board" && points.has(m.from.point)) || (m.to.kind === "board" && points.has(m.to.point)),
    );
  }

  /** 境界が閉じた時点で目数を変えていたときのペナルティ。境界が開いてから自分が動かした石を対象にする。 */
  penalizePending(flipped: number[]): void {
    const { moves, placed, origins } = this.pending;
    // 境界の状態の記録し直し（markSettled）は、責任者全員を処理した後に呼び出し側で行う
    this.penalize(moves, flipped.length > 0 ? flipped : placed, flipped.length > 0 ? [] : origins, false);
  }

  private penalize(moves: Move[], placed: number[], origins: number[], settle = true): void {
    this.penalties++;
    this.clearPending();
    if (this.match.options.undoOnPenalty) {
      this.undo(moves);
    } else {
      for (const i of [...placed, ...origins]) this.marks.add(i);
    }
    if (sameScores(this.scores(), this.initialScores)) this.marks.clear();
    if (settle && !this.boundaryOpen) this.match.markSettled();
  }

  /**
   * 自分が動かした石を逆順に元の場所へ戻す。ほかのプレイヤーの操作には触れない。
   * 元の点がほかの石で埋まっていたら、その石は手に持った状態にする。
   */
  private undo(moves: Move[]): void {
    const board = this.board;
    const trays = this.position.trays;
    const left: HeldStone[] = [];
    for (const m of [...moves].reverse()) {
      // 置いた先から取り除く（すでに動いていたら飛ばす）
      if (m.to.kind === "board") {
        if (board.cells[m.to.point] !== m.color) continue;
        board.set(m.to.point % board.size, Math.floor(m.to.point / board.size), EMPTY);
      } else {
        if (trays[m.to.owner] <= 0) continue;
        trays[m.to.owner]--;
      }
      // 持ち出した場所に戻す
      if (m.from.kind === "tray") {
        trays[m.from.owner]++;
      } else if (board.cells[m.from.point] === EMPTY) {
        board.set(m.from.point % board.size, Math.floor(m.from.point / board.size), m.color, m.dead);
      } else {
        left.push({ color: m.color, dead: m.dead, source: m.from });
        continue;
      }
      this.history.push({ color: m.color, dead: m.dead, from: m.to, to: m.from });
    }
    if (left.length > 0) {
      const hand = this.ensureHand();
      hand.stones.push(...left);
    }
  }

  /**
   * 置いたアゲハマのどれかが、その石と反対の色の地の中にあるか。
   * 境界が開いている間も判定できるよう、最後に境界が閉じていた時点の地で判定する。
   * 盤上の石の移動（境界線をずらすなど）はここでは判定せず、境界が閉じた時点で
   * 黒白それぞれの地の総数だけを比べる。
   */
  private placedInEnemyTerritory(placed: number[]): boolean {
    return placed.some((i) => this.match.settledOwner[i] === opponent(this.board.cells[i] as Color));
  }

  private ensureHand(): Hand {
    this.hand ??= { stones: [], origins: [], placed: [], placedPrisoners: [], carriedMark: false, moves: [] };
    return this.hand;
  }

  /** 死に石取りが終わったら整地に進む。対戦では自分の地の中の相手の死に石だけを見る。 */
  updatePhase(): void {
    if (this.phase !== "removal") return;
    const done = this.color === null ? isRemovalDone(this.board) : isRemovalDone(this.board, this.color);
    if (done) this.phase = "arrange";
  }
}

/** 各点の持ち主: 生きた石ならその色、地ならその色、どちらでもなければ EMPTY。 */
function colorMap(board: Board): Uint8Array {
  const map = new Uint8Array(board.cells.length);
  for (const region of analyze(board).regions) {
    if (!region.territory || region.owner === null) continue;
    for (const i of region.points) map[i] = region.owner;
  }
  for (let i = 0; i < map.length; i++) if (board.isLiveStone(i)) map[i] = board.cells[i];
  return map;
}

/**
 * 石の移動を逆順に元に戻す（目数の判定用）。同じ色の石は区別しないので、
 * 置いた先にもう石がなかったり、元の点が埋まっていたりしたら、その分は飛ばす。
 */
function revertMoves(position: Position, moves: readonly Move[]): void {
  const { board, trays } = position;
  for (const m of [...moves].reverse()) {
    if (m.to.kind === "board") {
      if (board.cells[m.to.point] !== m.color) continue;
      board.set(m.to.point % board.size, Math.floor(m.to.point / board.size), EMPTY);
    } else {
      if (trays[m.to.owner] <= 0) continue;
      trays[m.to.owner]--;
    }
    if (m.from.kind === "tray") trays[m.from.owner]++;
    else if (board.cells[m.from.point] === EMPTY) {
      board.set(m.from.point % board.size, Math.floor(m.from.point / board.size), m.color, m.dead);
    }
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

/**
 * 範囲選択した点を、起点（ドラッグを始めた点）に近い順に並べる。持てる数の上限を超えるときは、
 * この順に上限まで持つ。距離が同じなら上の行から左→右の順。
 */
export function byDistanceFrom(size: number, points: number[], origin: number): number[] {
  const ox = origin % size;
  const oy = Math.floor(origin / size);
  const dist = (i: number) => ((i % size) - ox) ** 2 + (Math.floor(i / size) - oy) ** 2;
  return [...points].sort((a, b) => dist(a) - dist(b) || a - b);
}

function sameScores(a: Record<Color, number>, b: Record<Color, number>): boolean {
  return a[BLACK] === b[BLACK] && a[WHITE] === b[WHITE];
}
