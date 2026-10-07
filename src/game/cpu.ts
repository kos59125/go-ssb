import { analyze } from "../core/analysis";
import { Color, EMPTY, opponent } from "../core/board";
import { checkTerritory } from "../core/judge";
import { Layout, SerializedLayout, planLayout } from "./layout";
import { Player } from "./match";

/** CPU の 1 回の操作（カーソルの表示に使う）。 */
export type CpuAction =
  | { kind: "idle" }
  | { kind: "capture"; point: number }
  | { kind: "pick"; point: number }
  | { kind: "pick-tray" }
  | { kind: "place"; point: number }
  | { kind: "drop-tray" }
  | { kind: "complete" };

/** CPU の強さの設定。 */
export interface CpuProfile {
  label: string;
  /** 1 回の操作の間隔（ミリ秒）。 */
  interval: number;
  /**
   * 整地ミス（ペナルティになる操作）の起こりやすさ。死に石でない石を取る、アゲハマを
   * 反対の色の地に置く、目数を数え間違える・整地の途中で完了してしまう、など。
   */
  mistake: number;
  /** 無駄な操作（意味のない石の移動、持ってすぐ戻す）の起こりやすさ（1 回の操作あたり）。 */
  waste: number;
  /** 一度に持つ石の最大数（盤上は範囲選択、トレイは複数個）。 */
  batch: number;
  /** 直前に操作した点から近い順に石を動かすか（カーソルの移動が少ない）。 */
  efficient: boolean;
}

/** CPU の強さ。仕様書 §3.1.1 */
export const CPU_LEVELS = {
  beginner: { label: "入門", interval: 3000, mistake: 0.1, waste: 0.25, batch: 1, efficient: false },
  easy: { label: "やさしい", interval: 2200, mistake: 0.05, waste: 0.15, batch: 1, efficient: false },
  normal: { label: "ふつう", interval: 1500, mistake: 0.02, waste: 0.08, batch: 2, efficient: true },
  hard: { label: "つよい", interval: 1000, mistake: 0.005, waste: 0.03, batch: 4, efficient: true },
  expert: { label: "達人", interval: 600, mistake: 0, waste: 0, batch: 6, efficient: true },
} as const satisfies Record<string, CpuProfile>;
export type CpuLevel = keyof typeof CPU_LEVELS;

export function isCpuLevel(value: unknown): value is CpuLevel {
  return typeof value === "string" && value in CPU_LEVELS;
}

export interface CpuOptions {
  /** 強さ。省略するとミスも無駄もしない（おまかせ用）。 */
  level?: CpuLevel;
  /** ミスや無駄な操作を決める乱数（ゲームのシードとは別）。 */
  random?: () => number;
}

/**
 * vs CPU の CPU（仕様書 §3）。step() を一定間隔で呼ぶと、1 回ずつ操作する。
 *
 * - 死に石取り: 自分の地の中にある相手の死に石を 1 個ずつ取る。
 * - 整地: 担当の地（相手の地）を、計画した形（planLayout）に向けて石を 1 個ずつ動かす。
 *   境界の石は動かさないので、境界を開いたり目数を変えたりはしない。
 * - 担当の地に死に石が残っている間（相手が取り上げる前）は待つ。
 * - 形が整い、境界が閉じていて目数も正しければ完了する。
 */
export class Cpu {
  readonly player: Player;
  /** 担当する地の色ごとの計画。 */
  private readonly layouts = new Map<Color, Layout | null>();
  private readonly profile: CpuProfile;
  private readonly random: () => number;
  /** 無駄な操作で持った石を、計画と関係なく置く（すぐ戻す）か。 */
  private wander: "move" | "return" | null = null;
  /** トレイから持った石を、間違えて反対の色の地に置く。 */
  private misplace = false;
  /** 自分が石を置いた点。印が付いたら（そのままにする設定のとき）自分で直す。 */
  private readonly placed = new Set<number>();
  /** 直前に操作した点（効率よく動かすときの基準）。 */
  private cursor: number | null = null;

