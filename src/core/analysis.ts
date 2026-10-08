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
  /**
   * セキの点: セキの中の空点（共有の呼吸点とセキの石の眼）と、それに接する生きた石（セキの境界の石）。
   * セキのグループの石でも、セキの中の空点に接していない石は含まない。整地では触れない（仕様書 §2.8）。
   */
  seki: Set<number>;
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

  const seki = markSeki(board, regions, regionOf);
  return { regions, regionOf, seki };
}

/** これ以上の大きさの地を持つグループは、セキではなく単独で生きているとみなす。 */
const LARGE_EYE = 7;

/**
 * セキの判定（日本ルール: セキの石の眼は地に数えない）。
 *
 * 1. 同じ色の地（その色だけに接する領域）を共有する連を、1 つのグループにまとめる。
 * 2. 眼（そのグループの色の地）が 2 つ以上あるか、LARGE_EYE 目以上の地を持つグループは
 *    単独で生きているとみなす。
 * 3. 単独で生きておらず、中立の領域（両方の色に接する領域＝共有の呼吸点）に接している
 *    グループをセキの石とし、その眼を地に数えない。
 *
 * 大きな地を持つ外側の石が共有の呼吸点に接していても、その地は数える。
 * ダメは開始時に埋めてあるので、中立の領域が残るのは基本的にセキだけである。
 */
function markSeki(board: Board, regions: Region[], regionOf: Int32Array): Set<number> {
  const total = board.size * board.size;
  const chainOf = new Int32Array(total).fill(-1);
  const chains: { color: number; regions: Set<number>; touchesNeutral: boolean; stones: number[] }[] = [];

  for (let start = 0; start < total; start++) {
    if (!board.isLiveStone(start) || chainOf[start] !== -1) continue;
    const id = chains.length;
    const color = board.cells[start];
    const adjacent = new Set<number>();
    const stones: number[] = [];
    let touchesNeutral = false;
    const stack = [start];
    chainOf[start] = id;
    while (stack.length > 0) {
      const i = stack.pop()!;
      stones.push(i);
      for (const j of board.neighbors(i)) {
        if (board.isLiveStone(j)) {
          if (board.cells[j] === color && chainOf[j] === -1) {
            chainOf[j] = id;
            stack.push(j);
          }
        } else {
          const r = regionOf[j];
          adjacent.add(r);
          if (regions[r].owner === null) touchesNeutral = true;
        }
      }
    }
    chains.push({ color, regions: adjacent, touchesNeutral, stones });
  }

  // 同じ色の地を共有する連をまとめる（union-find）
  const parent = chains.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const byEye = new Map<number, number>();
  chains.forEach((chain, k) => {
    for (const r of chain.regions) {
      if (regions[r].owner !== chain.color) continue;
      const other = byEye.get(r);
      if (other === undefined) byEye.set(r, k);
      else parent[find(k)] = find(other);
    }
  });

  const groups = new Map<number, { eyes: Set<number>; touchesNeutral: boolean; stones: number[] }>();
  chains.forEach((chain, k) => {
    const root = find(k);
    const group = groups.get(root) ?? { eyes: new Set<number>(), touchesNeutral: false, stones: [] };
    for (const r of chain.regions) if (regions[r].owner === chain.color) group.eyes.add(r);
    group.touchesNeutral ||= chain.touchesNeutral;
    group.stones.push(...chain.stones);
    groups.set(root, group);
  });

  const sekiStones: number[] = [];
  const inner = new Set<number>();
  for (const group of groups.values()) {
    if (!group.touchesNeutral) continue;
    const independent = group.eyes.size >= 2 || [...group.eyes].some((r) => regions[r].points.length >= LARGE_EYE);
    if (independent) continue;
    for (const r of group.eyes) {
      regions[r].territory = false;
      for (const i of regions[r].points) inner.add(i);
    }
    sekiStones.push(...group.stones);
  }
  const seki = new Set<number>();
  if (sekiStones.length === 0) return seki;
  // 共有の呼吸点（セキの石が接する中立の領域）
  for (const i of sekiStones) {
    for (const j of board.neighbors(i)) {
      if (board.isLiveStone(j)) continue;
      const r = regions[regionOf[j]];
      if (r.owner === null) for (const k of r.points) inner.add(k);
    }
  }
  // セキの中の点と、それに接する生きた石（境界の石）。セキのグループの石でも、
  // セキの中の点に接していなければ触れてよい
  for (const i of inner) {
    seki.add(i);
    for (const j of board.neighbors(i)) if (board.isLiveStone(j)) seki.add(j);
  }
  return seki;
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
