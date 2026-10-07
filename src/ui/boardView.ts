import { BLACK, Board, EMPTY } from "../core/board";

const CELL = 40;
const MARGIN = 30;
const SVG_NS = "http://www.w3.org/2000/svg";

/** 盤面の SVG 描画と、画面座標 → 点インデックスの変換。 */
export class BoardView {
  readonly svg: SVGSVGElement;
  private readonly size: number;
  private readonly stoneLayer: SVGGElement;
  private readonly overlay: SVGGElement;

  constructor(size: number) {
    this.size = size;
    const extent = MARGIN * 2 + CELL * (size - 1);
    this.svg = el("svg", { viewBox: `0 0 ${extent} ${extent}`, class: "board" });
    this.svg.append(el("rect", { x: 0, y: 0, width: extent, height: extent, class: "board-bg" }));

    const grid = el("g", { class: "grid" });
    for (let k = 0; k < size; k++) {
      const p = MARGIN + k * CELL;
      const end = MARGIN + (size - 1) * CELL;
      grid.append(el("line", { x1: MARGIN, y1: p, x2: end, y2: p }));
      grid.append(el("line", { x1: p, y1: MARGIN, x2: p, y2: end }));
    }
    for (const [x, y] of starPoints(size)) {
      grid.append(el("circle", { cx: MARGIN + x * CELL, cy: MARGIN + y * CELL, r: 4, class: "star" }));
    }
    this.svg.append(grid);

    this.stoneLayer = el("g", {});
    this.overlay = el("g", { class: "overlay" });
    this.svg.append(this.stoneLayer, this.overlay);
  }

  render(board: Board, marks: Set<number>, origin: number[]): void {
    this.stoneLayer.replaceChildren();
    for (let i = 0; i < board.cells.length; i++) {
      const { x, y } = board.point(i);
      const cx = MARGIN + x * CELL;
      const cy = MARGIN + y * CELL;
      if (board.cells[i] !== EMPTY) {
        const color = board.cells[i] === BLACK ? "black" : "white";
        this.stoneLayer.append(el("circle", { cx, cy, r: CELL * 0.47, class: `stone ${color}` }));
      } else if (origin.includes(i)) {
        this.stoneLayer.append(el("circle", { cx, cy, r: CELL * 0.47, class: "origin" }));
      }
      if (marks.has(i)) {
        const d = CELL * 0.22;
        this.stoneLayer.append(
          el("path", { d: `M${cx - d} ${cy - d}L${cx + d} ${cy + d}M${cx + d} ${cy - d}L${cx - d} ${cy + d}`, class: "mark" }),
        );
      }
    }
  }

  /** 範囲選択の矩形を表示する。null で消す。 */
  showSelection(a: number | null, b: number | null): void {
    this.overlay.replaceChildren();
    if (a === null || b === null) return;
    const [x1, y1] = [a % this.size, Math.floor(a / this.size)];
    const [x2, y2] = [b % this.size, Math.floor(b / this.size)];
    const left = MARGIN + (Math.min(x1, x2) - 0.5) * CELL;
    const top = MARGIN + (Math.min(y1, y2) - 0.5) * CELL;
    const width = (Math.abs(x1 - x2) + 1) * CELL;
    const height = (Math.abs(y1 - y2) + 1) * CELL;
    this.overlay.append(el("rect", { x: left, y: top, width, height, class: "selection" }));
  }

  /** 画面座標に最も近い点。盤の外なら null。 */
  pointAt(clientX: number, clientY: number): number | null {
    const rect = this.svg.getBoundingClientRect();
    const extent = MARGIN * 2 + CELL * (this.size - 1);
    const scale = extent / rect.width;
    const x = Math.round(((clientX - rect.left) * scale - MARGIN) / CELL);
    const y = Math.round(((clientY - rect.top) * scale - MARGIN) / CELL);
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    return y * this.size + x;
  }
}

function starPoints(size: number): [number, number][] {
  if (size === 9) return [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]];
  const e = 3;
  const m = Math.floor(size / 2);
  const f = size - 4;
  return [e, m, f].flatMap((x) => [e, m, f].map((y) => [x, y] as [number, number]));
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