  /**
   * @param layouts 担当する地の色ごとの整地の形。ひとりでモードのおまかせ（ギブアップ）では
   *   黒地・白地の両方を担当する。
   */
  constructor(player: Player, layouts: Partial<Record<Color, SerializedLayout | null>>, options: CpuOptions = {}) {
    this.player = player;
    this.profile = options.level
      ? CPU_LEVELS[options.level]
      : { label: "", interval: 0, mistake: 0, waste: 0, batch: 1, efficient: false };
    this.random = options.random ?? Math.random;
    for (const color of player.assigned) {
      const layout = layouts[color];
      this.layouts.set(color, layout ? { area: new Set(layout.area), empties: new Set(layout.empties) } : null);
    }
  }

  step(): CpuAction {
    const p = this.player;
    if (p.phase === "finished" || !p.started) return { kind: "idle" };
    if (p.hand) return this.placeHeld();
    if (p.phase === "removal") return this.removeDead();
    const fix = this.fixMistake();
    if (fix) return fix;
    if (this.chance(this.profile.waste)) {
      const waste = this.wasteMove();
      if (waste) return waste;
    }
    return this.arrange();
  }

  private chance(p: number): boolean {
    return p > 0 && this.random() < p;
  }

  private pickRandom<T>(xs: T[]): T {
    return xs[Math.floor(this.random() * xs.length)];
  }

  /** 担当の地（計画の範囲）の点。 */
  private areaPoints(): number[] {
    const points: number[] = [];
    for (const color of this.player.assigned) {
      const layout = this.validPlan(color);
      if (layout) points.push(...layout.area);
    }
    return points;
  }

  /**
   * 無駄な操作: 担当の地の石を持ち上げて、別の空点に置く（目数は変わらないが形は崩れる）か、
   * そのまま元に戻す。
   */
  private wasteMove(): CpuAction | null {
    const p = this.player;
    const board = p.board;
    const area = this.areaPoints();
    const stones = area.filter((i) => board.cells[i] !== EMPTY && board.isLiveStone(i));
    if (stones.length === 0) return null;
    const point = this.pickRandom(stones);
    if (!p.pickUp([point])) return null;
    this.wander = this.random() < 0.5 ? "move" : "return";
    return { kind: "pick", point };
  }

  /** 自分が置いて印が付いた石を持ち上げる。置き場所は placeHeld で決める。 */
  private fixMistake(): CpuAction | null {
    const p = this.player;
    for (const i of p.marks) {
      if (!this.placed.has(i) || p.board.cells[i] === EMPTY) continue;
      this.placed.delete(i);
      if (p.pickUp([i])) return { kind: "pick", point: i };
    }
    return null;
  }

  /** 死に石を 1 個取る（対戦では自分の地の中の相手の死に石、ひとりでモードではすべての死に石）。 */
  private removeDead(): CpuAction {
    const p = this.player;
    const { regions, regionOf } = analyze(p.board);
    if (this.chance(this.profile.mistake)) {
      // 整地ミス: 地に接している、死に石でない相手の石を取ってしまう（ペナルティになり、元に戻る）
      const live: number[] = [];
      for (let i = 0; i < p.board.cells.length; i++) {
        const cell = p.board.cells[i];
        if (cell === EMPTY || p.board.dead[i] === 1) continue;
        if (p.color !== null && cell === p.color) continue;
        const own = p.color ?? opponent(cell as Color);
        if (p.board.neighbors(i).some((j) => p.board.cells[j] === EMPTY && regions[regionOf[j]].owner === own)) {
          live.push(i);
        }
      }
      if (live.length > 0) {
        const point = this.pickRandom(live);
        if (p.capture(point)) return { kind: "capture", point };
      }
    }
    const targets: number[] = [];
    for (let i = 0; i < p.board.cells.length; i++) {
      if (p.board.dead[i] !== 1) continue;
      if (p.color !== null && (p.board.cells[i] === p.color || regions[regionOf[i]].owner !== p.color)) continue;
      targets.push(i);
    }
    // 効率よく動かすときは、直前に取った点から近い順に取る
    if (this.profile.efficient && this.cursor !== null) {
      const from = this.cursor;
      const size = p.board.size;
      targets.sort((a, b) => distance(a, from, size) - distance(b, from, size));
    }
    for (const i of targets) {
      if (p.capture(i)) {
        this.cursor = i;
        return { kind: "capture", point: i };
      }
    }
    p.updatePhase();
    return { kind: "idle" };
  }

