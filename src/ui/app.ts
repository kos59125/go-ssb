import { GameGenerator } from "../ai/client";
import { GeneratedGame } from "../ai/generate";
import { GoGame } from "../ai/go";
import { Position } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE } from "../core/board";
import { dummyPosition } from "../game/dummy";
import { PENALTY_MS, Session } from "../game/session";
import { BoardView } from "./boardView";

interface Settings {
  size: number;
  undoOnPenalty: boolean;
  /** 開始時に棋譜を並べるか（仕様書 §5.1）。 */
  replay: boolean;
}

/** 棋譜の再生にかける時間。 */
const REPLAY_MS = 10_000;

const generator = new GameGenerator();

const SETTINGS_KEY = "go-ssb:settings";
const BEST_KEY = (size: number) => `go-ssb:best:${size}`;

/** スマートフォン相当の画面では 19 路を選べない（仕様書 §6）。 */
const isSmallScreen = () => window.matchMedia("(max-width: 768px)").matches;

export function startApp(root: HTMLElement): void {
  showSettings(root, loadSettings());
}

/** ?seed=123 を付けると、KataGo を使わずに仮の局面で遊ぶ（動作確認用）。 */
function debugSeed(): number | null {
  return Number(new URLSearchParams(location.search).get("seed")) || null;
}

function showSettings(root: HTMLElement, settings: Settings): void {
  const small = isSmallScreen();
  if (small && settings.size === 19) settings.size = 13;
  root.replaceChildren(
    h("main", { class: "settings" }, [
      h("h1", {}, ["囲碁スピード整地バトル"]),
      h("p", { class: "lead" }, ["ひとりで：黒地と白地を両方整地して、タイムを競います。"]),
      h("label", {}, [
        "盤のサイズ",
        h(
          "select",
          { id: "size" },
          [19, 13, 9].map((n) =>
            h("option", { value: String(n), ...(n === settings.size ? { selected: "" } : {}), ...(small && n === 19 ? { disabled: "" } : {}) }, [
              `${n} 路`,
            ]),
          ),
        ),
      ]),
      h("label", {}, [
        "開始時の表示",
        h("select", { id: "start" }, [
          h("option", { value: "final", ...(!settings.replay ? { selected: "" } : {}) }, ["終局図から"]),
          h("option", { value: "replay", ...(settings.replay ? { selected: "" } : {}) }, ["棋譜を並べてから（10 秒）"]),
        ]),
      ]),
      h("label", {}, [
        "ペナルティ時の石",
        h("select", { id: "undo" }, [
          h("option", { value: "undo", ...(settings.undoOnPenalty ? { selected: "" } : {}) }, ["元に戻す"]),
          h("option", { value: "keep", ...(!settings.undoOnPenalty ? { selected: "" } : {}) }, ["そのまま（印を付ける）"]),
        ]),
      ]),
      h("p", { class: "note" }, ["終局図は KataGo の自動対局でその場で作ります。初回はネットワーク（約 4 MB）を読み込みます。"]),
      h("button", { id: "start-button", class: "primary" }, ["スタート"]),
      h("p", { class: "links" }, [h("a", { href: "https://github.com/kos59125/go-ssb/blob/main/docs/rulebook.md", target: "_blank" }, ["ルールブック"])]),
    ]),
  );
  const sizeSelect = root.querySelector<HTMLSelectElement>("#size")!;
  // 設定を選んでいる間に、裏で終局図を作っておく
  if (!debugSeed()) generator.prefetch(settings.size);
  sizeSelect.addEventListener("change", () => {
    if (!debugSeed()) generator.prefetch(Number(sizeSelect.value));
  });
  root.querySelector("#start-button")!.addEventListener("click", () => {
    const next: Settings = {
      size: Number(sizeSelect.value),
      undoOnPenalty: root.querySelector<HTMLSelectElement>("#undo")!.value === "undo",
      replay: root.querySelector<HTMLSelectElement>("#start")!.value === "replay",
    };
    saveSettings(next);
    void prepareGame(root, next);
  });
}

