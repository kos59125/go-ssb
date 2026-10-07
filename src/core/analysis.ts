import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "./board";

/** 生きている石を壁とみなしたときの、空点と死に石からなる連結領域。 */
export interface Region {
  /** 領域に含まれる点のインデックス（昇順）。 */
  points: number[];
  /** 隣接する生きた石が 1 色だけならその色。両方、またはなしなら null。 */
  owner: Color | null;
  /** 地として数えるか。セキの中の空点は地に数えない（日本ルール）。 */
  territory: boolean;
}

export interface Analysis {
  regions: Region[];
  /** 点インデックス → regions の添字。生きた石の点は -1。 */
  regionOf: Int32Array;
}

/** 盤面を領域に分割し、地とセキを判定する。 */
export function analyze(board: Board): Analysis {
  const total = board.size * board.size;
  const regionOf = new Int32Array(total).fill(-1);
  const regions: Region[] = [];

  for (let start = 0; start < total; start++) {
    if (board.isLiveStone(start) || regionOf[start] !== -1) continue;
    const id = regions.length;
    const points: number[] = [];
    let touchesBlack = false;
    let touchesWhite = false;
    const stack = [start];
    regionOf[start] = id;
    while (stack.length > 0) {
      const i = stack.pop()!;
      points.push(i);
      for (const j of board.neighbors(i)) {
        if (board.isLiveStone(j)) {
          if (board.cells[j] === BLACK) touchesBlack = true;
          else touchesWhite = true;
        } else if (regionOf[j] === -1) {
          regionOf[j] = id;
          stack.push(j);
        }
      }
    }
    points.sort((a, b) => a - b);
    const owner = touchesBlack === touchesWhite ? null : touchesBlack ? BLACK : WHITE;
    regions.push({ points, owner, territory: owner !== null });
  }

  markSeki(board, regions, regionOf);
  return { regions, regionOf };
}

/**
 * セキの判定。中立の領域（両方の色に接する領域）に接している石の連は
 * セキの石とみなし、その連に接する領域は地に数えない。
 *
 * ダメは開始時に自動で埋めるので、中立の領域が残るのはセキだけである。
 */
function markSeki(board: Board, regions: Region[], regionOf: Int32Array): void {
  const total = board.size * board.size;
  const chainOf = new Int32Array(total).fill(-1);
  const sekiChains: boolean[] = [];
  const chainRegions: Set<number>[] = [];

  for (let start = 0; start < total; start++) {
    if (!board.isLiveStone(start) || chainOf[start] !== -1) continue;
    const id = sekiChains.length;
    const color = board.cells[start];
    const adjacent = new Set<number>();
    let seki = false;
    const stack = [start];
    chainOf[start] = id;
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (const j of board.neighbors(i)) {
        if (board.isLiveStone(j)) {
          if (board.cells[j] === color && chainOf[j] === -1) {
            chainOf[j] = id;
            stack.push(j);
          }
        } else {
          const r = regionOf[j];
          adjacent.add(r);
          if (regions[r].owner === null) seki = true;
        }
      }
    }
    sekiChains.push(seki);
    chainRegions.push(adjacent);
  }

  sekiChains.forEach((seki, id) => {
    if (!seki) return;
    for (const r of chainRegions[id]) regions[r].territory = false;
  });
}

/** 盤上の石とアゲハマトレイの状態。 */
export interface Position {
  board: Board;
  /**
   * 各色のアゲハマトレイにある石の数。
   * `trays[BLACK]` は黒が取った白石の数、`trays[WHITE]` は白が取った黒石の数。
   */
  trays: Record<Color, number>;
}

/**
 * 目数（日本ルール）。
 *
 * 目数 = 地の点数 − まだ地に埋められていない自分の色の石の数
 *
 * - 地の点数には、地の中にある相手の死に石の点も含む。
 * - 埋められていない自分の色の石 = 盤上の自分の死に石 + 相手のトレイにある石。
 *
 * 正しく整地している限り（死に石を取る、アゲハマを相手の地に埋める、
 * 地の中の石を地の中で動かす）この値は変わらない。
 */
export function score(position: Position, color: Color, analysis = analyze(position.board)): number {
  const { board, trays } = position;
  let territory = 0;
  for (const region of analysis.regions) {
    if (region.territory && region.owner === color) territory += region.points.length;
  }
  return territory - countDead(board, color) - trays[opponent(color)];
}

/** 盤上に残っている、指定した色の死に石の数。 */
export function countDead(board: Board, color: Color): number {
  let n = 0;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === color && board.dead[i] === 1) n++;
  }
  return n;
}

/** その色の地に含まれる空点の数（死に石の点を除く）。 */
export function emptyTerritory(board: Board, color: Color, analysis = analyze(board)): number {
  let n = 0;
  for (const region of analysis.regions) {
    if (!region.territory || region.owner !== color) continue;
    for (const i of region.points) if (board.cells[i] === EMPTY) n++;
  }
  return n;
}
