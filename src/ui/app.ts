import { GameGenerator } from "../ai/client";
import { GeneratedGame } from "../ai/generate";
import { GoGame } from "../ai/go";
import { Position } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { randomSeed, seedNumber } from "../core/random";
import { dummyPosition } from "../game/dummy";
import { PENALTY_MS, Session } from "../game/session";
import { BoardView } from "./boardView";
import { TrayView } from "./trayView";

interface Settings {
  size: number;
  undoOnPenalty: boolean;
  /** 開始時に初手から棋譜を並べるか（仕様書 §5.1）。 */
  replay: boolean;
  /** 終局図を作るシード。保存せず、画面を開くたびにランダムに決める。 */
  seed: string;
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

/** ?dummy=123 を付けると、KataGo を使わずに仮の局面で遊ぶ（動作確認用）。 */
function dummySeed(): number | null {
  return Number(new URLSearchParams(location.search).get("dummy")) || null;
}

function showSettings(root: HTMLElement, settings: Settings): void {
  const small = isSmallScreen();
  if (small && settings.size === 19) settings.size = 13;
  root.replaceChildren(
    h("main", { class: "settings" }, [
      h("h1", {}, ["囲碁スピード整地バトル"]),
      h("p", { class: "lead" }, ["ひとりで：黒地と白地を両方整地して、タイムを競います。"]),
      radioGroup("盤のサイズ", "size", [
        { value: "19", label: "19 路", checked: settings.size === 19, disabled: small },
        { value: "13", label: "13 路", checked: settings.size === 13 },
        { value: "9", label: "9 路", checked: settings.size === 9 },
      ]),
      radioGroup("開始時の表示", "start", [
        { value: "final", label: "終局図から", checked: !settings.replay },
        { value: "replay", label: "初手から並べる", checked: settings.replay },
      ]),
      radioGroup("ペナルティ時の石", "undo", [
        { value: "undo", label: "元に戻す", checked: settings.undoOnPenalty },
        { value: "keep", label: "そのまま（印を付ける）", checked: !settings.undoOnPenalty },
      ]),
      h("fieldset", { class: "radio-group seed-group" }, [
        h("legend", {}, ["シード"]),
        h("input", { type: "text", id: "seed", value: settings.seed, spellcheck: "false", autocomplete: "off" }, []),
        h("button", { type: "button", id: "reseed" }, ["別のシード"]),
      ]),
      h("p", { class: "note" }, [
        "終局図は KataGo の自動対局でその場で作ります。同じ盤サイズとシードなら同じ終局図になります。初回はネットワーク（約 4 MB）を読み込みます。",
      ]),
      h("button", { id: "start-button", class: "primary" }, ["スタート"]),
      h("p", { class: "links" }, [h("a", { href: "https://github.com/kos59125/go-ssb/blob/main/docs/rulebook.md", target: "_blank" }, ["ルールブック"])]),
    ]),
  );
  const selected = (name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
  const seedInput = root.querySelector<HTMLInputElement>("#seed")!;
  // 設定を選んでいる間に、裏で終局図を作っておく
  const prefetch = () => {
    if (!dummySeed() && seedInput.value.trim()) generator.prefetch(Number(selected("size")), seedNumber(seedInput.value));
  };
  prefetch();
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="size"]')) {
    input.addEventListener("change", prefetch);
  }
  let seedTimer = 0;
  seedInput.addEventListener("input", () => {
    window.clearTimeout(seedTimer);
    seedTimer = window.setTimeout(prefetch, 500);
  });
  root.querySelector("#reseed")!.addEventListener("click", () => {
    seedInput.value = randomSeed();
    prefetch();
  });
  root.querySelector("#start-button")!.addEventListener("click", () => {
    window.clearTimeout(seedTimer);
    const next: Settings = {
      size: Number(selected("size")),
      undoOnPenalty: selected("undo") === "undo",
      replay: selected("start") === "replay",
      seed: seedInput.value.trim() || randomSeed(),
    };
    saveSettings(next);
    void prepareGame(root, next);
  });
}

