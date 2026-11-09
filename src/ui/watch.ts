import { Position } from "../core/analysis";
import { BLACK, Color, WHITE } from "../core/board";
import { randomSeed, mulberry32, seedNumber } from "../core/random";
import { ShapeRules } from "../core/shapes";
import { CPU_LEVELS, Cpu, CpuAction, CpuLevel } from "../game/cpu";
import { SerializedLayout } from "../game/layout";
import { Match, Player } from "../game/match";
import { BoardView } from "./boardView";
import { CpuCursorDriver } from "./cpuDriver";
import { formatTime, h, makeCursor, trayElement } from "./dom";

export interface WatchSettings {
  size: number;
  undoOnPenalty: boolean;
  shapeRules: ShapeRules;
  handLimits: Record<Color, number>;
  /** 黒・白それぞれの CPU の強さ。 */
  watchLevels: Record<Color, CpuLevel>;
}

const colorName = (c: Color) => (c === BLACK ? "黒" : "白");

/**
 * 観戦モード（CPU vs CPU）。2 つの CPU が同じ盤で、それぞれ相手の地を整地する（仕様書 §3.1.2）。
 * 勝敗の決め方は vs CPU と同じ（ペナルティ込みのタイムが短い方の勝ち）。
 *
 * @param onAgain 「もう一度」（新しい終局図で観戦する）
 * @param onBack 「設定に戻る」
 */
