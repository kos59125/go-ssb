import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { DEFAULT_SHAPE_RULES, HOLE_PATTERNS, ShapeRules, isFiveByOdd } from "../core/shapes";

/**
 * CPU が 1 列の区間を避ける目数。この目数以上の区間は、まず 2 列以上の形（2x5、3x4−2、余りなら 2x2+1、3x3 など）
 * で探し、見つからないときだけ設定で許される 1 列の形も使う。
 */
const PREFERRED_ONE_LINE_FROM = 5;

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
 * - 区間は矩形（10 の倍数）、中に石を置く形（3x4−2、7x3−1、7x6−2）と、余りの区間（矩形、または奇数のとき
 *   しっぽ付きの矩形）。区間どうしは辺で接しないようにする（頂点だけで接するのは可）。
 * - 5 目以上の区間は、まず 1 列の形（1x10、1x7 など）を使わずに探す。見つからなければ、rules で許される
 *   範囲で 1 列の形も使う。
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
export function planLayouts(position: Position, rules: ShapeRules = DEFAULT_SHAPE_RULES): Record<Color, SerializedLayout | null> {
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
    const layout = planLayout(board, color, trays[opponent(color)], undefined, rules);
    result[color] = layout ? { area: [...layout.area], empties: [...layout.empties] } : null;
  }
  return result;
}

export function planLayout(
  board: Board,
  color: Color,
  prisoners: number,
  maxNodes = 200_000,
  rules: ShapeRules = DEFAULT_SHAPE_RULES,
): Layout | null {
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

  // まず 1 列の形を避けて探し、見つからなければ設定で許される範囲で 1 列の形も使う
  const allowed = rules.oneLineFrom ?? Infinity;
  const passes = allowed > PREFERRED_ONE_LINE_FROM ? [PREFERRED_ONE_LINE_FROM, allowed] : [allowed];
  for (const oneLineFrom of passes) {
    const empties = new Solver(board, area, target, maxNodes, oneLineFrom, rules.allowFiveByOdd).solve();
    if (empties) return { area, empties };
  }
  return null;
}

/** 区間の形。cells は空点、holes は中に置く石（3x4−2 などの形だけ）。行優先で最初の空点が原点。 */
interface Shape {
  cells: [number, number][];
  holes: [number, number][];
}

class Solver {
  private readonly n: number;
  private readonly cells: number[];
  /** 0: 未定、1: 石、2: 空点（区間）。 */
  private readonly state: Uint8Array;
  private readonly target: number;
  private nodes = 0;
  /** 10 の倍数（と、認めるときは 5 × 奇数）の区間の形（目数ごと、使いたい順）。 */
  private readonly multiples = new Map<number, Shape[]>();
  /** 余りの区間の形（目数 1〜9 ごと、使いたい順）。 */
  private readonly remainders = new Map<number, Shape[]>();

  /** @param oneLineFrom この目数以上の区間は 1 列の形にしない */
  constructor(
    private readonly board: Board,
    private readonly area: Set<number>,
    target: number,
    private readonly maxNodes: number,
    oneLineFrom: number,
    private readonly fiveByOdd: boolean,
  ) {
    this.n = board.size;
    this.cells = [...area].sort((a, b) => a - b);
    this.state = new Uint8Array(board.cells.length);
    this.target = target;
    const max = this.n;
    if (fiveByOdd) {
      for (let size = 15; size <= target; size += 10) {
        const shapes = rectangles(size, max).filter(([w, h]) => isFiveByOdd(w, h)).map(([w, h]) => rect(w, h));
        if (shapes.length > 0) this.multiples.set(size, shapes);
      }
    }
    for (let size = 10; size <= target; size += 10) {
      // 2 列以上の矩形 → 中に石を置く形 → 1 列の矩形（許されるときだけ）
      const rects = rectangles(size, max);
      const wide = rects.filter(([w, h]) => w > 1 && h > 1).map(([w, h]) => rect(w, h));
      const holes = HOLE_PATTERNS.filter((pt) => pt.w * pt.h - pt.holes.length === size && pt.w <= max && pt.h <= max).map(
        (pt) => withHoles(pt.w, pt.h, pt.holes),
      );
      const thin = size < oneLineFrom ? rects.filter(([w, h]) => w === 1 || h === 1).map(([w, h]) => rect(w, h)) : [];
      this.multiples.set(size, [...wide, ...holes, ...thin]);
    }
    for (let r = 1; r <= 9; r++) {
      const thinOk = r < oneLineFrom;
      const shapes: Shape[] = [];
      for (const [w, h] of rectangles(r, max)) if (thinOk || (w > 1 && h > 1)) shapes.push(rect(w, h));
      if (r % 2 === 1 && r >= 3) {
        for (const [w, h] of rectangles(r - 1, max)) if (thinOk || (w > 1 && h > 1)) shapes.push(...withTail(w, h));
      }
      // 2 列以上の形を先に試す
      this.remainders.set(r, shapes.sort((a, b) => Number(isThin(a)) - Number(isThin(b))));
    }
  }