/** 終局図を用意し、設定に応じて棋譜を再生してから対局を始める。 */
async function prepareGame(root: HTMLElement, settings: Settings): Promise<void> {
  const seed = seedNumber(settings.seed);
  // 次のゲーム（「もう一度」）のシードを決めて、遊んでいる間に作っておく
  const nextSeed = randomSeed();
  const dummy = dummySeed();
  if (dummy) {
    showGame(root, settings, dummyPosition(settings.size, dummy), nextSeed);
    return;
  }

  const status = h("p", { class: "lead" }, ["ネットワークを読み込んでいます…"]);
  const back = h("button", {}, ["やめる"]);
  let cancelled = false;
  back.addEventListener("click", () => {
    cancelled = true;
    showSettings(root, { ...settings, seed: randomSeed() });
  });
  root.replaceChildren(h("main", { class: "settings" }, [h("h1", {}, ["終局図を生成中"]), status, back]));

  let game: GeneratedGame;
  try {
    game = await generator.take(settings.size, seed, (move) => (status.textContent = `自動対局中… ${move} 手目`));
  } catch (err) {
    if (cancelled) return;
    status.textContent = `終局図を生成できませんでした（${err instanceof Error ? err.message : err}）。`;
    const fallback = h("button", { class: "primary" }, ["仮の局面で遊ぶ"]);
    fallback.addEventListener("click", () => showGame(root, settings, dummyPosition(settings.size, seed), nextSeed));
    status.after(fallback);
    return;
  }
  if (cancelled) return;
  generator.prefetch(settings.size, seedNumber(nextSeed));
  if (settings.replay) await replayGame(root, game);
  showGame(root, settings, game.position, nextSeed);
}

