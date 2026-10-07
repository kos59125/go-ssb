import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { Evaluation, Evaluator } from "./model";
import { GoGame, Move, PASS } from "./go";

export const KOMI = 6.5;

/** 生成した対局。 */
export interface GeneratedGame {
  size: number;
  komi: number;
  /** 盤の向きを揃えた後の手順（黒の初手が右上）。 */
  moves: Move[];
  /** 整地開始時の局面（死に石フラグ付き、ダメは埋めてある）。 */
  position: Position;
  /** ダメとして自動で埋めた点と色。棋譜の再生後に置く。 */
  dameFills: Move[];
  /** 日本ルールでの結果（例: "B+3.5"）。 */
  result: string;
}

export interface GenerateOptions {
  size: number;
  random?: () => number;
  /** 1 手ごとに呼ばれる（進捗表示用）。 */
  onMove?: (moveNumber: number) => void;
  /** 目数差がこれを超えたら、差を縮める方向に手を選ぶ。 */
  targetMargin?: number;
  /** true を返したら生成を中断する。 */
  shouldStop?: () => boolean;
}

export class GenerationCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * KataGo の方策ネットワークで自動対局し、整地用の終局図を作る（仕様書 §5）。
 * 条件を満たさない対局は作り直す。
 */
export async function generateGame(evaluate: Evaluator, options: GenerateOptions): Promise<GeneratedGame> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const game = await selfPlay(evaluate, options);
    if (!game) continue;
    const finished = await finish(evaluate, game, options.random ?? Math.random);
    if (finished) return finished;
  }
  throw new Error("終局図を生成できませんでした");
}

async function selfPlay(evaluate: Evaluator, options: GenerateOptions): Promise<GoGame | null> {
  const { size } = options;
  const random = options.random ?? Math.random;
  const targetMargin = options.targetMargin ?? 20;
  const game = new GoGame(size);
  const maxMoves = Math.round(size * size * 1.3);

  while (!game.isOver()) {
    if (game.moves.length >= maxMoves) return null;
    if (options.shouldStop?.()) throw new GenerationCancelled();
    const ev = await evaluate(game);
    game.play(chooseMove(game, ev, random, targetMargin));
    options.onMove?.(game.moves.length);
  }
  return game;
}

/** 方策から手をサンプリングする。 */
function chooseMove(game: GoGame, ev: Evaluation, random: () => number, targetMargin: number): number {
  const area = game.size * game.size;
  const moveNumber = game.moves.length;
  const pla = game.toPlay;
  const lead = pla === BLACK ? ev.blackLead : -ev.blackLead;

  // 序盤はばらつきを持たせ、中盤以降は堅実に打つ
  let temperature = moveNumber < area * 0.1 ? 1.0 : 0.5;
  let topP = moveNumber < area * 0.1 ? 0.95 : 0.8;
  // 差が開きすぎたら、リードしている側は緩く、負けている側は最善寄りに打つ
  if (lead > targetMargin * 0.75) {
    temperature = 1.5;
    topP = 0.98;
  } else if (lead < -targetMargin * 0.75) {
    temperature = 0.25;
    topP = 0.5;
  }

  const passProb = ev.policy[area];
  // パスが最善なら素直にパスする（終局）
  let best = PASS;
  for (let i = 0; i < area; i++) if (ev.policy[i] > (best === PASS ? passProb : ev.policy[best])) best = i;
  if (best === PASS) return PASS;

  const candidates: { point: number; weight: number }[] = [];
  for (let i = 0; i < area; i++) {
    if (ev.policy[i] <= 0 || !game.isLegal(i) || game.isOwnEye(i)) continue;
    candidates.push({ point: i, weight: ev.policy[i] });
  }
  if (candidates.length === 0) return PASS;
  candidates.sort((a, b) => b.weight - a.weight);

  // top-p で候補を絞り、温度をかけてサンプリング
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let acc = 0;
  const kept: { point: number; weight: number }[] = [];
  for (const c of candidates) {
    kept.push({ point: c.point, weight: Math.pow(c.weight, 1 / temperature) });
    acc += c.weight;
    if (acc / total >= topP) break;
  }
  const sum = kept.reduce((s, c) => s + c.weight, 0);
  let r = random() * sum;
  for (const c of kept) {
    r -= c.weight;
    if (r <= 0) return c.point;
  }
  return kept[kept.length - 1].point;
}

/**
 * 終局後の処理: 死に石の判定、ダメ埋め、盤の向きの調整。
 * 判定が曖昧な対局は null を返して作り直す。
 */