  solve(): Set<number> | null {
    return this.dfs(0, 0, false) ? new Set(this.cells.filter((i) => this.state[i] === 2)) : null;
  }

  /**
   * @param k cells の何番目から調べるか
   * @param filled 区間にした点の数
   * @param remainderUsed 余りの区間を置いたか（余りの区間は全体で 1 つまで）
   */
  private dfs(k: number, filled: number, remainderUsed: boolean): boolean {
    if (filled === this.target) return true;
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
      if (this.dfs(k + 1, filled + shape.cells.length, remainderUsed || remainder)) return true;
      this.unplace(placed);
    }
    // この点は石にする
    this.state[p] = 1;
    if (this.dfs(k + 1, filled, remainderUsed)) return true;
    this.state[p] = 0;
    return false;
  }

  /** 置ける区間の形（大きい区間から）。 */
  private shapes(need: number, remainderUsed: boolean): { shape: Shape; remainder: boolean }[] {
    const result: { shape: Shape; remainder: boolean }[] = [];
    for (let size = need; size >= 10; size--) {
      for (const shape of this.multiples.get(size) ?? []) result.push({ shape, remainder: false });
    }
    if (!remainderUsed) {
      // 余りの区間を置いた残りが、10 の倍数（と 5 × 奇数）の区間で埋められる目数になるものだけ
      for (let r = Math.min(9, need); r >= 1; r--) {
        const rest = need - r;
        const ok = rest % 10 === 0 || (this.fiveByOdd && rest % 10 === 5 && rest >= 15);
        if (!ok) continue;
        for (const shape of this.remainders.get(r) ?? []) result.push({ shape, remainder: true });
      }
    }
    return result;
  }

  /** p を原点に shape を置く。置けたら変更した点を返す。 */
  private place(p: number, shape: Shape): { cells: number[]; walls: number[] } | null {
    const px = p % this.n;
    const py = Math.floor(p / this.n);
    const at = ([dx, dy]: [number, number]): number | null => {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= this.n || y >= this.n) return null;
      const i = y * this.n + x;
      return this.area.has(i) ? i : null;
    };
    const cells: number[] = [];
    for (const offset of shape.cells) {
      const i = at(offset);
      if (i === null || this.state[i] !== 0) return null;
      cells.push(i);
    }
    // 中に置く石の点（3x4−2 など）: 範囲の中で、ほかの区間になっていないこと。下の壁と同じく石にする
    for (const offset of shape.holes) {
      const i = at(offset);
      if (i === null || this.state[i] === 2) return null;
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

function isThin(shape: Shape): boolean {
  const xs = new Set(shape.cells.map(([x]) => x));
  const ys = new Set(shape.cells.map(([, y]) => y));
  if (xs.size === 1 || ys.size === 1) return true;
  // しっぽ付き: しっぽを除いた矩形が 1 列か
  const body = shape.cells.slice(0, -1);
  return new Set(body.map(([x]) => x)).size === 1 || new Set(body.map(([, y]) => y)).size === 1;
}

/** w x h の矩形から holes を除いた形。 */
function withHoles(w: number, h: number, holes: [number, number][]): Shape {
  const isHole = (x: number, y: number) => holes.some(([hx, hy]) => hx === x && hy === y);
  const cells: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isHole(x, y)) cells.push([x, y]);
  // どの形も 1 行目は空点だけなので、原点 (0,0) は空点
  return { cells, holes: holes.map(([x, y]) => [x, y]) };
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
  const cells: [number, number][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push([x, y]);
  return { cells, holes: [] };
}

/**
 * w x h の矩形に、辺に接する 1 マスのしっぽを付けた形（行優先で最初の点が原点）。
 * cells の最後がしっぽ（isThin で使う）。
 */
function withTail(w: number, h: number): Shape[] {
  const result: Shape[] = [];
  const body = rect(w, h).cells;
  const tails: [number, number][] = [];
  for (let x = 0; x < w; x++) tails.push([x, -1], [x, h]);
  for (let y = 0; y < h; y++) tails.push([-1, y], [w, y]);
  for (const tail of tails) {
    const cells = [...body, tail];
    const minY = Math.min(...cells.map(([, y]) => y));
    const minX = Math.min(...cells.filter(([, y]) => y === minY).map(([x]) => x));
    // 原点は行優先で最初の点。並びは保ったまま（最後がしっぽ）、原点だけ合わせる
    result.push({ cells: cells.map(([x, y]) => [x - minX, y - minY]), holes: [] });
  }
  return result;
}