/** 棋譜を REPLAY_MS かけて並べる。 */
function replayGame(root: HTMLElement, game: GeneratedGame): Promise<void> {
  const view = new BoardView(game.size);
  const label = h("div", { class: "phase" }, []);
  const skip = h("button", {}, ["スキップ"]);
  // アゲハマは対局と同じトレイに、取った分だけリアルタイムで並べる
  const trays = { [BLACK]: trayElement(BLACK), [WHITE]: trayElement(WHITE) };
  root.replaceChildren(
    h("main", { class: "game" }, [
      h("div", { class: "board-wrap" }, [view.svg]),
      h("aside", { class: "panel" }, [label, trays[WHITE].root, trays[BLACK].root, skip]),
    ]),
  );
  const go = new GoGame(game.size);
  const show = () => {
    view.render(new Board(game.size, go.cells.slice()), new Set(), []);
    for (const color of [BLACK, WHITE] as const) {
      trays[color].count.textContent = `${go.captures[color]} 個`;
      trays[color].view.render(go.captures[color]);
    }
  };
  show();
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
 * 押してから離すまでの状態。離したときにクリック・範囲選択・ドロップのどれかとして扱う。
 * - board: 盤上で押した。dropping は「石を持って空点から引っ張った」（離した点に置く）
 * - tray: アゲハマトレイで押した
 */
type Drag =
  | { kind: "board"; start: number; current: number; dropping: boolean; button: number }
  | { kind: "tray"; owner: Color; start: number; current: number; button: number }
  | null;

/** nextSeed: 「もう一度」と「設定に戻る」で使う次のシード。 */
function showGame(root: HTMLElement, settings: Settings, position: Position, nextSeed: string): void {
  const session = new Session(position, { undoOnPenalty: settings.undoOnPenalty });
  const view = new BoardView(settings.size);

  const phaseLabel = h("div", { class: "phase" }, []);
  const timer = h("div", { class: "timer" }, []);
  const penaltyLabel = h("div", { class: "penalty" }, []);
  const openLabel = h("div", { class: "note" }, []);
  const message = h("div", { class: "message" }, []);
  // 盤の上に出す目立つ案内（操作できなかった理由など）
  const toast = h("div", { class: "toast" }, []);
  // 開始のカウントダウン（仕様書 §2.7）。合図までは操作できない
  const countdownNumber = h("span", { class: "countdown-number" }, []);
  const countdown = h("div", { class: "countdown" }, [
    h("div", { class: "countdown-spinner" }, [h("div", { class: "countdown-ring" }, []), countdownNumber]),
  ]);
  const ghost = h("div", { class: "ghost" }, []);
  const trays = { [BLACK]: trayElement(BLACK), [WHITE]: trayElement(WHITE) };
  const quitButton = h("button", { type: "button" }, ["やめる"]);
  // 目数の入力欄は最初から出しておく（仕様書 §2.6）
  const blackInput = h("input", { type: "number", step: "1", required: "", inputmode: "numeric" }, []);
  const whiteInput = h("input", { type: "number", step: "1", required: "", inputmode: "numeric" }, []);
  const scoreForm = h("form", { class: "score-form" }, [
    h("div", { class: "score-inputs" }, [
      h("label", {}, ["黒地", blackInput, "目"]),
      h("label", {}, ["白地", whiteInput, "目"]),
    ]),
    h("p", { class: "note" }, ["アゲハマが地より多いときはマイナスで入力します。"]),
    h("div", { class: "buttons" }, [h("button", { class: "primary" }, ["完了"]), quitButton]),
  ]);
  const resultBox = h("div", { class: "result-box" }, []);
  resultBox.hidden = true;

  // 左クリック（タップ）で置く石の色。右クリックでは反対の色を置く
  let primaryColor: Color = BLACK;
  const colorPicker = radioGroup("置く石（右クリックは反対の色）", "place-color", [
    { value: "black", label: "黒", checked: true },
    { value: "white", label: "白", checked: false },
  ]);
  colorPicker.classList.add("compact");
  colorPicker.addEventListener("change", (e) => {
    primaryColor = (e.target as HTMLInputElement).value === "white" ? WHITE : BLACK;
  });
  const colorFor = (button: number): Color => (button === 2 ? opponent(primaryColor) : primaryColor);

  root.replaceChildren(
    h("main", { class: "game" }, [
      h("div", { class: "board-wrap" }, [view.svg, toast, countdown]),
      h("aside", { class: "panel" }, [
        phaseLabel,
        timer,
        penaltyLabel,
        openLabel,
        colorPicker,
        trays[WHITE].root,
        trays[BLACK].root,
        message,
        scoreForm,
        resultBox,
        h("p", { class: "note seed-note" }, [`シード: ${settings.seed}`]),
      ]),
    ]),
    ghost,
  );

  let drag: Drag = null;
  let pointer = { x: 0, y: 0 };
  const cleanups: (() => void)[] = [];
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

  const render = () => {
    view.render(session.board, session.marks, session.hand?.origins ?? []);
    phaseLabel.textContent =
      session.phase === "removal"
        ? `① 死に石取り：死に石をアゲハマトレイへ（残り ${countDeadStones(session)} 個）`
        : "② 整地：アゲハマを埋めて地を整える";
    penaltyLabel.textContent = `ペナルティ ${session.penalties} 回（+${(session.penalties * PENALTY_MS) / 1000} 秒）`;
    openLabel.textContent = session.phase === "arrange" && session.boundaryOpen ? "境界が開いています（閉じた時点で目数を判定します）" : "";
    for (const color of [BLACK, WHITE] as const) {
      trays[color].count.textContent = `${session.position.trays[color]} 個`;
      trays[color].view.render(session.position.trays[color]);
    }
    renderGhost();
  };

  const renderGhost = () => {
    const stones = session.hand?.stones ?? [];
    ghost.style.display = stones.length === 0 ? "none" : "";
    if (stones.length === 0) return;
    ghost.style.transform = `translate(${pointer.x + 12}px, ${pointer.y + 12}px)`;
    // 黒と白それぞれの個数を出す
    ghost.replaceChildren(
      ...([BLACK, WHITE] as const).flatMap((color) => {
        const n = stones.filter((s) => s.color === color).length;
        if (n === 0) return [];
        return [
          h("span", { class: "ghost-item" }, [
            h("span", { class: `ghost-stone ${color === BLACK ? "black" : "white"}` }, []),
            h("span", { class: "ghost-count" }, [`×${n}`]),
          ]),
        ];
      }),
    );
  };

  const penaltyCheck = (before: number) => {
    if (session.penalties > before) flash(`ペナルティ！ +${PENALTY_MS / 1000} 秒`);
  };

  /** 持っている石を 1 個置く。死に石取りの間は置けないので、石を元に戻して理由を伝える。 */
  const place = (i: number, color: Color) => {
    if (session.placeAt(i, color) || session.phase !== "removal") return;
    session.cancel();
    notice("死に石取りの間は、盤上で石を動かせません。死に石をアゲハマトレイに移すと整地に進めます。");
  };

  const pickFromTray = (owner: Color, count: number) => {
    if (session.phase === "removal") {
      notice("死に石をすべて取り上げると、アゲハマを持てます。");
      return;
    }
    session.pickFromTray(owner, count);
  };

  const dropToTray = (owner: Color) => {
    if (!session.hand || session.dropToTray(owner)) return;
    const fits = session.hand.stones.some((s) => s.color === opponent(owner));
    if (!fits) {
      notice(owner === BLACK ? "黒のアゲハマには白石だけが入ります。" : "白のアゲハマには黒石だけが入ります。");
    } else {
      notice(`このトレイのアゲハマは ${session.trayCapacity[owner]} 個です。盤上の石をアゲハマにはできません。`);
    }
  };

  // --- 押す ---
  view.svg.addEventListener("pointerdown", (e) => {
    if (!session.started || (e.button !== 0 && e.button !== 2)) return;
    const i = view.pointAt(e.clientX, e.clientY);
    if (i === null) return;
    pointer = { x: e.clientX, y: e.clientY };
    const dropping = session.hand !== null && session.board.cells[i] === EMPTY;
    drag = { kind: "board", start: i, current: i, dropping, button: e.button };
    e.preventDefault();
  });

  for (const owner of [BLACK, WHITE] as const) {
    const tray = trays[owner];
    tray.root.addEventListener("pointerdown", (e) => {
      if (!session.started || (e.button !== 0 && e.button !== 2)) return;
      pointer = { x: e.clientX, y: e.clientY };
      const cell = tray.view.cellAt(e.clientX, e.clientY) ?? -1;
      drag = { kind: "tray", owner, start: cell, current: cell, button: e.button };
      e.preventDefault();
    });
  }

  // --- 動かす ---
  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (drag?.kind === "board") {
      const i = view.pointAt(e.clientX, e.clientY);
      if (i !== null) drag.current = i;
      if (!drag.dropping && drag.current !== drag.start) view.showSelection(drag.start, drag.current);
    } else if (drag?.kind === "tray" && drag.start >= 0) {
      const cell = trays[drag.owner].view.cellAt(e.clientX, e.clientY);
      if (cell !== null) drag.current = cell;
      if (drag.current !== drag.start) trays[drag.owner].view.showSelection(drag.start, drag.current);
    }
    renderGhost();
  };

  // --- 離す ---
  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const before = session.penalties;
    const tray = trayUnder(e.clientX, e.clientY);
    const i = view.pointAt(e.clientX, e.clientY);
    const color = colorFor(drag.button);

    if (drag.kind === "board") {
      view.showSelection(null, null);
      if (!drag.dropping && drag.current !== drag.start) {
        // 範囲選択（押した点が空点でも石でもよい）。持っている石に追加する
        session.pickUp(pointsInRect(settings.size, drag.start, drag.current));
      } else if (i === drag.start) {
        // 死に石取りの間は、クリックした石をそのままアゲハマトレイへ
        if (session.board.cells[i] !== EMPTY) {
          if (session.phase === "removal") session.capture(i);
          else session.pickUp([i]);
        }
        else if (session.hand) place(i, color);
      } else if (tray !== null) {
        dropToTray(tray);
      } else if (i !== null && session.board.cells[i] === EMPTY && session.hand) {
        place(i, color);
      }
    } else {
      const { owner, start } = drag;
      const view = trays[owner].view;
      const count = session.position.trays[owner];
      view.showSelection(null, null);
      if (tray === owner && start >= 0 && drag.current !== start) {
        // トレイの中で範囲選択
        const n = view.countInRect(start, drag.current, count);
        if (n > 0) pickFromTray(owner, n);
      } else if (tray === owner) {
        // 石をクリックすると持つ（死に石取りの間は持っている石を入れる）。空いた所なら持っている石を入れる
        const onStone = start >= 0 && start < count;
        if (onStone && !(session.phase === "removal" && session.hand)) pickFromTray(owner, 1);
        else dropToTray(owner);
      } else if (tray !== null) {
        dropToTray(tray);
      } else if (i !== null && session.board.cells[i] === EMPTY && start >= 0 && start < count) {
        // トレイの石を盤へドラッグ
        pickFromTray(owner, 1);
        if (session.hand) place(i, opponent(owner));
      }
    }
    drag = null;
    penaltyCheck(before);
    showRejected();
    render();
  };

  /** 死に石取りで死に石でない石を取ろうとしたとき: 画面を揺らし、×付きの石を浮かび上がらせて消す。 */
  const showRejected = () => {
    if (session.rejected.length === 0) return;
    const wrap = view.svg.parentElement!;
    for (const { point, color } of session.rejected) {
      const { x, y, r } = view.pointBox(point);
      const fx = h("div", { class: `reject-fx ${color === BLACK ? "black" : "white"}` }, []);
      fx.style.left = `${x - r}px`;
      fx.style.top = `${y - r}px`;
      fx.style.width = fx.style.height = `${r * 2}px`;
      fx.addEventListener("animationend", () => fx.remove());
      wrap.append(fx);
    }
    session.clearRejected();
    const main = root.querySelector(".game")!;
    main.classList.remove("shake");
    void (main as HTMLElement).offsetWidth; // アニメーションをやり直す
    main.classList.add("shake");
  };

  const trayUnder = (x: number, y: number): Color | null => {
    const target = document.elementFromPoint(x, y);
    if (trays[BLACK].root.contains(target)) return BLACK;
    if (trays[WHITE].root.contains(target)) return WHITE;
    return null;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      session.cancel();
      render();
    }
  };
  // 右クリックは「反対の色を置く」に使うので、盤とトレイの上ではメニューを出さない
  const onContextMenu = (e: MouseEvent) => {
    const target = e.target as Node;
    if (view.svg.contains(target) || trays[BLACK].root.contains(target) || trays[WHITE].root.contains(target)) {
      e.preventDefault();
    }
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("keydown", onKey);
  document.addEventListener("contextmenu", onContextMenu);
  const updateTimer = () => (timer.textContent = formatTime(session.elapsed()));
  const tick = window.setInterval(updateTimer, 100);
  updateTimer();

  const cleanup = () => {
    for (const f of cleanups) f();
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
    showSettings(root, { ...settings, seed: nextSeed });
  });

  scoreForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!session.started) return;
    const result = session.complete({ [BLACK]: Number(blackInput.value), [WHITE]: Number(whiteInput.value) });
    if (result.ok) {
      finish();
    } else {
      flash(`まだ完了していません（+${PENALTY_MS / 1000} 秒）`);
      render();
    }
  });

  /** 整地完了: 画面はそのままで、操作を止めて結果をパネルに出す。 */
  const finish = () => {
    cleanup();
    updateTimer();
    render();
    phaseLabel.textContent = "整地完了！";
    openLabel.textContent = "";
    message.textContent = "";
    root.querySelector(".game")!.classList.add("finished");
    const time = session.elapsed();
    const best = loadBest(settings.size);
    const isBest = best === null || time < best;
    if (isBest) saveBest(settings.size, time);
    const again = h("button", { class: "primary" }, ["もう一度"]);
    const back = h("button", {}, ["設定に戻る"]);
    again.addEventListener("click", () => void prepareGame(root, { ...settings, seed: nextSeed }));
    back.addEventListener("click", () => showSettings(root, { ...settings, seed: nextSeed }));
    for (const input of [blackInput, whiteInput]) input.disabled = true;
    scoreForm.querySelector(".buttons")!.remove();
    colorPicker.hidden = true;
    resultBox.replaceChildren(
      h("p", {}, [`黒 ${session.initialScores[BLACK]} 目・白 ${session.initialScores[WHITE]} 目`]),
      h("p", {}, [isBest ? `${settings.size} 路のベストタイム更新！` : `${settings.size} 路のベスト: ${formatTime(best!)}`]),
      h("div", { class: "buttons" }, [again, back]),
    );
    resultBox.hidden = false;
  };

  render();

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
    session.begin();
    updateTimer();
    countdown.classList.add("go");
    countdownNumber.textContent = "スタート！";
    window.setTimeout(() => countdown.remove(), 700);
  }, 1000);
  cleanups.push(() => window.clearInterval(countdownTimer));
}

