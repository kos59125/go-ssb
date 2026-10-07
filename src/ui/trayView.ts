import { Color, WHITE } from "../core/board";

const COLUMNS = 10;
const CELL = 22;
const PAD = 4;
const MIN_ROWS = 2;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * アゲハマトレイ。アゲハマを 1 個ずつ石として並べて表示する。
 * 石は左上から詰めて並べ、マス目の位置で盤上と同じようにクリック・範囲選択できる。
 */
export class TrayView {
  readonly svg: SVGSVGElement;
  /** トレイの持ち主。並ぶのは相手の色の石。 */
  readonly owner: Color;
  private readonly stoneColor: string;
  private readonly stones: SVGGElement;
  private readonly overlay: SVGGElement;
  private rows = MIN_ROWS;

  constructor(owner: Color, stoneColor: Color) {
    this.owner = owner;
    this.stoneColor = stoneColor === WHITE ? "white" : "black";
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("tray-stones");
    this.stones = document.createElementNS(SVG_NS, "g");
    this.overlay = document.createElementNS(SVG_NS, "g");
    this.svg.append(this.stones, this.overlay);
  }

  render(count: number): void {
    this.rows = Math.max(MIN_ROWS, Math.ceil((count + 1) / COLUMNS));
    const width = PAD * 2 + COLUMNS * CELL;
    const height = PAD * 2 + this.rows * CELL;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.style.aspectRatio = `${width} / ${height}`;
    this.stones.replaceChildren();
    for (let k = 0; k < count; k++) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(PAD + (k % COLUMNS) * CELL + CELL / 2));
      circle.setAttribute("cy", String(PAD + Math.floor(k / COLUMNS) * CELL + CELL / 2));
      circle.setAttribute("r", String(CELL * 0.45));
      circle.setAttribute("class", `stone ${this.stoneColor}`);
      this.stones.append(circle);
    }
  }

  /** 画面座標にあるマスの番号。トレイの外なら null。 */
  cellAt(clientX: number, clientY: number): number | null {
    const rect = this.svg.getBoundingClientRect();
    const scale = (PAD * 2 + COLUMNS * CELL) / rect.width;
    const x = Math.floor(((clientX - rect.left) * scale - PAD) / CELL);
    const y = Math.floor(((clientY - rect.top) * scale - PAD) / CELL);
    if (x < 0 || y < 0 || x >= COLUMNS || y >= this.rows) return null;
    return y * COLUMNS + x;
  }

  /** 2 つのマスを対角とする矩形に入る、石のあるマスの数。 */
  countInRect(a: number, b: number, count: number): number {
    const [x1, y1, x2, y2] = [a % COLUMNS, Math.floor(a / COLUMNS), b % COLUMNS, Math.floor(b / COLUMNS)];
    let n = 0;
    for (let k = 0; k < count; k++) {
      const x = k % COLUMNS;
      const y = Math.floor(k / COLUMNS);
      if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) n++;
    }
    return n;
  }

  showSelection(a: number | null, b: number | null): void {
    this.overlay.replaceChildren();
    if (a === null || b === null) return;
    const [x1, y1, x2, y2] = [a % COLUMNS, Math.floor(a / COLUMNS), b % COLUMNS, Math.floor(b / COLUMNS)];
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(PAD + Math.min(x1, x2) * CELL));
    rect.setAttribute("y", String(PAD + Math.min(y1, y2) * CELL));
    rect.setAttribute("width", String((Math.abs(x1 - x2) + 1) * CELL));
    rect.setAttribute("height", String((Math.abs(y1 - y2) + 1) * CELL));
    rect.setAttribute("class", "selection");
    this.overlay.append(rect);
  }
}
