import { GameGenerator } from "../ai/client";
import { GeneratedGame } from "../ai/generate";
import { GoGame } from "../ai/go";
import { GameRecord, parseSgf } from "../ai/sgf";
import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { mulberry32, randomSeed, seedNumber } from "../core/random";
import { dummyPosition } from "../game/dummy";
import { CPU_LEVELS, Cpu, CpuAction, CpuLevel, isCpuLevel } from "../game/cpu";
import { planLayouts, SerializedLayout } from "../game/layout";
import { Match, Player } from "../game/match";
import { PENALTY_MS, Session } from "../game/session";
import { BoardView } from "./boardView";
import { TrayView } from "./trayView";

interface Settings {
  /** ひとりで / vs CPU（仕様書 §3）。 */
  mode: "solo" | "cpu";
  /** vs CPU で自分が持つ石の色。相手の地を整地する。 */
  myColor: Color;
  cpuLevel: CpuLevel;
  /** vs CPU で、担当外の石を操作できないようにするか。 */
  restricted: boolean;
  size: number;
  undoOnPenalty: boolean;
  /** 開始時に初手から棋譜を並べるか（仕様書 §5.1）。 */
  replay: boolean;
  /** 終局図を作るシード。保存せず、画面を開くたびにランダムに決める。 */
  seed: string;
  /** 読み込んだ実戦の棋譜（SGF）。あればシードの代わりにこれを使う。保存しない。 */
  record?: GameRecord;
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
      radioGroup(
        "モード",
        "mode",
        [
          { value: "solo", label: "ひとりで", checked: settings.mode === "solo" },
          { value: "cpu", label: "vs CPU", checked: settings.mode === "cpu" },
        ],
        "ひとりで: 黒地と白地を両方整地して、タイムを競います。\nvs CPU: 相手の地を整地します。ペナルティ込みのタイムが短い方が勝ちです。",
      ),
      h("div", { class: "cpu-settings" }, [
        radioGroup(
          "自分の石",
          "my-color",
          [
            { value: "black", label: "黒（白地を整地）", checked: settings.myColor === BLACK },
            { value: "white", label: "白（黒地を整地）", checked: settings.myColor === WHITE },
          ],
          "囲碁の慣例どおり、相手の地を整地します。白のときは盤を 180° 回して表示します。",
        ),
        radioGroup(
          "CPU の強さ",
          "cpu-level",
          (Object.keys(CPU_LEVELS) as CpuLevel[]).map((level) => ({
            value: level,
            label: CPU_LEVELS[level].label,
            checked: settings.cpuLevel === level,
          })),
          "強さによって、CPU が 1 回操作する間隔と、ミスの多さが変わります。\n" +
            (Object.keys(CPU_LEVELS) as CpuLevel[])
              .map((level) => `${CPU_LEVELS[level].label}: ${CPU_LEVELS[level].interval / 1000} 秒ごと、${MISTAKE_TEXT[level]}`)
              .join("\n"),
        ),
        radioGroup(
          "担当外の石の操作",
          "restricted",
          [
            { value: "on", label: "制限あり", checked: settings.restricted },
            { value: "off", label: "制限なし", checked: !settings.restricted },
          ],
          "担当外の石とは、あなたが整地しない側の石です。vs CPU では、あなたは CPU の地を、CPU はあなたの地を整地します。\n" +
            "制限あり: 動かせるのは相手の色の石と、相手の石に接している自分の色の石（黒白の境界線の石）だけです。自分の地の側の石（例: 自分の石の塊の中央）は動かせません。CPU が整地しているあなたの地には石を置けません。\n" +
            "制限なし: どの石も動かせます（CPU の整地を邪魔することもできます）。",
        ),
      ]),
      radioGroup(
        "終局図",
        "source",
        [
          { value: "katago", label: "自動で作る", checked: !settings.record },
          { value: "sgf", label: "SGF を読み込む", checked: !!settings.record },
        ],
        "自動で作る: KataGo の自動対局でその場で作ります。初回はネットワーク（約 4 MB）を読み込みます。\nSGF を読み込む: 終局済みの実戦の棋譜で遊びます。",
      ),
      h("fieldset", { class: "radio-group sgf-group" }, [
        h("legend", {}, ["SGF ファイル（終局済みの棋譜）"]),
        h("input", { type: "file", id: "sgf-file", accept: ".sgf,application/x-go-sgf" }, []),
        h("p", { class: "note", id: "sgf-info" }, [settings.record ? recordLabel(settings.record) : "ファイルを選んでください。"]),
      ]),
      radioGroup("盤のサイズ", "size", [
        { value: "19", label: "19 路", checked: settings.size === 19, disabled: small },
        { value: "13", label: "13 路", checked: settings.size === 13 },
        { value: "9", label: "9 路", checked: settings.size === 9 },
      ]),
      radioGroup(
        "開始時の表示",
        "start",
        [
          { value: "final", label: "終局図から", checked: !settings.replay },
          { value: "replay", label: "初手から並べる", checked: settings.replay },
        ],
        "初手から並べる: 棋譜を 10 秒で再生してから整地を始めます。",
      ),
      radioGroup(
        "ペナルティ時の石",
        "undo",
        [
          { value: "undo", label: "元に戻す", checked: settings.undoOnPenalty },
          { value: "keep", label: "そのまま（印を付ける）", checked: !settings.undoOnPenalty },
        ],
        "地の目数が変わる置き方をすると、+5 秒のペナルティになります（例: アゲハマを相手の地に置いた、境界を崩したまま閉じた）。\n" +
          "元に戻す: ペナルティになった石を、自動で元の場所に戻します。\n" +
          "そのまま: 石は動かさず、間違えた場所に×印を付けます。自分で直すと印は消えます。",
      ),
      h("fieldset", { class: "radio-group seed-group" }, [
        legendWithHelp("シード", "同じ盤サイズとシードなら同じ終局図になります。画面を開くたびにランダムな値が入ります。"),
        h("input", { type: "text", id: "seed", value: settings.seed, spellcheck: "false", autocomplete: "off" }, []),
        h("button", { type: "button", id: "reseed" }, ["別のシード"]),
      ]),
      h("button", { id: "start-button", class: "primary" }, ["スタート"]),
      h("p", { class: "links" }, [h("a", { href: "https://github.com/kos59125/go-ssb/blob/main/docs/rulebook.md", target: "_blank" }, ["ルールブック"])]),
    ]),
  );
  const selected = (name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
  const seedInput = root.querySelector<HTMLInputElement>("#seed")!;
  const sgfInfo = root.querySelector<HTMLParagraphElement>("#sgf-info")!;
  const startButton = root.querySelector<HTMLButtonElement>("#start-button")!;
  let record = settings.record;
  const isCpu = () => selected("mode") === "cpu";
  const updateMode = () => {
    root.querySelector<HTMLElement>(".cpu-settings")!.hidden = !isCpu();
  };
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    input.addEventListener("change", updateMode);
  }
  // SGF のときは、盤のサイズとシードは棋譜で決まるので表示しない
  const updateSource = () => {
    const sgf = selected("source") === "sgf";
    root.querySelector<HTMLElement>(".sgf-group")!.hidden = !sgf;
    root.querySelector<HTMLElement>(".seed-group")!.hidden = sgf;
    root.querySelector<HTMLElement>('input[name="size"]')!.closest("fieldset")!.hidden = sgf;
    startButton.disabled = sgf && !record;
  };
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="source"]')) {
    input.addEventListener("change", updateSource);
  }
  root.querySelector<HTMLInputElement>("#sgf-file")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      record = parseSgf(await file.text());
      sgfInfo.textContent = recordLabel(record);
      sgfInfo.classList.remove("error");
    } catch (err) {
      record = undefined;
      sgfInfo.textContent = `読み込めませんでした: ${err instanceof Error ? err.message : err}`;
      sgfInfo.classList.add("error");
    }
    updateSource();
  });
  updateSource();
  // 設定を選んでいる間に、裏で終局図を作っておく
  function prefetch() {
    if (!dummySeed() && seedInput.value.trim()) {
      generator.prefetch(Number(selected("size")), seedNumber(seedInput.value), true);
    }
  }
  updateMode();
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
  startButton.addEventListener("click", () => {
    window.clearTimeout(seedTimer);
    const sgf = selected("source") === "sgf" ? record : undefined;
    const next: Settings = {
      mode: isCpu() ? "cpu" : "solo",
      myColor: selected("my-color") === "white" ? WHITE : BLACK,
      cpuLevel: selected("cpu-level") as CpuLevel,
      restricted: selected("restricted") === "on",
      size: Number(selected("size")),
      undoOnPenalty: selected("undo") === "undo",
      replay: selected("start") === "replay",
      seed: seedInput.value.trim() || randomSeed(),
    };
    saveSettings(next);
    void prepareGame(root, sgf ? { ...next, size: sgf.size, record: sgf } : next);
  });
}