/** 設定項目のラジオボタン群。 */
function radioGroup(
  legend: string,
  name: string,
  options: { value: string; label: string; checked: boolean; disabled?: boolean }[],
): HTMLFieldSetElement {
  return h("fieldset", { class: "radio-group" }, [
    h("legend", {}, [legend]),
    ...options.map((o) =>
      h("label", {}, [
        h("input", {
          type: "radio",
          name,
          value: o.value,
          ...(o.checked ? { checked: "" } : {}),
          ...(o.disabled ? { disabled: "" } : {}),
        }, []),
        o.label,
      ]),
    ),
  ]);
}

/** まだトレイに移していない死に石の数（手に持っている分も含む）。 */
function countDeadStones(session: Session): number {
  const onBoard = session.board.dead.reduce((n, d) => n + d, 0);
  return onBoard + (session.hand?.stones.filter((s) => s.dead).length ?? 0);
}

function trayElement(owner: Color) {
  const name = owner === BLACK ? "黒のアゲハマ（白石）" : "白のアゲハマ（黒石）";
  const stoneColor = opponent(owner);
  const count = h("span", { class: "tray-count" }, []);
  const view = new TrayView(owner, stoneColor);
  const root = h("div", { class: "tray" }, [
    h("div", { class: "tray-title" }, [
      h("span", { class: `tray-stone ${stoneColor === BLACK ? "black" : "white"}` }, []),
      name,
      count,
    ]),
    view.svg,
  ]);
  return { root, count, view };
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
  const fallback: Settings = { size: 19, undoOnPenalty: true, replay: false, seed: randomSeed() };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { ...fallback, ...saved, seed: fallback.seed };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: Settings): void {
  try {
    const { seed: _seed, ...rest } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
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