async function finish(evaluate: Evaluator, game: GoGame, random: () => number): Promise<GeneratedGame | null> {
  const size = game.size;
  const area = size * size;
  const ev = await evaluate(game);
  const own = ev.ownership;

  // 死に石: 連の平均所有権が相手側に傾いている石
  const dead = new Uint8Array(area);
  const done = new Uint8Array(area);
  for (let i = 0; i < area; i++) {
    if (game.cells[i] === EMPTY || done[i]) continue;
    const { stones } = game.chain(i);
    const sign = game.cells[i] === BLACK ? 1 : -1;
    const avg = stones.reduce((s, j) => s + own[j], 0) / stones.length;
    for (const s of stones) {
      done[s] = 1;
      // 所有権が 0 付近の石はセキの可能性があるので生きとみなす
      if (avg * sign < -0.3) dead[s] = 1;
    }
  }

  const board = new Board(size, game.cells.slice(), dead);
  const dameFills = fillDame(game, board, own);
  if (!dameFills) return null;

  // 地の判定が KataGo の所有権と食い違う対局は使わない
  const analysis = analyze(board);
  for (const region of analysis.regions) {
    if (!region.territory || region.owner === null) continue;
    const sign = region.owner === BLACK ? 1 : -1;
    const avg = region.points.reduce((s, j) => s + own[j], 0) / region.points.length;
    if (avg * sign < 0.5) return null;
  }

  const position: Position = { board, trays: { [BLACK]: game.captures[BLACK], [WHITE]: game.captures[WHITE] } };
  const result = japaneseResult(position);
  return orient({ size, komi: KOMI, moves: game.moves.slice(), position, dameFills, result }, random);
}

/**
 * ダメ（両方の色に接する空点）を埋める。所有権の符号の色を優先し、
 * 石を取られたり取ったりしない方の色で埋める。埋められない空点はセキとして残す。
 */
function fillDame(game: GoGame, board: Board, own: Float32Array): Move[] | null {
  const fills: Move[] = [];
  for (let round = 0; round < board.cells.length; round++) {
    const analysis = analyze(board);
    let changed = false;
    for (const region of analysis.regions) {
      if (region.owner !== null) continue;
      for (const i of region.points) {
        if (board.cells[i] !== EMPTY) continue;
        const preferred: Color = own[i] >= 0 ? BLACK : WHITE;
        for (const color of [preferred, opponent(preferred)]) {
          if (canFill(game, board, i, color)) {
            const { x, y } = board.point(i);
            board.set(x, y, color);
            fills.push({ color, point: i });
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }

  // 埋めきれなかった中立の空点がセキでないなら（全体に影響がある）使わない
  const analysis = analyze(board);
  const neutralEmpty = analysis.regions
    .filter((r) => r.owner === null)
    .reduce((n, r) => n + r.points.filter((i) => board.cells[i] === EMPTY).length, 0);
  if (neutralEmpty > 4) return null;
  return fills;
}

/** 生きた石だけを見て、i に color を置いても石の取り合いが起きないか。 */
function canFill(game: GoGame, board: Board, i: number, color: Color): boolean {
  const cells = new Uint8Array(board.cells.length);
  for (let k = 0; k < cells.length; k++) cells[k] = board.isLiveStone(k) ? board.cells[k] : EMPTY;
  cells[i] = color;
  for (const j of [i, ...game.neighbors(i)]) {
    if (cells[j] === EMPTY) continue;
    if (game.chain(j, cells).liberties.size < 2) return false;
  }
  return true;
}

/** 日本ルールの結果。目数 = 地 − 埋められる自分の石（§1）。 */
function japaneseResult(position: Position): string {
  const analysis = analyze(position.board);
  const territory = { [BLACK]: 0, [WHITE]: 0 };
  for (const r of analysis.regions) if (r.territory && r.owner !== null) territory[r.owner] += r.points.length;
  let deadBlack = 0;
  let deadWhite = 0;
  const { board, trays } = position;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.dead[i] !== 1) continue;
    if (board.cells[i] === BLACK) deadBlack++;
    else deadWhite++;
  }
  const black = territory[BLACK] - deadBlack - trays[WHITE];
  const white = territory[WHITE] - deadWhite - trays[BLACK] + KOMI;
  const diff = black - white;
  return diff > 0 ? `B+${diff.toFixed(1)}` : `W+${(-diff).toFixed(1)}`;
}

/** 黒の初手が右上（x が大きく、y が小さい側）に来るように盤を回転・反転する。 */
function orient(game: GeneratedGame, random: () => number): GeneratedGame {
  const n = game.size;
  const first = game.moves.find((m) => m.color === BLACK && m.point !== PASS);
  const transforms = allTransforms(n);
  const center = (n - 1) / 2;
  const valid = transforms.filter((t) => {
    if (!first) return true;
    const p = t(first.point);
    return p % n >= center && Math.floor(p / n) <= center;
  });
  const t = valid[Math.floor(random() * valid.length)] ?? transforms[0];

  const map = (moves: Move[]) => moves.map((m) => ({ color: m.color, point: m.point === PASS ? PASS : t(m.point) }));
  const src = game.position.board;
  const board = new Board(n);
  for (let i = 0; i < n * n; i++) {
    board.cells[t(i)] = src.cells[i];
    board.dead[t(i)] = src.dead[i];
  }
  return {
    ...game,
    moves: map(game.moves),
    dameFills: map(game.dameFills),
    position: { board, trays: game.position.trays },
  };
}

function allTransforms(n: number): ((i: number) => number)[] {
  const result: ((i: number) => number)[] = [];
  for (const swap of [false, true]) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        result.push((i) => {
          let x = i % n;
          let y = Math.floor(i / n);
          if (swap) [x, y] = [y, x];
          if (flipX) x = n - 1 - x;
          if (flipY) y = n - 1 - y;
          return y * n + x;
        });
      }
    }
  }
  return result;
}
