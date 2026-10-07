import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { Evaluation, Evaluator } from "./model";
import { GoGame, Move, PASS } from "./go";
import type { GameRecord } from "./sgf";

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
  /** 置き石などの初期配置（SGF の AB / AW）。 */
  setup: Move[];
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
  /** 対局を作り直すときに理由とともに呼ばれる（調査用）。 */
  onReject?: (reason: string) => void;
}

export class GenerationCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * 実戦の終局済みの棋譜（SGF）から整地用の局面を作る。死に石は KataGo の所有権で判定し、
 * 残ったダメは埋める。作り直しはできないので、判定に引っかかってもそのまま使う。
 */
export async function finishRecord(evaluate: Evaluator, record: GameRecord): Promise<GeneratedGame> {
  const game = new GoGame(record.size);
  for (const { point, color } of record.setup) if (point !== PASS) game.cells[point] = color;
  for (const [k, move] of record.moves.entries()) {
    game.toPlay = move.color;
    if (!game.isLegal(move.point)) throw new Error(`${k + 1} 手目が打てない手です`);
    game.play(move.point);
  }
  const finished = await finish(evaluate, game, { random: Math.random, record });
  return { ...finished!, result: record.result ?? finished!.result };
}

/**
 * KataGo の方策ネットワークで自動対局し、整地用の終局図を作る（仕様書 §5）。
 * 条件を満たさない対局は作り直す。
 */
export async function generateGame(evaluate: Evaluator, options: GenerateOptions): Promise<GeneratedGame> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const game = await selfPlay(evaluate, options);
    if (!game) continue;
    const finished = await finish(evaluate, game, { random: options.random ?? Math.random, reject: options.onReject });
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

  const step = async (area: boolean) => {
    if (options.shouldStop?.()) throw new GenerationCancelled();
    const ev = await evaluate(game, { area });
    game.play(area ? chooseCleanupMove(game, ev, random) : await chooseMove(game, ev, random, targetMargin, evaluate));
    options.onMove?.(game.moves.length);
  };

  // 本局（日本ルール）。連続 2 回のパスまで
  while (!game.isOver()) {
    if (game.moves.length >= maxMoves) return options.onReject?.("too long"), null;
    await step(false);
  }

  // 後始末: 日本ルールではダメや手入れの価値が 0 なので、KataGo は打たずにパスする。
  // 石と地で数えるルールで続けて、ダメ埋めと手入れ（当たりの解消など）を KataGo に打たせる
  const cleanupLimit = game.moves.length + Math.round(size * size * 0.4);
  let passes = 0;
  while (passes < 2) {
    if (game.moves.length >= cleanupLimit) return options.onReject?.("cleanup too long"), null;
    await step(true);
    passes = game.lastWasPass() ? passes + 1 : 0;
  }
  return game;
}

/**
 * 本局の手を選ぶ。普段は方策からサンプリングする。
 * 目数差が開いたら、方策の上位候補を 1 手先まで評価して、差が縮まる手を選ぶ。
 */
async function chooseMove(
  game: GoGame,
  ev: Evaluation,
  random: () => number,
  targetMargin: number,
  evaluate: Evaluator,
): Promise<number> {
  const area = game.size * game.size;
  const moveNumber = game.moves.length;
  const sign = game.toPlay === BLACK ? 1 : -1;
  const lead = sign * ev.blackLead;

  if (bestIsPass(ev, area)) return PASS;
  // 自分の確定地の中に打つ手（地を減らすだけの手）は、方策がよほど推さない限り打たない
  const allowed = (i: number) => sign * ev.ownership[i] < 0.9 || ev.policy[i] > 0.3;

  if (Math.abs(lead) <= targetMargin * 0.75) {
    // 序盤はばらつきを持たせ、中盤以降は堅実に打つ
    const opening = moveNumber < area * 0.1;
    return sample(game, ev, random, opening ? 1.0 : 0.5, opening ? 0.95 : 0.8, allowed);
  }

  const candidates = topMoves(game, ev, allowed, 4);
  if (candidates.length === 0) return PASS;
  let best = candidates[0];
  let bestCost = Infinity;
  for (const point of candidates) {
    const next = game.clone();
    next.play(point);
    const after = sign * (await evaluate(next)).blackLead;
    // 負けている側は形勢が最も良くなる手、勝っている側はリードが目標の半分に近づく手
    const cost = lead < 0 ? -after : Math.abs(after - targetMargin * 0.5);
    if (cost < bestCost) {
      bestCost = cost;
      best = point;
    }
  }
  return best;
}

/** 合法で allowed を満たす手のうち、方策の高い順に n 手。 */
function topMoves(game: GoGame, ev: Evaluation, allowed: (i: number) => boolean, n: number): number[] {
  const area = game.size * game.size;
  const points: number[] = [];
  for (let i = 0; i < area; i++) {
    if (ev.policy[i] > 0 && allowed(i) && game.isLegal(i) && !game.isOwnEye(i)) points.push(i);
  }
  return points.sort((a, b) => ev.policy[b] - ev.policy[a]).slice(0, n);
}