  private arrange(): CpuAction {
    const p = this.player;
    const board = p.board;
    const { regions, regionOf } = analyze(board);
    for (const color of p.assigned) {
      // 担当の地に、相手が取り上げる死に石が残っている間は待つ
      for (let i = 0; i < board.cells.length; i++) {
        if (board.dead[i] === 1 && regions[regionOf[i]].owner === color) return { kind: "idle" };
      }
      const plan = this.validPlan(color);
      if (!plan) return { kind: "idle" };
      const { sinks, sources } = this.diff(plan);
      if (sinks.length + sources.length > 0 && this.chance(this.profile.mistake / 3)) {
        // 整地ミス: 整地の途中なのに完了してしまう（ペナルティ）
        this.completeWith(p.initialScores);
        return { kind: "complete" };
      }
      if (sinks.length > 0) {
        if (sources.length > 0) {
          const picked = this.grabSources(sources, sinks);
          if (p.pickUp(picked)) {
            this.cursor = picked[0];
            return { kind: "pick", point: picked[0] };
          }
        } else if (p.pickFromTray(opponent(color), Math.min(this.profile.batch, sinks.length, p.handRoom))) {
          // color の石は、相手（opponent(color)）のトレイにある
          if (this.chance(this.profile.mistake)) this.misplace = true;
          return { kind: "pick-tray" };
        }
        this.layouts.set(color, null); // 石が足りない: 計画を立て直す
        return { kind: "idle" };
      }
      if (sources.length > 0) {
        this.layouts.set(color, null);
        return { kind: "idle" };
      }
    }

    // すべての担当の地の形が整った: 境界が閉じていて目数も正しければ完了する
    const scores = p.scores();
    const ready =
      !p.boundaryOpen &&
      p.assigned.every((c) => checkTerritory(p.position, c).complete && scores[c] === p.initialScores[c]);
    if (ready) {
      const answer: Record<Color, number> = { ...p.initialScores };
      if (this.chance(Math.min(0.5, this.profile.mistake * 4))) {
        // 整地ミス: 目数を数え間違える（1 目、または 10 目ずれる）
        const c = this.pickRandom(p.assigned);
        answer[c] += this.pickRandom([-10, -1, 1, 10]);
      }
      this.completeWith(answer);
      return { kind: "complete" };
    }
    return { kind: "idle" };
  }

  private completeWith(scores: Record<Color, number>): boolean {
    const answer: Partial<Record<Color, number>> = {};
    for (const c of this.player.assigned) answer[c] = scores[c];
    return this.player.complete(answer).ok;
  }

  /** 持っている石を、その色の計画で次に埋める点に置く。埋める点がなければ元に戻す。 */
  private placeHeld(): CpuAction {
    const p = this.player;
    const stone = p.hand!.stones[0];
    const color = stone.color;
    const wander = this.wander;
    this.wander = null;
    if (wander === "return" && stone.source.kind === "board") {
      const point = stone.source.point;
      p.cancel();
      return { kind: "place", point };
    }
    if (wander === "move" && stone.source.kind === "board") {
      const area = this.layouts.get(color)?.area ?? new Set<number>();
      const origin = stone.source.point;
      const empties = [...area].filter((i) => p.board.cells[i] === EMPTY && i !== origin);
      if (empties.length > 0) {
        const point = this.pickRandom(empties);
        if (p.placeAt(point, color)) return { kind: "place", point };
      }
    }
    // 判定は手が空になった時点なので、間違えるのは最後の 1 個にする
    if (this.misplace && p.hand!.stones.length === 1) {
      this.misplace = false;
      // 整地ミス: アゲハマを反対の色の地（担当でない方の地）に置いてしまう（ペナルティ）
      const enemy = opponent(color);
      const targets: number[] = [];
      for (let i = 0; i < p.board.cells.length; i++) {
        if (p.board.cells[i] === EMPTY && p.match.settledOwner[i] === enemy) targets.push(i);
      }
      if (targets.length > 0) {
        const point = this.pickRandom(targets);
        if (p.placeAt(point, color)) {
          this.placed.add(point);
          return { kind: "place", point };
        }
      }
    }
    const plan = this.validPlan(color);
    const sinks = plan ? this.diff(plan).sinks : [];
    if (sinks.length > 0) {
      const sink = this.profile.efficient && this.cursor !== null ? nearest(sinks, this.cursor, p.board.size) : sinks[0];
      if (p.placeAt(sink, color)) {
        this.placed.add(sink);
        this.cursor = sink;
        return { kind: "place", point: sink };
      }
    }
    if (stone.source.kind === "board" && p.board.cells[stone.source.point] === EMPTY && !stone.marked) {
      p.cancel();
      return { kind: "place", point: stone.source.point };
    }
    // 間違えて置いた石を直すとき: 埋める点がなければアゲハマに戻す
    const owner = opponent(color);
    if (stone.marked && p.dropToTray(owner, Infinity) && !p.hand) return { kind: "drop-tray" };
    p.cancel();
    return { kind: "idle" };
  }

