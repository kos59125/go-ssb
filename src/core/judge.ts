import { Analysis, Position, analyze, countDead, emptyTerritory } from "./analysis";
import { Board, Color, opponent } from "./board";
import { DEFAULT_SHAPE_RULES, Section, ShapeRules, classifySection } from "./shapes";

export interface TerritoryCheck {
  complete: boolean;
  sections: { points: number[]; section: Section }[];
  problems: string[];
}

/**
 * ある色の地の整地が完了しているかを判定する（仕様書 §2.1）。
 */
export function checkTerritory(
  position: Position,
  color: Color,
  analysis = analyze(position.board),
  rules: ShapeRules = DEFAULT_SHAPE_RULES,
): TerritoryCheck {
  const { board, trays } = position;
  const problems: string[] = [];
  const sections: TerritoryCheck["sections"] = [];

  if (countDead(board, color) > 0) {
    problems.push("取り上げていない死に石がある");
  }
  if (trays[opponent(color)] > 0 && emptyTerritory(board, color, analysis) > 0) {
    problems.push("埋めていないアゲハマがある");
  }

  let remainders = 0;
  for (const region of analysis.regions) {
    if (!region.territory || region.owner !== color) continue;
    const section = classifySection(board, region.points, color, rules);
    sections.push({ points: region.points, section });
    if (section.kind === "invalid") problems.push(`${section.size} 目の区間: ${section.reason}`);
    if (section.kind === "remainder") remainders++;
  }
  if (remainders > 1) problems.push(`余りの区間が ${remainders} つある`);

  return { complete: problems.length === 0, sections, problems };
}

/**
 * 死に石取りのフェーズが終わったか（仕様書 §3.2）。
 *
 * @param color 自分の色。自分の地の中にある相手の死に石がなくなれば終わり。
 *   省略すると盤上のすべての死に石が対象（ひとりでモード）。
 */
export function isRemovalDone(board: Board, color?: Color, analysis: Analysis = analyze(board)): boolean {
  for (let i = 0; i < board.cells.length; i++) {
    if (board.dead[i] !== 1) continue;
    if (color === undefined) return false;
    const region = analysis.regions[analysis.regionOf[i]];
    if (board.cells[i] === opponent(color) && region.owner === color) return false;
  }
  return true;
}
