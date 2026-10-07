import { BLACK, Color, WHITE } from "../core/board";
import { Move, PASS } from "./go";

/** SGF から読み取った対局。 */
export interface GameRecord {
  size: number;
  komi: number;
  /** 置き石などの初期配置（AB / AW）。 */
  setup: Move[];
  /** 本譜の手順（最初の分岐だけをたどる）。 */
  moves: Move[];
  /** 結果（RE）。例: "B+3.5"、"W+R"。 */
  result?: string;
  black?: string;
  white?: string;
}

/**
 * SGF（FF[4]）を読む。最初のゲームの本譜だけを読み、分岐は最初のものをたどる。
 * 盤のサイズは 2〜19 路。
 */
export function parseSgf(text: string): GameRecord {
  const nodes = mainLine(text);
  if (nodes.length === 0) throw new Error("SGF に局面がありません");
  const root = nodes[0];
  const size = Number(root.SZ?.[0] ?? 19);
  if (!Number.isInteger(size) || size < 2 || size > 19) throw new Error(`対応していない盤のサイズです: ${root.SZ?.[0]}`);
  const komi = Number(root.KM?.[0] ?? 6.5);

  const point = (value: string): number => {
    if (value === "" || (value === "tt" && size <= 19)) return PASS;
    const x = value.charCodeAt(0) - 97;
    const y = value.charCodeAt(1) - 97;
    if (!(x >= 0 && y >= 0 && x < size && y < size)) throw new Error(`座標が盤の外です: ${value}`);
    return y * size + x;
  };
  /** AB[aa:cc] のような矩形の省略記法を展開する。 */
  const points = (values: string[]): number[] =>
    values.flatMap((v) => {
      const [a, b] = v.split(":");
      if (b === undefined) return [point(a)];
      const [p, q] = [point(a), point(b)];
      const result: number[] = [];
      for (let y = Math.min(Math.floor(p / size), Math.floor(q / size)); y <= Math.max(Math.floor(p / size), Math.floor(q / size)); y++) {
        for (let x = Math.min(p % size, q % size); x <= Math.max(p % size, q % size); x++) result.push(y * size + x);
      }
      return result;
    });

  const setup: Move[] = [];
  const moves: Move[] = [];
  for (const node of nodes) {
    for (const [prop, color] of [["AB", BLACK], ["AW", WHITE]] as [string, Color][]) {
      for (const p of points(node[prop] ?? [])) {
        if (moves.length > 0) throw new Error("手順の途中の石の配置（AB / AW）には対応していません");
        setup.push({ color, point: p });
      }
    }
    if (node.B) moves.push({ color: BLACK, point: point(node.B[0]) });
    if (node.W) moves.push({ color: WHITE, point: point(node.W[0]) });
  }
  return { size, komi, setup, moves, result: root.RE?.[0], black: root.PB?.[0], white: root.PW?.[0] };
}

type Node = Record<string, string[]>;
interface Tree {
  nodes: Node[];
  children: Tree[];
}

/** 最初のゲームの本譜（各分岐で最初の子をたどったノード列）。 */
function mainLine(text: string): Node[] {
  const start = text.indexOf("(");
  if (start < 0) throw new Error("SGF ではありません");
  const { tree } = parseTree(text, start);
  const nodes: Node[] = [];
  for (let t: Tree | undefined = tree; t; t = t.children[0]) nodes.push(...t.nodes);
  return nodes;
}

/** text[start] の "(" から始まるゲーム木を読む。 */
function parseTree(text: string, start: number): { tree: Tree; end: number } {
  const tree: Tree = { nodes: [], children: [] };
  let current: Node | null = null;
  let prop = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "[") {
      const end = closingBracket(text, i);
      if (current && prop) (current[prop] ??= []).push(unescape(text.slice(i + 1, end)));
      i = end + 1;
    } else if (ch === "(") {
      const child = parseTree(text, i);
      tree.children.push(child.tree);
      i = child.end + 1;
    } else if (ch === ")") {
      return { tree, end: i };
    } else if (ch === ";") {
      current = {};
      tree.nodes.push(current);
      prop = "";
      i++;
    } else if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z]/.test(text[j])) j++;
      // 古い SGF の小文字混じりの名前（例: AddBlack → AB）にも対応する
      prop = text.slice(i, j).replace(/[a-z]/g, "");
      i = j;
    } else {
      i++;
    }
  }
  throw new Error("SGF の括弧が閉じていません");
}

function closingBracket(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "]") return i;
  }
  throw new Error("SGF の値が閉じていません");
}

function unescape(value: string): string {
  return value.replace(/\\\r?\n/g, "").replace(/\\(.)/g, "$1");
}