/** 終局図を用意し、設定に応じて棋譜を再生してから対局を始める。 */
async function prepareGame(root: HTMLElement, settings: Settings): Promise<void> {
  const seed = debugSeed();
  if (seed) {
    showGame(root, settings, dummyPosition(settings.size, seed));
    return;
  }

  const status = h("p", { class: "lead" }, ["ネットワークを読み込んでいます…"]);
  const back = h("button", {}, ["やめる"]);
  let cancelled = false;
  back.addEventListener("click", () => {
    cancelled = true;
    showSettings(root, settings);
  });
  root.replaceChildren(h("main", { class: "settings" }, [h("h1", {}, ["終局図を生成中"]), status, back]));

  let game: GeneratedGame;
  try {
    game = await generator.take(settings.size, (move) => (status.textContent = `自動対局中… ${move} 手目`));
  } catch (err) {
    if (cancelled) return;
    status.textContent = `終局図を生成できませんでした（${err instanceof Error ? err.message : err}）。`;
    const fallback = h("button", { class: "primary" }, ["仮の局面で遊ぶ"]);
    fallback.addEventListener("click", () => showGame(root, settings, dummyPosition(settings.size)));
    status.after(fallback);
    return;
  }
  if (cancelled) return;
  if (settings.replay) await replayGame(root, game);
  showGame(root, settings, game.position, game.result);
}

/** 棋譜を REPLAY_MS かけて並べる。 */
function replayGame(root: HTMLElement, game: GeneratedGame): Promise<void> {
  const view = new BoardView(game.size);
  const label = h("div", { class: "phase" }, []);
  const skip = h("button", {}, ["スキップ"]);
  root.replaceChildren(
    h("main", { class: "game" }, [
      h("div", { class: "board-wrap" }, [view.svg]),
      h("aside", { class: "panel" }, [label, h("p", { class: "note" }, [`結果: ${game.result}`]), skip]),
    ]),
  );
  const go = new GoGame(game.size);
  const show = () => view.render(new Board(game.size, go.cells.slice()), new Set(), []);
  return new Promise((resolve) => {
    const interval = REPLAY_MS / Math.max(1, game.moves.length);
    let k = 0;
    const timer = window.setInterval(() => {
      if (k < game.moves.length) {
        const move = game.moves[k++];
        go.play(move.point);
        label.textContent = `棋譜を再生中… ${k} / ${game.moves.length} 手`;
        show();
        return;
      }
      done();
    }, interval);
    const done = () => {
      window.clearInterval(timer);
      resolve();
    };
    skip.addEventListener("click", done);
  });
}

/**
 * ドラッグ中の状態。
 * - press: 盤上で押した。離したときにクリック・範囲選択・ドロップのどれかとして扱う
 * - carry: トレイの「持つ」ボタンから持ち出した
 */
type Drag =
  | { kind: "press"; start: number; current: number; dropping: boolean }
  | { kind: "carry" }
  | null;