/**
 * 後始末の手を選ぶ（石と地で数えるルールで評価した方策を使う）。
 * そのルールでは自分の地に打っても損がないので、打てる場所を次に限る。
 * - どちらの地とも言えない点（ダメなど）
 * - 呼吸点が 2 以下の連に接する点（手入れ・当たりの解消）。ただし相手の地の中は除く
 * 候補の方策が低ければパスする。
 */
function chooseCleanupMove(game: GoGame, ev: Evaluation, random: () => number): number {
  const sign = game.toPlay === BLACK ? 1 : -1;
  const libs = game.libertyCounts();
  const weak = (i: number) => game.neighbors(i).some((j) => game.cells[j] !== EMPTY && libs[j] <= 2);
  const allowed = (i: number) => {
    const own = sign * ev.ownership[i];
    if (Math.abs(own) < 0.6) return true;
    return own > 0 && weak(i);
  };
  const move = sample(game, ev, random, 0.25, 0.5, allowed);
  return move === PASS || ev.policy[move] < 0.05 ? PASS : move;
}

function bestIsPass(ev: Evaluation, area: number): boolean {
  let best = 0;
  for (let i = 1; i < area; i++) if (ev.policy[i] > ev.policy[best]) best = i;
  return ev.policy[area] >= ev.policy[best];
}

/** 合法で allowed を満たす手から、top-p で候補を絞り、温度をかけてサンプリングする。 */
function sample(
  game: GoGame,
  ev: Evaluation,
  random: () => number,
  temperature: number,
  topP: number,
  allowed: (i: number) => boolean,
): number {
  const area = game.size * game.size;
  const candidates: { point: number; weight: number }[] = [];
  for (let i = 0; i < area; i++) {
    if (ev.policy[i] <= 0 || !allowed(i) || !game.isLegal(i) || game.isOwnEye(i)) continue;
    candidates.push({ point: i, weight: ev.policy[i] });
  }
  if (candidates.length === 0) return PASS;
  candidates.sort((a, b) => b.weight - a.weight);

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
interface FinishOptions {
  random: () => number;
  reject?: (reason: string) => void;
  /** 実戦の棋譜（SGF）用: 作り直しの判定をせず、盤の向きも変えない。 */
  record?: { setup: Move[]; komi: number };
}

async function finish(evaluate: Evaluator, game: GoGame, options: FinishOptions): Promise<GeneratedGame | null> {
  const { random, record } = options;
  // 実戦の棋譜は作り直せないので、判定に引っかかっても使う
  const reject = (reason: string) => {
    options.reject?.(reason);
    return record === undefined;
  };
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
  const { fills: dameFills, unresolved } = fillDame(game, board, own);
  // 埋めきれなかった中立の空点がセキにしては多い
  if (unresolved > 4 && reject("dame")) return null;

  // 地の判定が KataGo の所有権と食い違う対局は使わない
  const analysis = analyze(board);
  for (const region of analysis.regions) {
    if (!region.territory || region.owner === null) continue;
    const sign = region.owner === BLACK ? 1 : -1;
    const avg = region.points.reduce((s, j) => s + own[j], 0) / region.points.length;
    if (avg * sign < 0.5 && reject("territory")) return null;
  }

  // 当たりのまま残っている生きた石があれば使わない（後始末が終わっていない）
  if (hasLiveStoneInAtari(game, board) && reject("atari")) return null;

  const position: Position = { board, trays: { [BLACK]: game.captures[BLACK], [WHITE]: game.captures[WHITE] } };
  // こちらで数えた結果が KataGo の形勢判断と大きく食い違う対局は、死活の判定を誤っているとみなす
  const diff = japaneseScore(position);
  if (
    Math.abs(diff - ev.blackLead) > Math.max(3, Math.abs(ev.blackLead) * 0.15) &&
    reject(`score (ours ${diff}, KataGo ${ev.blackLead.toFixed(1)})`)
  ) {
    return null;
  }
  const result = diff > 0 ? `B+${diff.toFixed(1)}` : `W+${(-diff).toFixed(1)}`;
  const finished = { size, komi: KOMI, moves: game.moves.slice(), position, dameFills, setup: [], result };
  if (record) return { ...finished, komi: record.komi, setup: record.setup };
  return orient(finished, random);
}

/**
 * ダメ（両方の色に接する空点）を埋める。所有権の符号の色を優先し、
 * 石を取られたり取ったりしない方の色で埋める。埋められない空点はセキとして残す。
 */
function fillDame(game: GoGame, board: Board, own: Float32Array): { fills: Move[]; unresolved: number } {
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

  const analysis = analyze(board);
  const unresolved = analysis.regions
    .filter((r) => r.owner === null)
    .reduce((n, r) => n + r.points.filter((i) => board.cells[i] === EMPTY).length, 0);
  return { fills, unresolved };
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

/** 生きた石だけを見て、呼吸点が 1 つしかない連があるか。 */
function hasLiveStoneInAtari(game: GoGame, board: Board): boolean {
  const cells = new Uint8Array(board.cells.length);
  for (let k = 0; k < cells.length; k++) cells[k] = board.isLiveStone(k) ? board.cells[k] : EMPTY;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY && game.chain(i, cells).liberties.size < 2) return true;
  }
  return false;
}

/** 日本ルールでの黒の勝ち目数（コミ込み）。目数 = 地 − 埋められる自分の色の石（§1）。 */
function japaneseScore(position: Position): number {
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
  return black - white;
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
