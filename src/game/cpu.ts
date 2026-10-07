import { analyze } from "../core/analysis";
import { Color, EMPTY, opponent } from "../core/board";
import { checkTerritory } from "../core/judge";
import { Layout, SerializedLayout, planLayout } from "./layout";
import { Player } from "./match";

/** CPU の 1 回の操作（カーソルの表示に使う）。 */
export type CpuAction =
  | { kind: "idle" }
  | { kind: "capture"; point: number }
  | { kind: "pick"; point: number }
  | { kind: "pick-tray" }
  | { kind: "place"; point: number }
  | { kind: "complete" };

/** CPU の強さ: 1 回の操作の間隔（ミリ秒）。仕様書 §3 */
export const CPU_INTERVAL = { easy: 1200, normal: 750, hard: 400 } as const;
export type CpuLevel = keyof typeof CPU_INTERVAL;

/**
 * vs CPU の CPU（仕様書 §3）。step() を一定間隔で呼ぶと、1 回ずつ操作する。
 *
 * - 死に石取り: 自分の地の中にある相手の死に石を 1 個ずつ取る。
 * - 整地: 担当の地（相手の地）を、計画した形（planLayout）に向けて石を 1 個ずつ動かす。
 *   境界の石は動かさないので、境界を開いたり目数を変えたりはしない。
 * - 担当の地に死に石が残っている間（相手が取り上げる前）は待つ。
 * - 形が整い、境界が閉じていて目数も正しければ完了する。
 */
export class Cpu {
  readonly player: Player;
  private layout: Layout | null;

  constructor(player: Player, layout: SerializedLayout | null) {
    this.player = player;
    this.layout = layout ? { area: new Set(layout.area), empties: new Set(layout.empties) } : null;
  }

  /** 整地する地の色。 */
  get assigned(): Color {
    return opponent(this.player.color!);
  }

  step(): CpuAction {
    const p = this.player;
    if (p.phase === "finished" || !p.started) return { kind: "idle" };
    if (p.hand) return this.placeHeld();
    if (p.phase === "removal") return this.removeDead();
    return this.arrange();
  }

  /** 自分の地の中にある相手の死に石を 1 個取る。 */
  private removeDead(): CpuAction {
    const p = this.player;
    const { regions, regionOf } = analyze(p.board);
    for (let i = 0; i < p.board.cells.length; i++) {
      if (p.board.dead[i] !== 1 || p.board.cells[i] !== this.assigned) continue;
      if (regions[regionOf[i]].owner !== p.color) continue;
      if (p.capture(i)) return { kind: "capture", point: i };
    }
    p.updatePhase();
    return { kind: "idle" };
  }

  private arrange(): CpuAction {
    const p = this.player;
    const color = this.assigned;
    const board = p.board;
    // 担当の地に、相手が取り上げる死に石が残っている間は待つ
    const { regions, regionOf } = analyze(board);
    for (let i = 0; i < board.cells.length; i++) {
      if (board.dead[i] === 1 && regions[regionOf[i]].owner === color) return { kind: "idle" };
    }

    const plan = this.validPlan();
    if (!plan) return { kind: "idle" };
    const { sinks, sources } = this.diff(plan);
    if (sinks.length > 0) {
      const sink = sinks[0];
      if (sources.length > 0) {
        const source = nearest(sources, sink, board.size);
        if (p.pickUp([source])) return { kind: "pick", point: source };
      } else if (p.pickFromTray(p.color!, 1)) {
        return { kind: "pick-tray" };
      }
      this.layout = null; // 石が足りない: 計画を立て直す
      return { kind: "idle" };
    }
    if (sources.length > 0) {
      this.layout = null;
      return { kind: "idle" };
    }

    // 形が整った: 境界が閉じていて目数も正しければ完了する
    const check = checkTerritory(p.position, color);
    const scores = p.scores();
    if (check.complete && !p.boundaryOpen && scores[color] === p.initialScores[color]) {
      const result = p.complete({ [color]: p.initialScores[color] });
      if (result.ok) return { kind: "complete" };
    }
    return { kind: "idle" };
  }

  /** 持っている石を、次に埋める点に置く。埋める点がなければ元に戻す。 */
  private placeHeld(): CpuAction {
    const p = this.player;
    const plan = this.validPlan();
    const sinks = plan ? this.diff(plan).sinks : [];
    if (sinks.length > 0 && p.placeAt(sinks[0], this.assigned)) return { kind: "place", point: sinks[0] };
    p.cancel();
    return { kind: "idle" };
  }

  /** 計画が今の盤で使えるか確かめ、使えなければ立て直す。 */
  private validPlan(): Layout | null {
    const board = this.player.board;
    const color = this.assigned;
    const usable = (layout: Layout) =>
      [...layout.area].every((i) => board.cells[i] === EMPTY || (board.cells[i] === color && board.isLiveStone(i)));
    if (this.layout && usable(this.layout)) return this.layout;
    const held = this.player.hand?.stones.filter((s) => s.color === color).length ?? 0;
    this.layout = planLayout(board, color, this.player.position.trays[this.player.color!] + held, 20_000);
    return this.layout;
  }

  /** 計画と比べて、石を置く点（sinks）と石を取る点（sources）。 */
  private diff(plan: Layout): { sinks: number[]; sources: number[] } {
    const board = this.player.board;
    const sinks: number[] = [];
    const sources: number[] = [];
    for (const i of [...plan.area].sort((a, b) => a - b)) {
      const empty = board.cells[i] === EMPTY;
      if (plan.empties.has(i) && !empty) sources.push(i);
      if (!plan.empties.has(i) && empty) sinks.push(i);
    }
    return { sinks, sources };
  }
}

function nearest(points: number[], to: number, size: number): number {
  const dist = (a: number) => Math.abs((a % size) - (to % size)) + Math.abs(Math.floor(a / size) - Math.floor(to / size));
  return points.reduce((best, q) => (dist(q) < dist(best) ? q : best));
}