function showGame(root: HTMLElement, settings: Settings, position: Position, gameResult?: string): void {
  const session = new Session(position, { undoOnPenalty: settings.undoOnPenalty });
  const view = new BoardView(settings.size);

  const phaseLabel = h("div", { class: "phase" }, []);
  const timer = h("div", { class: "timer" }, []);
  const penaltyLabel = h("div", { class: "penalty" }, []);
  const openLabel = h("div", { class: "note" }, []);
  const message = h("div", { class: "message" }, []);
  // 盤の上に出す目立つ案内（操作できなかった理由など）
  const toast = h("div", { class: "toast" }, []);
  const ghost = h("div", { class: "ghost" }, []);
  const trays = { [BLACK]: trayElement(BLACK), [WHITE]: trayElement(WHITE) };
  const completeButton = h("button", { class: "primary" }, ["完了"]);
  const quitButton = h("button", {}, ["やめる"]);

  root.replaceChildren(
    h("main", { class: "game" }, [
      h("div", { class: "board-wrap" }, [view.svg, toast]),
      h("aside", { class: "panel" }, [
        phaseLabel,
        timer,
        penaltyLabel,
        openLabel,
        trays[WHITE].root,
        trays[BLACK].root,
        message,
        h("div", { class: "buttons" }, [completeButton, quitButton]),
      ]),
    ]),
    ghost,
  );

  let drag: Drag = null;
  let pointer = { x: 0, y: 0 };
  let messageTimer = 0;
  let toastTimer = 0;

  const flash = (text: string) => {
    message.textContent = text;
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => (message.textContent = ""), 3000);
  };

  const notice = (text: string) => {
    toast.textContent = text;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
  };

  /** 死に石取りの間に盤上へ置こうとしたとき: 石を元に戻して理由を伝える。 */
  const rejectBoardPlacement = () => {
    session.cancel();
    notice("死に石取りの間は、盤上で石を動かせません。死に石をアゲハマトレイに移すと整地に進めます。");
  };

  const render = () => {
    const origin = session.hand?.origin;
    view.render(session.board, session.marks, origin?.kind === "board" ? origin.points : []);
    phaseLabel.textContent =
      session.phase === "removal"
        ? `① 死に石取り：死に石をアゲハマトレイへ（残り ${countDeadStones(session)} 個）`
        : "② 整地：アゲハマを埋めて地を整える";
    penaltyLabel.textContent = `ペナルティ ${session.penalties} 回（+${(session.penalties * PENALTY_MS) / 1000} 秒）`;
    openLabel.textContent = session.phase === "arrange" && session.boundaryOpen ? "境界が開いています（閉じた時点で目数を判定します）" : "";
    for (const color of [BLACK, WHITE] as const) {
      trays[color].count.textContent = `${session.position.trays[color]} 個`;
      trays[color].root.classList.toggle("disabled", session.phase === "removal" && !session.hand);
    }
    renderGhost();
  };

  const renderGhost = () => {
    const stones = session.hand?.stones ?? [];
    ghost.style.display = stones.length === 0 ? "none" : "";
    if (stones.length === 0) return;
    ghost.style.transform = `translate(${pointer.x + 12}px, ${pointer.y + 12}px)`;
    ghost.replaceChildren(
      ...stones.slice(0, 5).map((s) => h("span", { class: `ghost-stone ${s.color === BLACK ? "black" : "white"}` }, [])),
      h("span", { class: "ghost-count" }, [stones.length > 1 ? `×${stones.length}` : ""]),
    );
  };

  const penaltyCheck = (before: number) => {
    if (session.penalties > before) flash(`ペナルティ！ +${PENALTY_MS / 1000} 秒`);
  };

  // --- 盤の操作 ---
  const place = (i: number) => {
    if (!session.placeAt(i) && session.phase === "removal") rejectBoardPlacement();
  };

  /** クリック（押した点で離した）。 */
  const click = (i: number) => {
    if (session.hand && session.isOrigin(i)) session.cancel();
    else if (session.board.cells[i] === EMPTY) {
      if (session.hand) place(i);
    } else if (!session.pickUp([i]) && session.hand?.origin.kind === "tray") {
      notice("アゲハマを持っている間は、盤上の石を追加で持てません。");
    }
  };

  view.svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const i = view.pointAt(e.clientX, e.clientY);
    if (i === null) return;
    pointer = { x: e.clientX, y: e.clientY };
    // 石を持って空点から引っ張ったら、離した点に置く（ドロップ）。それ以外は範囲選択
    const dropping = session.hand !== null && session.board.cells[i] === EMPTY;
    drag = { kind: "press", start: i, current: i, dropping };
    e.preventDefault();
  });

  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (drag?.kind === "press") {
      const i = view.pointAt(e.clientX, e.clientY);
      if (i !== null) drag.current = i;
      if (!drag.dropping && drag.current !== drag.start) view.showSelection(drag.start, drag.current);
    }
    renderGhost();
  };

  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const before = session.penalties;
    const tray = trayUnder(e.clientX, e.clientY);
    const i = view.pointAt(e.clientX, e.clientY);
    if (drag.kind === "press" && !drag.dropping && drag.current !== drag.start) {
      // 範囲選択（押した点が空点でも石でもよい）。持っている石に追加する
      view.showSelection(null, null);
      const points = pointsInRect(settings.size, drag.start, drag.current);
      if (!session.pickUp(points) && session.hand?.origin.kind === "tray") {
        notice("アゲハマを持っている間は、盤上の石を追加で持てません。");
      }
    } else if (drag.kind === "press" && i === drag.start) {
      click(i);
    } else if (tray !== null) {
      const origin = session.hand?.origin;
      // トレイの「持つ」ボタンを離しただけなら、持ったままにする
      if (!(origin?.kind === "tray" && origin.owner === tray)) session.dropToTray(tray);
    } else if (i !== null && session.board.cells[i] === EMPTY && session.hand) {
      place(i);
    }
    drag = null;
    penaltyCheck(before);
    render();
  };

  const trayUnder = (x: number, y: number): Color | null => {
    const target = document.elementFromPoint(x, y);
    if (trays[BLACK].root.contains(target)) return BLACK;
    if (trays[WHITE].root.contains(target)) return WHITE;
    return null;
  };

  // --- アゲハマトレイの操作 ---
  for (const color of [BLACK, WHITE] as const) {
    const tray = trays[color];
    tray.root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const before = session.penalties;
      if (session.hand) session.dropToTray(color);
      penaltyCheck(before);
      render();
    });
    for (const [button, n] of tray.takeButtons) {
      button.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (session.phase === "removal") {
          flash("死に石をすべて取り上げると、アゲハマを持てます");
          return;
        }
        const count = n ?? session.position.trays[color];
        for (let k = 0; k < count; k++) if (!session.pickFromTray(color)) break;
        if (session.hand) drag = { kind: "carry" };
        pointer = { x: e.clientX, y: e.clientY };
        render();
      });
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      session.cancel();
      render();
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    if (!session.hand) return;
    e.preventDefault();
    session.cancel();
    render();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("keydown", onKey);
  document.addEventListener("contextmenu", onContextMenu);
  const updateTimer = () => (timer.textContent = formatTime(session.elapsed()));
  const tick = window.setInterval(updateTimer, 100);
  updateTimer();

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("contextmenu", onContextMenu);
    window.clearInterval(tick);
    window.clearTimeout(messageTimer);
    window.clearTimeout(toastTimer);
  };

  quitButton.addEventListener("click", () => {
    cleanup();
    showSettings(root, settings);
  });

  completeButton.addEventListener("click", async () => {
    const answer = await askScores(root);
    if (!answer) return;
    const result = session.complete(answer);
    if (result.ok) {
      cleanup();
      showResult(root, settings, session, gameResult);
    } else {
      flash(`まだ完了していません（+${PENALTY_MS / 1000} 秒）`);
      render();
    }
  });

  render();
}

