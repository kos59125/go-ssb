import { BLACK, Color, EMPTY, opponent } from "../core/board";

export const PASS = -1;

export interface Move {
  color: Color;
  /** 点インデックス。パスは PASS。 */
  point: number;
}

/**
 * 対局用の囲碁ルール（石の取り上げ、自殺手の禁止、単純なコウ）。
 * 終局図を生成する自動対局で使う。
 */
export class GoGame {
  readonly size: number;
  readonly cells: Uint8Array;
  toPlay: Color = BLACK;
  /** コウで直後に打てない点。なければ -1。 */
  koPoint = -1;
  readonly moves: Move[] = [];
  /** 各色が取った石の数（captures[BLACK] は黒が取った白石の数）。 */
  readonly captures: Record<Color, number> = { 1: 0, 2: 0 };
  private readonly adjacency: number[][];

  constructor(size: number) {
    this.size = size;
    this.cells = new Uint8Array(size * size);
    this.adjacency = [];
    for (let i = 0; i < size * size; i++) {
      const x = i % size;
      const n: number[] = [];
      if (x > 0) n.push(i - 1);
      if (x < size - 1) n.push(i + 1);
      if (i >= size) n.push(i - size);
      if (i < size * size - size) n.push(i + size);
      this.adjacency.push(n);
    }
  }

  clone(): GoGame {
    const g = new GoGame(this.size);
    g.cells.set(this.cells);
    g.toPlay = this.toPlay;
    g.koPoint = this.koPoint;
    g.moves.push(...this.moves);
    g.captures[1] = this.captures[1];
    g.captures[2] = this.captures[2];
    return g;
  }

  neighbors(i: number): number[] {
    return this.adjacency[i];
  }

  /** i を含む連の石と呼吸点。 */
  chain(i: number, cells: Uint8Array = this.cells): { stones: number[]; liberties: Set<number> } {
    const color = cells[i];
    const stones = [i];
    const liberties = new Set<number>();
    const seen = new Set([i]);
    for (let k = 0; k < stones.length; k++) {
      for (const j of this.adjacency[stones[k]]) {
        if (cells[j] === EMPTY) liberties.add(j);
        else if (cells[j] === color && !seen.has(j)) {
          seen.add(j);
          stones.push(j);
        }
      }
    }
    return { stones, liberties };
  }

  /** 各点の石が属する連の呼吸点の数（空点は 0）。 */
  libertyCounts(): Uint8Array {
    const counts = new Uint8Array(this.cells.length);
    const done = new Uint8Array(this.cells.length);
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === EMPTY || done[i]) continue;
      const { stones, liberties } = this.chain(i);
      const n = Math.min(liberties.size, 255);
      for (const s of stones) {
        counts[s] = n;
        done[s] = 1;
      }
    }
    return counts;
  }

  isLegal(i: number, color: Color = this.toPlay): boolean {
    if (i === PASS) return true;
    if (this.cells[i] !== EMPTY || i === this.koPoint) return false;
    const enemy = opponent(color);
    for (const j of this.adjacency[i]) {
      if (this.cells[j] === EMPTY) return true;
    }
    // 呼吸点がない場合: 相手の石を取れるか、自分の連が呼吸点を保てれば合法
    const cells = this.cells;
    for (const j of this.adjacency[i]) {
      const c = this.chain(j);
      if (cells[j] === enemy && c.liberties.size === 1) return true;
      if (cells[j] === color && c.liberties.size > 1) return true;
    }
    return false;
  }

  /** 自分の眼を自分で埋める手か（自動対局で避ける）。 */
  isOwnEye(i: number, color: Color = this.toPlay): boolean {
    if (this.cells[i] !== EMPTY) return false;
    if (this.adjacency[i].some((j) => this.cells[j] !== color)) return false;
    // 斜めの相手の石が多ければ欠け眼とみなす
    const x = i % this.size;
    const y = Math.floor(i / this.size);
    let enemyDiagonals = 0;
    let offBoard = 0;
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.size || ny >= this.size) offBoard++;
      else if (this.cells[ny * this.size + nx] === opponent(color)) enemyDiagonals++;
    }
    return offBoard > 0 ? enemyDiagonals === 0 : enemyDiagonals <= 1;
  }

  play(i: number): void {
    const color = this.toPlay;
    if (!this.isLegal(i, color)) throw new Error(`illegal move ${i}`);
    this.moves.push({ color, point: i });
    this.toPlay = opponent(color);
    this.koPoint = -1;
    if (i === PASS) return;

    this.cells[i] = color;
    const enemy = opponent(color);
    const captured: number[] = [];
    for (const j of this.adjacency[i]) {
      if (this.cells[j] !== enemy) continue;
      const c = this.chain(j);
      if (c.liberties.size === 0) {
        for (const s of c.stones) {
          this.cells[s] = EMPTY;
          captured.push(s);
        }
      }
    }
    this.captures[color] += captured.length;

    // 1 子を取って、打った石が 1 子・呼吸点 1 ならコウ
    if (captured.length === 1) {
      const own = this.chain(i);
      if (own.stones.length === 1 && own.liberties.size === 1) this.koPoint = captured[0];
    }
  }

  /** 直前の手がパスか。 */
  lastWasPass(): boolean {
    return this.moves.length > 0 && this.moves[this.moves.length - 1].point === PASS;
  }

  /** 連続 2 回のパスで終局。 */
  isOver(): boolean {
    const n = this.moves.length;
    return n >= 2 && this.moves[n - 1].point === PASS && this.moves[n - 2].point === PASS;
  }
}