  /** color の地の計画が今の盤で使えるか確かめ、使えなければ立て直す。 */
  private validPlan(color: Color): Layout | null {
    const board = this.player.board;
    const { regions, regionOf } = analyze(board);
    // 計画を立てた後に盤が変わって（相手が境界の近くの石を動かしたなど）、範囲の石が境界の石に
    // なっていたら使えない。境界の石を動かすと境界が開くので、範囲を今の盤で確かめ直す。
    const usable = (layout: Layout) =>
      [...layout.area].every((i) => {
        if (board.cells[i] === EMPTY) return regions[regionOf[i]].owner === color && regions[regionOf[i]].territory;
        if (board.cells[i] !== color || !board.isLiveStone(i)) return false;
        return board.neighbors(i).every((j) =>
          board.cells[j] === EMPTY ? layout.area.has(j) : board.cells[j] === color && board.isLiveStone(j),
        );
      });
    const current = this.layouts.get(color);
    if (current && usable(current)) return current;
    const held = this.player.hand?.stones.filter((s) => s.color === color).length ?? 0;
    const layout = planLayout(board, color, this.player.position.trays[opponent(color)] + held, 20_000);
    this.layouts.set(color, layout);
    return layout;
  }

  /**
   * 持ち上げる石（取る点）を選ぶ。1 個ずつなら最初の埋める点に近い石。複数持てるときは、
   * 取る点だけを含む（ほかの石を含まない）矩形を範囲選択したように、まとめて持つ。
   */
  private grabSources(sources: number[], sinks: number[]): number[] {
    const board = this.player.board;
    const n = board.size;
    const anchor = this.profile.efficient && this.cursor !== null ? this.cursor : sinks[0];
    const seed = nearest(sources, anchor, n);
    const limit = Math.min(this.profile.batch, sinks.length, this.player.handRoom);
    if (limit <= 1) return [seed];
    const isSource = new Set(sources);
    const sx = seed % n;
    const sy = Math.floor(seed / n);
    let best = [seed];
    const reach = 3;
    for (let x1 = Math.max(0, sx - reach); x1 <= sx; x1++) {
      for (let x2 = sx; x2 <= Math.min(n - 1, sx + reach); x2++) {
        for (let y1 = Math.max(0, sy - reach); y1 <= sy; y1++) {
          for (let y2 = sy; y2 <= Math.min(n - 1, sy + reach); y2++) {
            const picked: number[] = [];
            let ok = true;
            for (let y = y1; y <= y2 && ok; y++) {
              for (let x = x1; x <= x2; x++) {
                const i = y * n + x;
                if (board.cells[i] === EMPTY) continue;
                if (!isSource.has(i)) {
                  ok = false;
                  break;
                }
                picked.push(i);
              }
            }
            if (ok && picked.length <= limit && picked.length > best.length) best = picked;
          }
        }
      }
    }
    // カーソルの位置（範囲選択の始点）は seed にする
    return [seed, ...best.filter((i) => i !== seed)];
  }

  /** 計画と比べて、石を置く点（sinks）と石を取る点（sources）。 */
  private diff(plan: Layout): { sinks: number[]; sources: number[] } {
    const board = this.player.board;
    const sinks: number[] = [];
    const sources: number[] = [];
    for (const i of [...plan.area].sort((a, b) => a - b)) {
      const empty = board.cells[i] === EMPTY;
      if (plan.empties.has(i) && !empty) sources.push(i);
      if (!plan.empties.has(i) && empty) sinks.push(i);
    }
    return { sinks, sources };
  }
}

function distance(a: number, b: number, size: number): number {
  return Math.abs((a % size) - (b % size)) + Math.abs(Math.floor(a / size) - Math.floor(b / size));
}

function nearest(points: number[], to: number, size: number): number {
  return points.reduce((best, q) => (distance(q, to, size) < distance(best, to, size) ? q : best));
}