/** まだトレイに移していない死に石の数（手に持っている分も含む）。 */
function countDeadStones(session: Session): number {
  const onBoard = session.board.dead.reduce((n, d) => n + d, 0);
  return onBoard + (session.hand?.stones.filter((s) => s.dead).length ?? 0);
}

function trayElement(owner: Color) {
  const name = owner === BLACK ? "黒のアゲハマ（白石）" : "白のアゲハマ（黒石）";
  const stoneClass = owner === BLACK ? "white" : "black";
  const count = h("span", { class: "tray-count" }, []);
  const takeButtons: [HTMLButtonElement, number | null][] = [
    [h("button", {}, ["1 個"]), 1],
    [h("button", {}, ["5 個"]), 5],
    [h("button", {}, ["全部"]), null],
  ];
  const root = h("div", { class: "tray" }, [
    h("div", { class: "tray-title" }, [h("span", { class: `tray-stone ${stoneClass}` }, []), name, count]),
    h("div", { class: "tray-buttons" }, ["持つ：", ...takeButtons.map(([b]) => b)]),
  ]);
  return { root, count, takeButtons };
}

/** 完了時の目数入力ダイアログ。キャンセルなら null。 */
function askScores(root: HTMLElement): Promise<Record<Color, number> | null> {
  return new Promise((resolve) => {
    const black = h("input", { type: "number", required: "", step: "1" }, []);
    const white = h("input", { type: "number", required: "", step: "1" }, []);
    const form = h("form", { method: "dialog" }, [
      h("h2", {}, ["目数を入力"]),
      h("label", {}, ["黒地", black, "目"]),
      h("label", {}, ["白地", white, "目"]),
      h("p", { class: "note" }, ["アゲハマが地より多いときはマイナスで入力します。"]),
      h("div", { class: "buttons" }, [
        h("button", { value: "cancel", formnovalidate: "" }, ["戻る"]),
        h("button", { value: "ok", class: "primary" }, ["判定する"]),
      ]),
    ]);
    const dialog = h("dialog", {}, [form]);
    root.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (dialog.returnValue !== "ok") return resolve(null);
      resolve({ [BLACK]: Number(black.value), [WHITE]: Number(white.value) });
    });
    dialog.showModal();
    black.focus();
  });
}

