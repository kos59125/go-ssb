import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";

/** 整地の目標の形。 */
export interface Layout {
  /** 動かしてよい範囲（担当の地の点と、内側の自分の色の石）。 */
  area: Set<number>;
  /** 整地後に空点として残す点。area のうちそれ以外は石にする。 */
  empties: Set<number>;
}

/**
 * color の地を、10 の倍数の区間と余りの区間（最大 1 つ）に整地した形を探す（CPU 用）。
 *
 * - 動かしてよい範囲は、color の地の点と、相手の石や地以外の空点に接していない color の石。
 *   境界の石は動かさないので、整地の途中で境界が開くことはない。
 * - 範囲の中で石の数は保存されるので、整地後の空点の数は「今の空点 − 埋めるアゲハマ」になる。
 * - 区間は矩形（10 の倍数）と、余りの区間（矩形、または奇数のときしっぽ付きの矩形）。
 *   区間どうしは辺で接しないようにする（頂点だけで接するのは可）。
 *
 * 地に死に石が残っているときや、形が見つからないときは null。
 *
 * @param prisoners 埋めるアゲハマ（color の石）の数
 */
/** Worker から受け渡すための形。 */
export interface SerializedLayout {
  area: number[];
  empties: number[];
}

/**
 * 死に石をすべて取り上げた後の局面で、黒地・白地それぞれの整地の形を探す（vs CPU 用）。
 * 見つからない色は null。
 */
export function planLayouts(position: Position): Record<Color, SerializedLayout | null> {
  const board = position.board.clone();
  const trays = { ...position.trays };
  for (let i = 0; i < board.cells.length; i++) {
    if (board.dead[i] !== 1) continue;
    trays[opponent(board.cells[i] as Color)]++;
    board.cells[i] = EMPTY;
    board.dead[i] = 0;
  }
  const result = {} as Record<Color, SerializedLayout | null>;
  for (const color of [BLACK, WHITE] as const) {
    const layout = planLayout(board, color, trays[opponent(color)]);
    result[color] = layout ? { area: [...layout.area], empties: [...layout.empties] } : null;
  }
  return result;
}

export function planLayout(board: Board, color: Color, prisoners: number, maxNodes = 200_000): Layout | null {
  const { regions } = analyze(board);
  const area = new Set<number>();
  for (const region of regions) {
    if (!region.territory || region.owner !== color) continue;
    if (region.points.some((i) => board.cells[i] !== EMPTY)) return null; // 死に石が残っている
    for (const i of region.points) area.add(i);
  }
  // 内側の石: 相手の石にも、color の地以外の空点にも接していない color の石
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] !== color || !board.isLiveStone(i)) continue;
    const inner = board.neighbors(i).every((j) =>
      board.cells[j] === EMPTY ? area.has(j) : board.cells[j] === color && board.isLiveStone(j),
    );
    if (inner && board.neighbors(i).some((j) => area.has(j))) area.add(i);
  }

  const emptiesNow = [...area].filter((i) => board.cells[i] === EMPTY).length;
  const target = Math.max(0, emptiesNow - prisoners);
  if (target === 0) return { area, empties: new Set() };

  const solver = new Solver(board, area, target, maxNodes);
  const empties = solver.solve();
  return empties ? { area, empties } : null;
}

type Shape = [number, number][];

class Solver {
  private readonly n: number;
  private readonly cells: number[];
  /** 0: 未定、1: 石、2: 空点（区間）。 */
  private readonly state: Uint8Array;
  private readonly target: number;
  private readonly remainder: number;
  private nodes = 0;

  constructor(
    private readonly board: Board,
    private readonly area: Set<number>,
    target: number,
    private readonly maxNodes: number,
  ) {
    this.n = board.size;
    this.cells = [...area].sort((a, b) => a - b);
    this.state = new Uint8Array(board.cells.length);
    this.target = target;
    this.remainder = target % 10;
  }

  solve(): Set<number> | null {
    return this.dfs(0, 0, this.remainder === 0) ? new Set(this.cells.filter((i) => this.state[i] === 2)) : null;
  }