/** 終局図を用意し、設定に応じて棋譜を再生してから対局を始める。 */
async function prepareGame(root: HTMLElement, settings: Settings): Promise<void> {
  const seed = seedNumber(settings.seed);
  // 次のゲーム（「もう一度」）のシードを決めて、遊んでいる間に作っておく
  const nextSeed = randomSeed();
  const dummy = dummySeed();
  if (dummy) {
    const position = dummyPosition(settings.size, dummy);
    showGame(root, settings, position, nextSeed, planLayouts(position));
    return;
  }

  // ギブアップで CPU が整地できるよう、ひとりでモードでも CPU が整地できる局面を作る
  const forCpu = true;
  const status = h("p", { class: "lead" }, [
    settings.record ? "棋譜を読み込んで、死に石を判定しています…" : "ネットワークを読み込んでいます…",
  ]);
  const back = h("button", {}, ["やめる"]);
  let cancelled = false;
  back.addEventListener("click", () => {
    cancelled = true;
    showSettings(root, { ...settings, seed: randomSeed() });
  });
  root.replaceChildren(
    h("main", { class: "settings" }, [h("h1", {}, [settings.record ? "棋譜を準備中" : "終局図を生成中"]), status, back]),
  );

  let game: GeneratedGame;
  try {
    game = settings.record
      ? await generator.fromRecord(settings.record, forCpu)
      : await generator.take(settings.size, seed, forCpu, (move) => (status.textContent = `自動対局中… ${move} 手目`));
  } catch (err) {
    if (cancelled) return;
    if (settings.record) {
      // 棋譜の問題（ダメが詰まっていない等）は、仮の局面では代わりにならないので設定に戻ってもらう
      status.textContent = `棋譜を読み込めませんでした: ${err instanceof Error ? err.message : err}`;
      status.classList.add("error");
      back.textContent = "設定に戻る";
      return;
    }
    status.textContent = `終局図を生成できませんでした（${err instanceof Error ? err.message : err}）。`;
    const fallback = h("button", { class: "primary" }, ["仮の局面で遊ぶ"]);
    fallback.addEventListener("click", () => {
      const position = dummyPosition(settings.size, seed);
      showGame(root, settings, position, nextSeed, planLayouts(position));
    });
    status.after(fallback);
    return;
  }
  if (cancelled) return;
  // 実戦の棋譜は作り直せないので、CPU が整地できる形が見つからなければ vs CPU では遊べない
  if (settings.mode === "cpu" && !game.layouts?.[settings.myColor]) {
    status.textContent = "この棋譜は、CPU が整地できる形が見つかりませんでした。ひとりでモードで遊んでください。";
    return;
  }
  if (!settings.record) generator.prefetch(settings.size, seedNumber(nextSeed), forCpu);
  if (settings.replay) await replayGame(root, game);
  showGame(root, settings, game.position, nextSeed, game.layouts);
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
  for (const { point, color } of game.setup) go.setup(point, color);
  const show = () => {
    view.render(new Board(game.size, go.cells.slice()), new Set(), []);
    for (const color of [BLACK, WHITE] as const) {
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
        go.toPlay = move.color;
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

/**
 * 整地の画面（ひとりで / vs CPU）。
 * @param nextSeed 「もう一度」と「設定に戻る」で使う次のシード
 * @param layouts vs CPU 用の整地の形（CPU が使う）
 */
function showGame(
  root: HTMLElement,
  settings: Settings,
  position: Position,
  nextSeed: string,
  layouts?: Record<Color, SerializedLayout | null>,
): void {
  const cpuMode = settings.mode === "cpu";
  const myColor = settings.myColor;
  const cpuColor = opponent(myColor);
  let session: Player;
  let cpu: Cpu | null = null;
  if (cpuMode) {
    const match = new Match(position, { undoOnPenalty: settings.undoOnPenalty });
    session = new Player(match, { color: myColor, restricted: settings.restricted });
    // CPU は人の地（myColor の地）を整地する
    // CPU のミスや無駄な操作の乱数は、終局図のシードとは別に毎回ランダムに決める
    cpu = new Cpu(new Player(match, { color: cpuColor }), layouts ?? {}, {
      level: settings.cpuLevel,
      random: mulberry32(seedNumber(randomSeed())),
    });
  } else {
    session = new Session(position, { undoOnPenalty: settings.undoOnPenalty });
  }
  const cpuPlayer = cpu?.player ?? null;
  // 自分が白なら盤を 180° 回して表示する（仕様書 §4）
  const view = new BoardView(settings.size, cpuMode && myColor === WHITE);
  const colorName = (c: Color) => (c === BLACK ? "黒" : "白");

  const phaseLabel = h("div", { class: "phase" }, []);
  const timer = h("div", { class: "timer" }, []);
  const penaltyLabel = h("div", { class: "penalty" }, []);
  const openLabel = h("div", { class: "note" }, []);
  const message = h("div", { class: "message" }, []);
  const cpuStatus = h("div", { class: "cpu-status" }, []);
  cpuStatus.hidden = !cpuMode;
  // 盤の上に出す目立つ案内（操作できなかった理由など）
  const toast = h("div", { class: "toast" }, []);
  // 開始のカウントダウン（仕様書 §2.7）。合図までは操作できない
  const countdownNumber = h("span", { class: "countdown-number" }, []);
  const countdown = h("div", { class: "countdown" }, [
    h("div", { class: "countdown-spinner" }, [h("div", { class: "countdown-ring" }, []), countdownNumber]),
  ]);
  const ghost = h("div", { class: "ghost" }, []);
  // CPU のカーソル（vs CPU では常に表示する）
  const cpuCursor = makeCursor("CPU");
  cpuCursor.hidden = !cpuMode;
  // ギブアップ後に代わりに整地する CPU のカーソル
  const autoCursor = makeCursor("おまかせ");
  autoCursor.classList.add("auto");
  autoCursor.hidden = true;
  const trays = {
    [BLACK]: trayElement(BLACK, cpuMode ? (myColor === BLACK ? "あなた" : "CPU") : undefined),
    [WHITE]: trayElement(WHITE, cpuMode ? (myColor === WHITE ? "あなた" : "CPU") : undefined),
  };
  if (cpuMode) trays[cpuColor].root.classList.add("readonly");
  const quitButton = h("button", { type: "button" }, ["やめる"]);
  // ひとりでモード: 終局図からやり直す（タイマーとペナルティは続く）
  const resetButton = h("button", { type: "button" }, ["最初からやり直す"]);
  resetButton.hidden = cpuMode;
  // ギブアップ: CPU が代わりに整地する
  const giveUpButton = h("button", { type: "button" }, ["ギブアップ"]);
  // 目数の入力欄は最初から出しておく（仕様書 §2.6）。vs CPU では担当の地だけ
  const blackInput = h("input", { type: "number", step: "1", required: "", inputmode: "numeric" }, []);
  const whiteInput = h("input", { type: "number", step: "1", required: "", inputmode: "numeric" }, []);
  const inputs = { [BLACK]: blackInput, [WHITE]: whiteInput };
  const scoreForm = h("form", { class: "score-form" }, [
    h("div", { class: "score-inputs" }, session.assigned.map((c) => h("label", {}, [`${colorName(c)}地`, inputs[c], "目"]))),
    h("p", { class: "note" }, ["アゲハマが地より多いときはマイナスで入力します。"]),
    h("div", { class: "buttons" }, [h("button", { class: "primary" }, ["完了"]), resetButton, giveUpButton, quitButton]),
  ]);
  for (const input of [blackInput, whiteInput]) {
    input.addEventListener("input", () => input.classList.remove("wrong"));
  }
  const resultBox = h("div", { class: "result-box" }, []);
  resultBox.hidden = true;

  // 左クリック（タップ）で置く石の色。右クリックでは反対の色を置く
  let primaryColor: Color = cpuMode ? cpuColor : BLACK;
  const colorPicker = radioGroup("置く石（右クリックは反対の色）", "place-color", [
    { value: "black", label: "黒", checked: primaryColor === BLACK },
    { value: "white", label: "白", checked: primaryColor === WHITE },
  ]);
  colorPicker.classList.add("compact");
  colorPicker.addEventListener("change", (e) => {
    primaryColor = (e.target as HTMLInputElement).value === "white" ? WHITE : BLACK;
  });
  const colorFor = (button: number): Color => (button === 2 ? opponent(primaryColor) : primaryColor);

  const trayOrder: Color[] = cpuMode ? [myColor, cpuColor] : [WHITE, BLACK];
  root.replaceChildren(
    h("main", { class: "game" }, [
      h("div", { class: "board-wrap" }, [view.svg, toast, countdown]),
      h("aside", { class: "panel" }, [
        phaseLabel,
        timer,
        penaltyLabel,
        cpuStatus,
        openLabel,
        colorPicker,
        ...trayOrder.map((c) => trays[c].root),
        message,
        scoreForm,
        resultBox,
        h("p", { class: "note seed-note" }, [settings.record ? `棋譜: ${recordLabel(settings.record)}` : `シード: ${settings.seed}`]),
      ]),
    ]),
    ghost,
    cpuCursor,
    autoCursor,
  );

  let drag: Drag = null;
  let pointer = { x: 0, y: 0 };
  const cleanups: (() => void)[] = [];
  // 「完了」で見つかった誤りの場所。次の操作で消す
  let errorMarks = new Set<number>();
  let messageTimer = 0;
  let toastTimer = 0;
  // 人の操作を受け付けるか（完了した後や、勝敗が決まった後は受け付けない）
  let accepting = true;
  // ギブアップした時点のタイム。ギブアップした後はタイムを止めて表示する
  let gaveUpAt: number | null = null;

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
    view.render(session.board, session.marks, session.hand?.origins ?? [], errorMarks);
    if (session.phase !== "finished" && gaveUpAt === null) {
      const removal = cpuMode
        ? `① 死に石取り：自分の地（${colorName(myColor)}地）の中の死に石をアゲハマへ（残り ${countDeadStones(session)} 個）`
        : `① 死に石取り：死に石をアゲハマトレイへ（残り ${countDeadStones(session)} 個）`;
      const arrange = cpuMode
        ? `② 整地：${colorName(cpuColor)}地にアゲハマを埋めて整える`
        : "② 整地：アゲハマを埋めて地を整える";
      phaseLabel.textContent = session.phase === "removal" ? removal : arrange;
    }
    penaltyLabel.textContent = `ペナルティ ${session.penalties} 回（+${(session.penalties * PENALTY_MS) / 1000} 秒）`;
    openLabel.textContent = session.phase === "arrange" && session.boundaryOpen ? "境界が開いています（閉じた時点で目数を判定します）" : "";
    for (const color of [BLACK, WHITE] as const) {
      trays[color].view.render(session.position.trays[color]);
    }
    if (cpuPlayer) {
      const state =
        cpuPlayer.phase === "finished"
          ? `完了 ${formatTime(cpuPlayer.elapsed())}`
          : cpuPlayer.phase === "removal"
            ? "死に石取り中"
            : cpuWaiting
              ? "待機中"
              : `${colorName(myColor)}地を整地中`;
      const cpuPenalty = cpuPlayer.penalties > 0 ? `（ペナルティ ${cpuPlayer.penalties} 回）` : "";
      cpuStatus.textContent = `CPU（${colorName(cpuColor)}）: ${state}${cpuPenalty}`;
    }
    // 石を持っているときは grabbing、持っていないときは grab のカーソル
    document.body.classList.toggle("holding", !!session.hand);
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

  /** 持っている石を 1 個置く。置けなかった理由を伝える。 */
  const place = (i: number, color: Color) => {
    if (session.placeAt(i, color)) return;
    if (session.phase === "removal") {
      session.cancel();
      notice("死に石取りの間は、盤上で石を動かせません。死に石をアゲハマトレイに移すと整地に進めます。");
    } else if (!session.canPlace(i)) {
      notice("担当外の地には置けません（設定で制限しています）。");
    }
  };

  const pickFromTray = (owner: Color, count: number) => {
    if (session.phase === "removal") {
      notice("死に石をすべて取り上げると、アゲハマを持てます。");
      return;
    }
    session.pickFromTray(owner, count);
  };

  const dropToTray = (owner: Color) => {
    if (!session.canUseTray(owner)) {
      notice("CPU のアゲハマは使えません。");
      return;
    }
    if (!session.hand || session.dropToTray(owner)) return;
    const fits = session.hand.stones.some((s) => s.color === opponent(owner));
    if (!fits) {
      notice(owner === BLACK ? "黒のアゲハマには白石だけが入ります。" : "白のアゲハマには黒石だけが入ります。");
    } else {
      notice("このトレイはいっぱいです。盤上の石をアゲハマにはできません。");
    }
  };

  const pickUp = (points: number[]) => {
    if (!session.pickUp(points) && session.restricted && points.some((i) => session.board.cells[i] !== EMPTY)) {
      notice(`担当外の石は動かせません（設定で制限しています）。動かせるのは${colorName(cpuColor)}石と、${colorName(cpuColor)}石に接している境界線の石だけです。`);
    }
  };

  // --- 押す ---
  view.svg.addEventListener("pointerdown", (e) => {
    if (!accepting || !session.started || (e.button !== 0 && e.button !== 2)) return;
    errorMarks = new Set();
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
      if (!accepting || !session.started || (e.button !== 0 && e.button !== 2)) return;
      errorMarks = new Set();
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
        pickUp(pointsInRect(settings.size, drag.start, drag.current));
      } else if (i === drag.start) {
        // 死に石取りの間は、クリックした石をそのままアゲハマトレイへ
        if (session.board.cells[i] !== EMPTY) {
          if (session.phase === "removal") {
            if (!session.capture(i) && cpuMode && session.board.cells[i] === myColor) {
              notice(`死に石取りで取るのは、自分の地の中の${colorName(cpuColor)}の死に石です。`);
            }
          } else pickUp([i]);
        } else if (session.hand) place(i, color);
      } else if (tray !== null) {
        dropToTray(tray);
      } else if (i !== null && session.board.cells[i] === EMPTY && session.hand) {
        place(i, color);
      }
    } else {
      const { owner, start } = drag;
      const trayView = trays[owner].view;
      const count = session.position.trays[owner];
      trayView.showSelection(null, null);
      if (!session.canUseTray(owner)) {
        notice("CPU のアゲハマは使えません。");
      } else if (tray === owner && start >= 0 && drag.current !== start) {
        // トレイの中で範囲選択
        const n = trayView.countInRect(start, drag.current, count);
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
    shake();
  };

  /** 画面全体を揺らす。 */
  const shake = () => {
    const main = root.querySelector<HTMLElement>(".game")!;
    main.classList.remove("shake");
    void main.offsetWidth; // アニメーションをやり直す
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
  const updateTimer = () => (timer.textContent = formatTime(gaveUpAt ?? session.elapsed()));
  const tick = window.setInterval(() => {
    updateTimer();
    if (cpuMode) {
      render();
      decide();
    }
  }, 100);
  updateTimer();

  /** 人の操作を止める（完了したとき、勝敗が決まったとき）。 */
  const stopInput = () => {
    accepting = false;
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("holding");
  };

  const cleanup = () => {
    for (const f of cleanups) f();
    stopInput();
    document.removeEventListener("contextmenu", onContextMenu);
    window.clearInterval(tick);
    window.clearTimeout(messageTimer);
    window.clearTimeout(toastTimer);
  };

  /** 画面を離れる。 */
  const leave = () => {
    cleanup();
    cpuCursor.remove();
    autoCursor.remove();
  };

  giveUpButton.addEventListener("click", () => {
    if (!session.started || !accepting) return;
    if (!window.confirm("ギブアップしますか？ CPU があなたの代わりに整地します。")) return;
    gaveUpAt = session.elapsed();
    stopInput();
    errorMarks = new Set();
    for (const input of [blackInput, whiteInput]) input.disabled = true;
    scoreForm.querySelector(".buttons")?.remove();
    colorPicker.hidden = true;
    message.textContent = "";
    // 自分の操作をすべて元に戻し、CPU が代わりに死に石取りから整地する
    session.revertAll();
    if (cpuMode) decided = true;
    phaseLabel.textContent = cpuMode ? "ギブアップ（CPU の勝ち）。CPU が代わりに整地しています…" : "ギブアップ。CPU が代わりに整地しています…";
    showGiveUpResult();
    const auto = new Cpu(session, layouts ?? {});
    autoCursor.hidden = false;
    moveCursor(autoCursor, auto, null, session.color ?? BLACK);
    let idle = 0;
    const autoTimer = window.setInterval(() => {
      const action = auto.step();
      moveCursor(autoCursor, auto, action, session.color ?? BLACK);
      render();
      if (session.phase === "finished") {
        window.clearInterval(autoTimer);
        phaseLabel.textContent = cpuMode ? "ギブアップ（CPU の勝ち）" : "ギブアップ";
        root.querySelector(".game")!.classList.add("finished");
        return;
      }
      // 相手の死に石取りを待つ間を除き、手が止まったままなら整地できなかったとみなす
      idle = action.kind === "idle" && !(cpuPlayer && cpuPlayer.phase === "removal") ? idle + 1 : 0;
      if (idle > 20) {
        window.clearInterval(autoTimer);
        phaseLabel.textContent = "ギブアップ。この局面は CPU が整地できませんでした。";
      }
    }, 350);
    cleanups.push(() => window.clearInterval(autoTimer));
    render();
  });

  /** ギブアップしたときの結果表示（答えの目数と、もう一度・設定に戻る）。 */
  const showGiveUpResult = () => {
    const again = h("button", { class: "primary" }, ["もう一度"]);
    const back = h("button", {}, ["設定に戻る"]);
    again.addEventListener("click", () => {
      leave();
      void prepareGame(root, { ...settings, seed: nextSeed });
    });
    back.addEventListener("click", () => {
      leave();
      showSettings(root, { ...settings, seed: nextSeed });
    });
    resultBox.replaceChildren(
      h("p", {}, [`黒 ${session.initialScores[BLACK]} 目・白 ${session.initialScores[WHITE]} 目`]),
      h("div", { class: "buttons" }, [again, back]),
    );
    resultBox.hidden = false;
  };

  resetButton.addEventListener("click", () => {
    if (!session.started || !(session instanceof Session)) return;
    if (!window.confirm("終局図からやり直しますか？（タイマーとペナルティはそのまま続きます）")) return;
    session.reset();
    errorMarks = new Set();
    drag = null;
    view.showSelection(null, null);
    render();
  });

  quitButton.addEventListener("click", () => {
    leave();
    showSettings(root, { ...settings, seed: nextSeed });
  });

  scoreForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!session.started || !accepting) return;
    const answer: Partial<Record<Color, number>> = {};
    for (const c of session.assigned) answer[c] = Number(inputs[c].value);
    const result = session.complete(answer);
    if (result.ok) {
      humanFinished();
      return;
    }
    flash(`まだ完了していません（+${PENALTY_MS / 1000} 秒）`);
    shake();
    // 誤りの場所に×を付ける
    errorMarks = new Set(result.errorPoints);
    // 目数が違う入力欄を強調する
    for (const c of [BLACK, WHITE] as const) inputs[c].classList.toggle("wrong", result.wrongAnswers.includes(c));
    // 場所で示せない誤りは文章で伝える
    if (result.errorPoints.length === 0) {
      const other = result.problems.filter((p) => !p.endsWith("の目数が違う"));
      if (other.length > 0) notice(other.join(" / "));
    }
    render();
  });

  /** 人が整地を完了した。ひとりでモードならそのまま終了、vs CPU なら勝敗が決まるまで待つ。 */
  const humanFinished = () => {
    stopInput();
    for (const input of [blackInput, whiteInput]) input.disabled = true;
    scoreForm.querySelector(".buttons")!.remove();
    colorPicker.hidden = true;
    message.textContent = "";
    openLabel.textContent = "";
    if (!cpuMode) {
      endGame();
      return;
    }
    phaseLabel.textContent = "整地完了！ CPU の完了を待っています…";
    decide();
  };

  /**
   * vs CPU の勝敗（ペナルティ込みのタイムが短い方の勝ち）。両方が完了したとき、
   * または先に完了した側のタイムを、もう一方の経過時間が超えた時点で決まる。
   */
  let decided = false;
  const decide = () => {
    if (!cpuPlayer || decided || !session.started) return;
    const me = session.phase === "finished" ? session.elapsed() : null;
    const them = cpuPlayer.phase === "finished" ? cpuPlayer.elapsed() : null;
    let winner: "me" | "cpu" | null = null;
    if (me !== null && them !== null) winner = me <= them ? "me" : "cpu";
    else if (me !== null && cpuPlayer.elapsed() > me) winner = "me";
    else if (them !== null && session.elapsed() > them) winner = "cpu";
    if (!winner) return;
    decided = true;
    endGame(winner);
  };

  /** 終了: 画面はそのままで、操作を止めて結果をパネルに出す。 */
  const endGame = (winner?: "me" | "cpu") => {
    cleanup();
    updateTimer();
    render();
    root.querySelector(".game")!.classList.add("finished");
    const again = h("button", { class: "primary" }, ["もう一度"]);
    const back = h("button", {}, ["設定に戻る"]);
    // 棋譜で遊んだときの「もう一度」は同じ棋譜で、KataGo のときは新しいシードで遊ぶ
    again.addEventListener("click", () => {
      leave();
      void prepareGame(root, { ...settings, seed: nextSeed });
    });
    back.addEventListener("click", () => {
      leave();
      showSettings(root, { ...settings, seed: nextSeed });
    });
    if (session.phase !== "finished") {
      for (const input of [blackInput, whiteInput]) input.disabled = true;
      scoreForm.querySelector(".buttons")?.remove();
      colorPicker.hidden = true;
    }
    const lines: Node[] = [];
    if (winner) {
      phaseLabel.textContent = winner === "me" ? "あなたの勝ち！" : "CPU の勝ち…";
      const mine = session.phase === "finished" ? formatTime(session.elapsed()) : "未完了";
      const theirs = cpuPlayer!.phase === "finished" ? formatTime(cpuPlayer!.elapsed()) : "未完了";
      lines.push(h("p", {}, [`あなた ${mine}・CPU ${theirs}`]));
    } else {
      phaseLabel.textContent = "整地完了！";
      const time = session.elapsed();
      const best = loadBest(settings.size);
      const isBest = best === null || time < best;
      if (isBest) saveBest(settings.size, time);
      lines.push(h("p", {}, [isBest ? `${settings.size} 路のベストタイム更新！` : `${settings.size} 路のベスト: ${formatTime(best!)}`]));
    }
    resultBox.replaceChildren(
      h("p", {}, [`黒 ${session.initialScores[BLACK]} 目・白 ${session.initialScores[WHITE]} 目`]),
      ...lines,
      h("div", { class: "buttons" }, [again, back]),
    );
    resultBox.hidden = false;
  };

  // --- CPU ---
  let cpuWaiting = false;
  /** CPU のカーソルを、操作した点（またはトレイ）へ動かす。 */
  const moveCpuCursor = (action: CpuAction | null) => {
    if (cpu) moveCursor(cpuCursor, cpu, action, cpuColor);
  };
  const moveCursor = (cursor: HTMLElement, cpu: Cpu, action: CpuAction | null, trayOwner: Color) => {
    let target: { x: number; y: number } | null = null;
    if (action && "point" in action) {
      const box = view.svg.getBoundingClientRect();
      const { x, y } = view.pointBox(action.point);
      target = { x: box.left + x, y: box.top + y };
    } else if (action?.kind === "pick-tray" || action?.kind === "drop-tray") {
      // どちらのトレイから持ったかは、持っている石の色で決まる
      const held = cpu.player.hand?.stones.at(-1);
      const owner = held ? opponent(held.color) : trayOwner;
      const box = trays[owner].view.svg.getBoundingClientRect();
      target = { x: box.left + 20, y: box.top + 15 };
    } else if (!cursor.style.transform) {
      const box = view.svg.getBoundingClientRect();
      target = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    if (target) cursor.style.transform = `translate(${target.x}px, ${target.y}px)`;
    const held = cpu.player.hand?.stones[0];
    cursor.classList.toggle("holding-black", held?.color === BLACK);
    cursor.classList.toggle("holding-white", held?.color === WHITE);
  };

  const startCpu = () => {
    if (!cpu) return;
    const timer = window.setInterval(() => {
      // 勝敗が決まったら止める（ギブアップのときは、盤を仕上げるために最後まで続ける）
      if (decided && gaveUpAt === null) return;
      if (cpu!.player.phase === "finished") return;
      const before = session.penalties;
      const cpuBefore = cpu!.player.penalties;
      const action = cpu!.step();
      cpuWaiting = action.kind === "idle" && cpu!.player.phase === "arrange";
      moveCpuCursor(action);
      penaltyCheck(before);
      if (gaveUpAt === null && cpu!.player.penalties > cpuBefore) notice(`CPU がミスしました（+${PENALTY_MS / 1000} 秒）`);
      render();
      decide();
    }, CPU_LEVELS[settings.cpuLevel].interval);
    cleanups.push(() => window.clearInterval(timer));
  };

  render();
  moveCpuCursor(null);

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
    startCpu();
    updateTimer();
    countdown.classList.add("go");
    countdownNumber.textContent = "スタート！";
    window.setTimeout(() => countdown.remove(), 700);
  }, 1000);
  cleanups.push(() => window.clearInterval(countdownTimer));
}

/** 見出しと「?」。「?」にマウスを乗せるかフォーカスすると、右に説明の吹き出しを出す。 */
function legendWithHelp(text: string, help: string): HTMLLegendElement {
  return h("legend", {}, [
    text,
    h("span", { class: "help", tabindex: "0", role: "button", "aria-label": `${text}の説明` }, [
      "?",
      h("span", { class: "help-bubble", role: "tooltip" }, [help]),
    ]),
  ]);
}

/** CPU のカーソル（矢印と名前）。 */
function makeCursor(label: string): HTMLDivElement {
  return h("div", { class: "cpu-cursor" }, [h("span", { class: "cpu-cursor-label" }, [label])]);
}

/** 棋譜の説明（対局者・盤サイズ・手数）。結果は答えになるので出さない。 */
function recordLabel(record: GameRecord): string {
  const players = record.black || record.white ? `${record.black ?? "?"}（黒）− ${record.white ?? "?"}（白）` : "対局者不明";
  return `${players}、${record.size} 路、${record.moves.length} 手`;
}

/** 設定項目のラジオボタン群。 */
function radioGroup(
  legend: string,
  name: string,
  options: { value: string; label: string; checked: boolean; disabled?: boolean }[],
  help?: string,
): HTMLFieldSetElement {
  return h("fieldset", { class: "radio-group" }, [
    help ? legendWithHelp(legend, help) : h("legend", {}, [legend]),
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
function countDeadStones(session: Player): number {
  const board = session.board;
  let onBoard = 0;
  if (session.color === null) {
    onBoard = board.dead.reduce((n, d) => n + d, 0);
  } else {
    // 対戦: 自分の地の中の相手の死に石だけ
    const { regions, regionOf } = analyze(board);
    for (let i = 0; i < board.cells.length; i++) {
      if (board.dead[i] === 1 && board.cells[i] !== session.color && regions[regionOf[i]].owner === session.color) onBoard++;
    }
  }
  return onBoard + (session.hand?.stones.filter((s) => s.dead).length ?? 0);
}

/** who: 対戦でのトレイの持ち主の呼び名（「あなた」「CPU」）。 */
function trayElement(owner: Color, who?: string) {
  const name = `${who ?? (owner === BLACK ? "黒" : "白")}のアゲハマ（${owner === BLACK ? "白石" : "黒石"}）`;
  const stoneColor = opponent(owner);
  // 個数は目数（特にマイナス）の目安になるので表示しない
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

const MISTAKE_TEXT: Record<CpuLevel, string> = {
  beginner: "整地ミスや無駄な操作が多い",
  easy: "ときどき整地ミスや無駄な操作をする",
  normal: "たまに整地ミスや無駄な操作をする",
  hard: "ミスや無駄な操作はまれ",
  expert: "ミスや無駄な操作をしない",
};

function loadSettings(): Settings {
  const fallback: Settings = {
    mode: "solo",
    myColor: BLACK,
    cpuLevel: "normal",
    restricted: true,
    size: 19,
    undoOnPenalty: true,
    replay: false,
    seed: randomSeed(),
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const settings = { ...fallback, ...saved, seed: fallback.seed };
    if (!isCpuLevel(settings.cpuLevel)) settings.cpuLevel = fallback.cpuLevel;
    return settings;
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