function showResult(root: HTMLElement, settings: Settings, session: Session, result?: string): void {
  const time = session.elapsed();
  const best = loadBest(settings.size);
  const isBest = best === null || time < best;
  if (isBest) saveBest(settings.size, time);
  const again = h("button", { class: "primary" }, ["もう一度"]);
  const back = h("button", {}, ["設定に戻る"]);
  root.replaceChildren(
    h("main", { class: "result" }, [
      h("h1", {}, ["整地完了！"]),
      h("p", { class: "result-time" }, [formatTime(time)]),
      h("p", {}, [`ペナルティ ${session.penalties} 回（+${(session.penalties * PENALTY_MS) / 1000} 秒）`]),
      h("p", {}, [
        `黒 ${session.initialScores[BLACK]} 目・白 ${session.initialScores[WHITE]} 目${result ? `（コミ 6.5 目で ${result}）` : ""}`,
      ]),
      h("p", {}, [isBest ? `${settings.size} 路のベストタイム更新！` : `${settings.size} 路のベスト: ${formatTime(best!)}`]),
      h("div", { class: "buttons" }, [again, back]),
    ]),
  );
  again.addEventListener("click", () => void prepareGame(root, settings));
  back.addEventListener("click", () => showSettings(root, settings));
}

function pointsInRect(size: number, a: number, b: number): number[] {
  const [x1, y1, x2, y2] = [a % size, Math.floor(a / size), b % size, Math.floor(b / size)];
  const points: number[] = [];
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) points.push(y * size + x);
  }
  return points;
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 100);
  const minutes = Math.floor(total / 600);
  const seconds = Math.floor((total % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${total % 10}`;
}

function loadSettings(): Settings {
  const fallback: Settings = { size: 19, undoOnPenalty: true, replay: false };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくてもゲームは続けられる
  }
}

function loadBest(size: number): number | null {
  try {
    const value = localStorage.getItem(BEST_KEY(size));
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function saveBest(size: number, ms: number): void {
  try {
    localStorage.setItem(BEST_KEY(size), String(ms));
  } catch {
    // 保存できなくてもゲームは続けられる
  }
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
