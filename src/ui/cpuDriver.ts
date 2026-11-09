import { BLACK, WHITE } from "../core/board";
import { Cpu, CpuAction } from "../game/cpu";

/** CPU のカーソルが操作する場所へ動く時間（CSS の .cpu-cursor の transition と合わせる）。 */
export const CURSOR_TRAVEL_MS = 250;
/** なぞって置くとき、1 点ずつ進む間隔（CSS の .cpu-cursor.swiping の transition と合わせる）。 */
const SWIPE_STEP_MS = 90;

/**
 * CPU のカーソルを動かしながら操作させる。先にカーソルを操作する場所へ動かし、
 * 着いてから盤やトレイの石を動かす（石がカーソルより先に動いて見えないように）。
 */
export class CpuCursorDriver {
  private readonly timers = new Set<number>();
  /** カーソルのいる盤の点（動画の記録用）。トレイなど盤の外なら null。 */
  point: number | null = null;

  /**
   * @param locate 操作の場所の画面座標（盤の点やトレイ）。null なら動かさない
   * @param onStep なぞって置く途中で 1 点置くたびに呼ぶ（画面の描き直し用）
   * @param home カーソルの最初の位置（例: CPU のアゲハマのトレイ）。なければ locate(null)（盤の中央など）
   */
  constructor(
    readonly cursor: HTMLElement,
    readonly cpu: Cpu,
    private readonly locate: (action: CpuAction | null) => { x: number; y: number } | null,
    private readonly onStep: () => void = () => {},
    private readonly home?: () => { x: number; y: number } | null,
  ) {}

  /** カーソルを action の場所へ動かす（null なら、まだ置いていなければ盤の中央）。 */
  moveTo(action: CpuAction | null): void {
    if (action) {
      this.point =
        action.kind === "swipe" || action.kind === "sequence" ? action.points[0] : "point" in action ? action.point : null;
    }
    // action が null のときは、まだどこにも置いていなければ最初の位置（home、なければ locate が決める）
    const target = action ? this.locate(action) : !this.cursor.style.transform ? (this.home?.() ?? this.locate(null)) : null;
    if (target) this.cursor.style.transform = `translate(${target.x}px, ${target.y}px)`;
    this.showHeld();
  }

  /** カーソルに、CPU が持っている石を表示する。 */
  showHeld(): void {
    const held = this.cpu.player.hand?.stones[0];
    this.cursor.classList.toggle("holding-black", held?.color === BLACK);
    this.cursor.classList.toggle("holding-white", held?.color === WHITE);
  }

  /** 1 回の操作。終わったら after を呼ぶ。 */
  turn(after: (action: CpuAction) => void): void {
    const plan = this.cpu.decide();
    this.moveTo(plan.action);
    if (plan.action.kind === "idle") {
      plan.run?.();
      this.showHeld();
      after(plan.action);
      return;
    }
    if (plan.steps && plan.steps.length > 0) {
      // 続けて操作する（なぞって置く・続けてクリックする）: 最初の点に着いたらそこで操作し、
      // 次の点へはその間隔をかけてカーソルを動かし、着いた時点で操作する
      const steps = plan.steps;
      this.later(CURSOR_TRAVEL_MS, () => {
        this.cursor.classList.add("swiping");
        let at = 0;
        steps.forEach((step, k) => {
          const gap = k === 0 ? 0 : (step.delay ?? SWIPE_STEP_MS);
          const start = at;
          at += gap;
          if (k > 0) {
            this.later(start, () => {
              this.cursor.style.transitionDuration = `${gap}ms`;
              this.moveTo({ kind: "place", point: step.point });
            });
          }
          this.later(at, () => {
            step.run();
            this.showHeld();
            this.onStep();
            if (k === steps.length - 1) {
              this.cursor.classList.remove("swiping");
              this.cursor.style.transitionDuration = "";
              after(plan.action);
            }
          });
        });
      });
      return;
    }
    this.later(CURSOR_TRAVEL_MS, () => {
      plan.run?.();
      this.showHeld();
      after(plan.action);
    });
  }

  /** 予約した操作をすべて取り消す（画面を離れるとき）。 */
  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }

  private later(ms: number, fn: () => void): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
}