  /**
   * @param k cells の何番目から調べるか
   * @param filled 区間にした点の数
   * @param remainderUsed 余りの区間を置いたか（余りがないときは true）
   */
  private dfs(k: number, filled: number, remainderUsed: boolean): boolean {
    if (filled === this.target) return remainderUsed;
    if (++this.nodes > this.maxNodes) return false;
    while (k < this.cells.length && this.state[this.cells[k]] !== 0) k++;
    if (k >= this.cells.length) return false;
    // 残りの未定の点をすべて使っても足りなければ打ち切る
    let free = 0;
    for (let j = k; j < this.cells.length; j++) if (this.state[this.cells[j]] === 0) free++;
    if (filled + free < this.target) return false;

    const p = this.cells[k];
    const need = this.target - filled;
    // 大きい区間から試す
    for (const { shape, remainder } of this.shapes(need, remainderUsed)) {
      const placed = this.place(p, shape);
      if (!placed) continue;
      if (this.dfs(k + 1, filled + shape.length, remainderUsed || remainder)) return true;
      this.unplace(placed);
    }
    // この点は石にする
    this.state[p] = 1;
    if (this.dfs(k + 1, filled, remainderUsed)) return true;
    this.state[p] = 0;
    return false;
  }

  /** 置ける区間の形（左上が (0,0)、行優先で最初の点が原点になるように並べる）。 */
  private shapes(need: number, remainderUsed: boolean): { shape: Shape; remainder: boolean }[] {
    const result: { shape: Shape; remainder: boolean }[] = [];
    const max = this.n;
    for (let area = Math.floor(need / 10) * 10; area >= 10; area -= 10) {
      for (const [w, h] of rectangles(area, max)) result.push({ shape: rect(w, h), remainder: false });
    }
    const r = this.remainder;
    if (!remainderUsed && r > 0 && r <= need) {
      for (const [w, h] of rectangles(r, max)) result.push({ shape: rect(w, h), remainder: true });
      if (r % 2 === 1 && r >= 3) {
        for (const shape of withTail(r - 1, max)) result.push({ shape, remainder: true });
      }
    }
    return result;
  }

  /** p を原点に shape を置く。置けたら変更した点を返す。 */
  private place(p: number, shape: Shape): { cells: number[]; walls: number[] } | null {
    const px = p % this.n;
    const py = Math.floor(p / this.n);
    const cells: number[] = [];
    for (const [dx, dy] of shape) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= this.n || y >= this.n) return null;
      const i = y * this.n + x;
      if (!this.area.has(i) || this.state[i] !== 0) return null;
      cells.push(i);
    }
    const inShape = new Set(cells);
    const walls: number[] = [];
    for (const i of cells) {
      for (const j of this.board.neighbors(i)) {
        if (inShape.has(j) || !this.area.has(j)) continue;
        if (this.state[j] === 2) return null; // ほかの区間と辺で接する
        if (this.state[j] === 0) walls.push(j);
      }
    }
    for (const i of cells) this.state[i] = 2;
    for (const j of walls) this.state[j] = 1;
    return { cells, walls };
  }

  private unplace({ cells, walls }: { cells: number[]; walls: number[] }): void {
    for (const i of cells) this.state[i] = 0;
    for (const j of walls) this.state[j] = 0;
  }
}

/** 面積 area の矩形の (幅, 高さ)。正方形に近い順。 */
function rectangles(area: number, max: number): [number, number][] {
  const result: [number, number][] = [];
  for (let w = 1; w <= max; w++) {
    if (area % w !== 0) continue;
    const h = area / w;
    if (h <= max) result.push([w, h]);
  }
  return result.sort((a, b) => Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
}

function rect(w: number, h: number): Shape {
  const shape: Shape = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) shape.push([x, y]);
  return shape;
}

/** 面積 base の矩形に、辺に接する 1 マスのしっぽを付けた形（行優先で最初の点が原点）。 */
function withTail(base: number, max: number): Shape[] {
  const result: Shape[] = [];
  for (const [w, h] of rectangles(base, max)) {
    const body = rect(w, h);
    const tails: [number, number][] = [];
    for (let x = 0; x < w; x++) tails.push([x, -1], [x, h]);
    for (let y = 0; y < h; y++) tails.push([-1, y], [w, y]);
    for (const tail of tails) {
      const cells = [...body, tail];
      const minY = Math.min(...cells.map(([, y]) => y));
      const minX = Math.min(...cells.filter(([, y]) => y === minY).map(([x]) => x));
      result.push(cells.map(([x, y]) => [x - minX, y - minY]));
    }
  }
  return result;
}