export function showWatch(
  root: HTMLElement,
  settings: WatchSettings,
  position: Position,
  layouts: Partial<Record<Color, SerializedLayout | null>>,
  onAgain: () => void,
  onBack: () => void,
): void {
  const match = new Match(position, { undoOnPenalty: settings.undoOnPenalty, shapeRules: settings.shapeRules });
  const label = (c: Color) => `${colorName(c)} CPU（${CPU_LEVELS[settings.watchLevels[c]].label}）`;
  const sides = [BLACK, WHITE] as const;
  const players = {} as Record<Color, Player>;
  const cpus = {} as Record<Color, Cpu>;
  for (const c of sides) {
    players[c] = new Player(match, { color: c, handLimit: settings.handLimits[c] });
    // ミスや無駄な操作の乱数は、終局図のシードとは別に毎回ランダムに決める
    cpus[c] = new Cpu(players[c], layouts, { level: settings.watchLevels[c], random: mulberry32(seedNumber(randomSeed())) });
  }

  const view = new BoardView(settings.size);
  const trays = { [BLACK]: trayElement(BLACK, `${colorName(BLACK)} CPU`), [WHITE]: trayElement(WHITE, `${colorName(WHITE)} CPU`) };
  for (const c of sides) trays[c].root.classList.add("readonly");
  const cursors = { [BLACK]: makeCursor(`${colorName(BLACK)} CPU`), [WHITE]: makeCursor(`${colorName(WHITE)} CPU`) };
  cursors[BLACK].classList.add("side-black");
  cursors[WHITE].classList.add("side-white");

  const phaseLabel = h("div", { class: "phase" }, [`観戦：${label(BLACK)} vs ${label(WHITE)}`]);
  const timer = h("div", { class: "timer" }, []);
  const statusLines = { [BLACK]: h("div", { class: "cpu-status side-black" }, []), [WHITE]: h("div", { class: "cpu-status side-white" }, []) };
  const resultBox = h("div", { class: "result-box" }, []);
  resultBox.hidden = true;
  const quit = h("button", { type: "button" }, ["やめる"]);
  const countdownNumber = h("span", { class: "countdown-number" }, []);
  const countdown = h("div", { class: "countdown" }, [
    h("div", { class: "countdown-spinner" }, [h("div", { class: "countdown-ring" }, []), countdownNumber]),
  ]);

  root.replaceChildren(
    h("main", { class: "game watch" }, [
      h("div", { class: "board-wrap" }, [view.svg, countdown]),
      h("aside", { class: "panel" }, [
        h("div", { class: "status" }, [phaseLabel, timer, statusLines[BLACK], statusLines[WHITE]]),
        h("div", { class: "trays" }, [trays[WHITE].root, trays[BLACK].root]),
        resultBox,
        h("div", { class: "buttons watch-buttons" }, [quit]),
      ]),
    ]),
    cursors[BLACK],
    cursors[WHITE],
  );

  const timers: number[] = [];
  const drivers: CpuCursorDriver[] = [];
  const leave = () => {
    for (const t of timers) window.clearInterval(t);
    for (const d of drivers) d.dispose();
  };
  quit.addEventListener("click", () => {
    leave();
    onBack();
  });

  const stateText = (c: Color) => {
    const p = players[c];
    const penalty = p.penalties > 0 ? `（ペナルティ ${p.penalties} 回）` : "";
    if (p.phase === "finished") return `${label(c)}: 完了 ${formatTime(p.elapsed())}${penalty}`;
    if (p.phase === "removal") return `${label(c)}: 死に石取り中${penalty}`;
    return `${label(c)}: ${colorName(c === BLACK ? WHITE : BLACK)}地を整地中${penalty}`;
  };
  const bothFinished = () => sides.every((c) => players[c].phase === "finished");
  /** 経過時間。両方が完了したら、後に完了した時点で止める。 */
  const clock = () => {
    if (!match.started) return 0;
    const end = bothFinished() ? Math.max(...sides.map((c) => players[c].finishedAt!)) : match.now();
    return end - match.startedAt!;
  };
  const render = () => {
    view.render(match.board, match.marks, [], new Set());
    for (const c of sides) {
      trays[c].view.render(match.position.trays[c]);
      statusLines[c].textContent = stateText(c);
    }
    timer.textContent = formatTime(clock());
  };

  /** 操作の場所の画面座標（盤の点、トレイ。場所がなければ盤の中央）。 */
  const locate = (action: CpuAction | null) => {
    const point =
      action?.kind === "swipe" || action?.kind === "sequence" ? action.points[0] : action && "point" in action ? action.point : null;
    if (point !== null) {
      const box = view.svg.getBoundingClientRect();
      const { x, y } = view.pointBox(point);
      return { x: box.left + x, y: box.top + y };
    }
    if (action?.kind === "pick-tray" || action?.kind === "drop-tray") {
      const box = trays[action.owner].view.svg.getBoundingClientRect();
      return { x: box.left + 20, y: box.top + 15 };
    }
    if (action) return null;
    const box = view.svg.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };

  // 勝敗: 両方が完了したとき、または先に完了した側のタイムを、もう一方の経過時間が超えた時点
  let decided = false;
  const decide = () => {
    if (decided) return;
    const [b, w] = [players[BLACK], players[WHITE]];
    const tb = b.phase === "finished" ? b.elapsed() : null;
    const tw = w.phase === "finished" ? w.elapsed() : null;
    let winner: Color | null = null;
    if (tb !== null && tw !== null) winner = tb <= tw ? BLACK : WHITE;
    else if (tb !== null && w.elapsed() > tb) winner = BLACK;
    else if (tw !== null && b.elapsed() > tw) winner = WHITE;
    if (winner === null) return;
    decided = true;
    phaseLabel.textContent = `${label(winner)}の勝ち！`;
    const again = h("button", { class: "primary", type: "button" }, ["もう一度"]);
    const back = h("button", { type: "button" }, ["設定に戻る"]);
    again.addEventListener("click", () => {
      leave();
      onAgain();
    });
    back.addEventListener("click", () => {
      leave();
      onBack();
    });
    resultBox.replaceChildren(
      h("p", {}, [`黒 ${match.initialScores[BLACK]} 目・白 ${match.initialScores[WHITE]} 目`]),
      ...sides.map((c) => h("p", {}, [stateText(c)])),
      h("div", { class: "buttons" }, [again, back]),
    );
    resultBox.hidden = false;
    quit.hidden = true;
  };

  render();
  for (const c of sides) {
    const driver = new CpuCursorDriver(cursors[c], cpus[c], locate, render);
    drivers.push(driver);
    driver.moveTo(null);
  }

  // カウントダウン: 3, 2, 1 の後に「スタート！」で開始
  let count = 3;
  const showCount = () => {
    countdownNumber.textContent = String(count);
    countdownNumber.classList.remove("pop");
    void countdownNumber.offsetWidth;
    countdownNumber.classList.add("pop");
  };
  showCount();
  const countdownTimer = window.setInterval(() => {
    count--;
    if (count > 0) {
      showCount();
      return;
    }
    window.clearInterval(countdownTimer);
    countdown.classList.add("go");
    countdownNumber.textContent = "スタート！";
    window.setTimeout(() => countdown.remove(), 700);
    match.begin();
    for (const c of sides) startCpu(c, drivers[c === BLACK ? 0 : 1]);
  }, 1000);
  timers.push(countdownTimer);
  const tick = window.setInterval(() => {
    render();
    if (match.started) decide();
    // 両方とも完了したら、表示を止める（タイマーも止まる）
    if (bothFinished()) window.clearInterval(tick);
  }, 100);
  timers.push(tick);

  function startCpu(c: Color, driver: CpuCursorDriver) {
    let busy = false;
    const t = window.setInterval(() => {
      // 勝敗が決まっても、盤を仕上げるために完了まで続ける
      if (busy || players[c].phase === "finished") return;
      busy = true;
      driver.turn(() => {
        busy = false;
        render();
        decide();
      });
    }, CPU_LEVELS[settings.watchLevels[c]].interval);
    timers.push(t);
  }
}
