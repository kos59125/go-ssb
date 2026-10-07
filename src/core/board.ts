export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export type Color = typeof BLACK | typeof WHITE;
export type Cell = typeof EMPTY | Color;

export function opponent(color: Color): Color {
  return color === BLACK ? WHITE : BLACK;
}

/** 盤上の 1 点。x は左から、y は上から数える（0 始まり）。 */
export interface Point {
  x: number;
  y: number;
}

/**
 * 整地中の盤面。
 *
 * 石の色に加えて「死に石」フラグを持つ。死に石は動かしてもフラグを保ち、
 * アゲハマトレイに移した時点で通常のアゲハマになる。
 */
export class Board {
  readonly size: number;
  readonly cells: Uint8Array;
  readonly dead: Uint8Array;

  constructor(size: number, cells?: Uint8Array, dead?: Uint8Array) {
    this.size = size;
    this.cells = cells ?? new Uint8Array(size * size);
    this.dead = dead ?? new Uint8Array(size * size);
  }

  clone(): Board {
    return new Board(this.size, this.cells.slice(), this.dead.slice());
  }

  index(x: number, y: number): number {
    return y * this.size + x;
  }

  point(i: number): Point {
    return { x: i % this.size, y: Math.floor(i / this.size) };
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x: number, y: number): Cell {
    return this.cells[this.index(x, y)] as Cell;
  }

  isDead(x: number, y: number): boolean {
    return this.dead[this.index(x, y)] === 1;
  }

  set(x: number, y: number, cell: Cell, dead = false): void {
    const i = this.index(x, y);
    this.cells[i] = cell;
    this.dead[i] = cell !== EMPTY && dead ? 1 : 0;
  }

  /** 辺で隣接する点のインデックス。 */
  neighbors(i: number): number[] {
    const n = this.size;
    const x = i % n;
    const result: number[] = [];
    if (x > 0) result.push(i - 1);
    if (x < n - 1) result.push(i + 1);
    if (i >= n) result.push(i - n);
    if (i < n * n - n) result.push(i + n);
    return result;
  }

  /** 生きている石（死に石でない石）か。 */
  isLiveStone(i: number): boolean {
    return this.cells[i] !== EMPTY && this.dead[i] === 0;
  }
}

/**
 * テストやデバッグ用に、文字列から盤面を作る。
 *
 * - `.` / `+`: 空点
 * - `x` / `X`: 黒（大文字は死に石）
 * - `o` / `O`: 白（大文字は死に石）
 * - `#`: 白の別表記（仕様書の図に合わせるため）
 *
 * 行の長さが盤サイズより短い場合は、残りを空点で埋める。
 */
export function parseBoard(text: string, size?: number): Board {
  const rows = text
    .split("\n")
    .map((r) => r.replace(/\s+/g, ""))
    .filter((r) => r.length > 0);
  const n = size ?? Math.max(rows.length, ...rows.map((r) => r.length));
  const board = new Board(n);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      switch (ch) {
        case "x":
          board.set(x, y, BLACK);
          break;
        case "X":
          board.set(x, y, BLACK, true);
          break;
        case "o":
        case "#":
          board.set(x, y, WHITE);
          break;
        case "O":
          board.set(x, y, WHITE, true);
          break;
        case ".":
        case "+":
          break;
        default:
          throw new Error(`unknown board character: ${ch}`);
      }
    });
  });
  return board;
}
