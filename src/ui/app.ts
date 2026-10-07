import { GameGenerator } from "../ai/client";
import { GeneratedGame } from "../ai/generate";
import { GoGame } from "../ai/go";
import { GameRecord, parseSgf } from "../ai/sgf";
import { Position, analyze } from "../core/analysis";
import { BLACK, Board, Color, EMPTY, WHITE, opponent } from "../core/board";
import { mulberry32, randomSeed, seedNumber } from "../core/random";
import { dummyPosition } from "../game/dummy";
import { DEFAULT_SHAPE_RULES, type ShapeRules } from "../core/shapes";
import { CPU_LEVELS, Cpu, CpuAction, CpuLevel, isCpuLevel } from "../game/cpu";
import { planLayout, planLayouts, SerializedLayout } from "../game/layout";
import { DEFAULT_HAND_LIMIT, Match, Player, byDistanceFrom } from "../game/match";
import { PENALTY_MS, Session } from "../game/session";
import { BoardView } from "./boardView";
import { TRAY_SLOTS, TrayView } from "./trayView";
import { CpuResult, addCpuRecord, addSoloRecord, loadScores, soloRanking } from "./scores";

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
  /** 一度に持てる石の数の上限（ひとりで）。 */
  handLimit: number;
  /** vs CPU で、黒・白それぞれが一度に持てる石の数の上限。 */
  handLimits: Record<Color, number>;
  /** 整地ルール（1 列の区間、5 × 奇数）。 */
  shapeRules: ShapeRules;
  /** 開始時に初手から棋譜を並べるか（仕様書 §5.1）。 */
  replay: boolean;
  /** 終局図を作るシード。保存せず、画面を開くたびにランダムに決める。 */
  seed: string;
  /** 読み込んだ実戦の棋譜（SGF）。あればシードの代わりにこれを使う。保存しない。 */
  record?: GameRecord;
}

/** CPU のカーソルが操作する場所へ動く時間（CSS の .cpu-cursor の transition と合わせる）。 */
const CURSOR_TRAVEL_MS = 250;

/** 棋譜の再生にかける時間。 */
const REPLAY_MS = 10_000;

const generator = new GameGenerator();

const SETTINGS_KEY = "go-ssb:settings";

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
  const levels = Object.keys(CPU_LEVELS) as CpuLevel[];
  root.replaceChildren(
    h("main", { class: "settings" }, [
      h("h1", {}, ["囲碁スピード整地バトル"]),
      settingGroup("対戦", [
        setting(
          "モード",
          radios("mode", [
            { value: "solo", label: "ひとりで", checked: settings.mode === "solo" },
            { value: "cpu", label: "vs CPU", checked: settings.mode === "cpu" },
          ]),
          "ひとりで: 黒地と白地を両方整地して、タイムを競います。\nvs CPU: 相手の地を整地します。ペナルティ込みのタイムが短い方が勝ちです。",
        ),
        setting(
          "自分の石",
          radios("my-color", [
            { value: "black", label: "黒（白地を整地）", checked: settings.myColor === BLACK },
            { value: "white", label: "白（黒地を整地）", checked: settings.myColor === WHITE },
          ]),
          "囲碁の慣例どおり、相手の地を整地します。白のときは盤を 180° 回して表示します。",
          "cpu-only",
        ),
        setting(
          "CPU の強さ",
          radios(
            "cpu-level",
            levels.map((level) => ({ value: level, label: CPU_LEVELS[level].label, checked: settings.cpuLevel === level })),
          ),
          "強さによって、CPU が 1 回操作する間隔と、ミスの多さが変わります。\n" +
            levels.map((level) => `${CPU_LEVELS[level].label}: ${CPU_LEVELS[level].interval / 1000} 秒ごと、${MISTAKE_TEXT[level]}`).join("\n"),
          "cpu-only",
        ),
      ]),
      settingGroup("盤面", [
        setting(
          "終局図",
          radios("source", [
            { value: "katago", label: "自動で作る", checked: !settings.record },
            { value: "sgf", label: "SGF を読み込む", checked: !!settings.record },
          ]),
          "自動で作る: KataGo の自動対局でその場で作ります。初回はネットワーク（約 4 MB）を読み込みます。\nSGF を読み込む: 終局済みの実戦の棋譜で遊びます。",
        ),
        setting(
          "SGF ファイル",
          [
            h("input", { type: "file", id: "sgf-file", accept: ".sgf,application/x-go-sgf" }, []),
            h("p", { class: "note", id: "sgf-info" }, [settings.record ? recordLabel(settings.record) : "終局済みの棋譜を選んでください。"]),
          ],
          undefined,
          "sgf-only",
        ),
        setting(
          "盤のサイズ",
          radios("size", [
            { value: "19", label: "19 路", checked: settings.size === 19, disabled: small },
            { value: "13", label: "13 路", checked: settings.size === 13 },
            { value: "9", label: "9 路", checked: settings.size === 9 },
          ]),
          undefined,
          "katago-only",
        ),
        setting(
          "シード",
          [
            h("input", { type: "text", id: "seed", value: settings.seed, spellcheck: "false", autocomplete: "off" }, []),
            h("button", { type: "button", id: "reseed" }, ["別のシード"]),
          ],
          "同じ盤サイズとシードなら同じ終局図になります。画面を開くたびにランダムな値が入ります。",
          "katago-only seed-setting",
        ),
        setting(
          "開始時の表示",
          radios("start", [
            { value: "final", label: "終局図から", checked: !settings.replay },
            { value: "replay", label: "初手から並べる", checked: settings.replay },
          ]),
          "初手から並べる: 棋譜を 10 秒で再生してから整地を始めます。",
        ),
      ]),
      settingGroup("整地ルール", [
        setting(
          "1 列の区間",
          radios("one-line", [
            { value: "off", label: "制限なし", checked: settings.shapeRules.oneLineFrom === null },
            { value: "10", label: "10 目以上は禁止", checked: settings.shapeRules.oneLineFrom === 10 },
            { value: "5", label: "5 目以上は禁止", checked: settings.shapeRules.oneLineFrom === 5 },
          ]),
          "1 列（幅か高さが 1）の区間を認めるかどうかです。\n" +
            "10 目以上は禁止: 1x10 などは不可（2x5、3x4−2 などにする）。\n" +
            "5 目以上は禁止: 加えて、5〜9 目の余りも 2 列以上にする（例: 2x2+1、2x3、3x3）。\n" +
            "CPU は設定によらず、できるだけ 1 列の区間を作りません。",
        ),
        setting(
          "5 × 奇数",
          radios("five-by-odd", [
            { value: "off", label: "認めない", checked: !settings.shapeRules.allowFiveByOdd },
            { value: "on", label: "認める", checked: settings.shapeRules.allowFiveByOdd },
          ]),
          "認める: 3x5 = 15 目、5x5 = 25 目のような、一辺が 5 で他方が奇数の矩形も区間として数えます。",
        ),
      ]),
      settingGroup("操作", [
        setting(
          "一度に持てる石",
          [
            h("label", { class: "solo-only" }, [handLimitInput("hand-limit", settings.handLimit), "個"]),
            h("label", { class: "cpu-only" }, ["黒", handLimitInput("hand-limit-black", settings.handLimits[BLACK]), "個"]),
            h("label", { class: "cpu-only" }, ["白", handLimitInput("hand-limit-white", settings.handLimits[WHITE]), "個"]),
          ],
          `範囲選択やトレイから、一度に持てる石の数の上限です（1〜${MAX_HAND_LIMIT} 個、初期値 ${DEFAULT_HAND_LIMIT} 個）。上限を超えるときは、選び始めた点に近い石から持ちます。\n` +
            "vs CPU では黒・白それぞれに設定でき、CPU にも適用します（CPU は強さに応じた数とこの上限の少ない方まで持ちます）。",
        ),
        setting(
          "担当外の石の操作",
          radios("restricted", [
            { value: "on", label: "制限あり", checked: settings.restricted },
            { value: "off", label: "制限なし", checked: !settings.restricted },
          ]),
          "担当外の石とは、あなたが整地しない側の石です。vs CPU では、あなたは CPU の地を、CPU はあなたの地を整地します。\n" +
            "制限あり: 動かせるのは相手の色の石と、相手の石に接している自分の色の石（黒白の境界線の石）だけです。自分の地の側の石（例: 自分の石の塊の中央）は動かせません。CPU が整地しているあなたの地には石を置けません。\n" +
            "制限なし: どの石も動かせます（CPU の整地を邪魔することもできます）。",
          "cpu-only",
        ),
        setting(
          "ペナルティ時の石",
          radios("undo", [
            { value: "undo", label: "元に戻す", checked: settings.undoOnPenalty },
            { value: "keep", label: "そのまま（印を付ける）", checked: !settings.undoOnPenalty },
          ]),
          "地の目数が変わる置き方をすると、+5 秒のペナルティになります（例: アゲハマを相手の地に置いた、境界を崩したまま閉じた）。\n" +
            "元に戻す: ペナルティになった石を、自動で元の場所に戻します。\n" +
            "そのまま: 石は動かさず、間違えた場所に×印を付けます。自分で直すと印は消えます。",
        ),
      ]),
      h("button", { id: "start-button", class: "primary" }, ["スタート"]),
      h("button", { id: "scoreboard-button", type: "button" }, ["スコアボード"]),
      h("p", { class: "links" }, [h("a", { href: "https://github.com/kos59125/go-ssb/blob/main/docs/rulebook.md", target: "_blank" }, ["ルールブック"])]),
    ]),
  );
  const selected = (name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
  root.querySelector("#scoreboard-button")!.addEventListener("click", () => {
    window.clearTimeout(seedTimer);
    showScoreboard(root, Number(selected("size")), selected("mode") === "cpu" ? "cpu" : "solo");
  });
  const seedInput = root.querySelector<HTMLInputElement>("#seed")!;
  const sgfInfo = root.querySelector<HTMLParagraphElement>("#sgf-info")!;
  const startButton = root.querySelector<HTMLButtonElement>("#start-button")!;
  let record = settings.record;
  const isCpu = () => selected("mode") === "cpu";
  const updateMode = () => {
    for (const el of root.querySelectorAll<HTMLElement>(".cpu-only")) el.hidden = !isCpu();
    for (const el of root.querySelectorAll<HTMLElement>(".solo-only")) el.hidden = isCpu();
  };
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    input.addEventListener("change", updateMode);
  }
  // SGF のときは、盤のサイズとシードは棋譜で決まるので表示しない
  const updateSource = () => {
    const sgf = selected("source") === "sgf";
    for (const el of root.querySelectorAll<HTMLElement>(".sgf-only")) el.hidden = !sgf;
    for (const el of root.querySelectorAll<HTMLElement>(".katago-only")) el.hidden = sgf;
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
  const shapeRules = (): ShapeRules => ({
    oneLineFrom: selected("one-line") === "off" ? null : Number(selected("one-line")),
    allowFiveByOdd: selected("five-by-odd") === "on",
  });
  function prefetch() {
    if (!dummySeed() && seedInput.value.trim()) {
      generator.prefetch(Number(selected("size")), seedNumber(seedInput.value), true, shapeRules());
    }
  }
  updateMode();
  prefetch();
  // 整地ルールが変わると、CPU が整地できる局面も変わる
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="size"], input[name="one-line"], input[name="five-by-odd"]')) {
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
      handLimit: readHandLimit(root, "hand-limit"),
      handLimits: { [BLACK]: readHandLimit(root, "hand-limit-black"), [WHITE]: readHandLimit(root, "hand-limit-white") },
      shapeRules: shapeRules(),
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
    showGame(root, settings, position, nextSeed, planLayouts(position, settings.shapeRules));
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
      ? await generator.fromRecord(settings.record, forCpu, settings.shapeRules)
      : await generator.take(settings.size, seed, forCpu, settings.shapeRules, (move) => (status.textContent = `自動対局中… ${move} 手目`));
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
      showGame(root, settings, position, nextSeed, planLayouts(position, settings.shapeRules));
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
  if (!settings.record) generator.prefetch(settings.size, seedNumber(nextSeed), forCpu, settings.shapeRules);
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
  | {
      kind: "board";
      start: number;
      current: number;
      /** 石を持って空点を押した（離した点、またはなぞった点に置く）。 */
      dropping: boolean;
      button: number;
      /** なぞって置いている途中か（押した点から別の点へ動かした）。 */
      swiping?: boolean;
      /** なぞって最後に通った点。 */
      last?: number;
    }
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
    const match = new Match(position, { undoOnPenalty: settings.undoOnPenalty, shapeRules: settings.shapeRules });
    session = new Player(match, { color: myColor, restricted: settings.restricted, handLimit: settings.handLimits[myColor] });
    // CPU は人の地（myColor の地）を整地する
    // CPU のミスや無駄な操作の乱数は、終局図のシードとは別に毎回ランダムに決める
    cpu = new Cpu(new Player(match, { color: cpuColor, handLimit: settings.handLimits[cpuColor] }), layouts ?? {}, {
      level: settings.cpuLevel,
      random: mulberry32(seedNumber(randomSeed())),
    });
  } else {
    session = new Session(position, {
      undoOnPenalty: settings.undoOnPenalty,
      handLimit: settings.handLimit,
      shapeRules: settings.shapeRules,
    });
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
        settings.record ? h("p", { class: "note seed-note" }, [`棋譜: ${recordLabel(settings.record)}`]) : seedNote(settings.seed),
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
    if (session.handRoom <= 0) {
      notice(`一度に持てる石は ${session.handLimit} 個までです。`);
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
    if (session.handRoom <= 0 && points.some((i) => session.board.cells[i] !== EMPTY)) {
      notice(`一度に持てる石は ${session.handLimit} 個までです。`);
      return;
    }
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

  /** なぞって置く: 通った空点に、持っている石を 1 個ずつ置く（石のある点は飛ばす）。 */
  const swipeTo = (to: number) => {
    if (drag?.kind !== "board") return;
    const color = colorFor(drag.button);
    const before = session.penalties;
    const from = drag.last ?? drag.start;
    // 速く動かしたときに飛ばした点も通ったことにする
    const path = drag.swiping ? linePoints(settings.size, from, to).slice(1) : linePoints(settings.size, from, to);
    drag.swiping = true;
    for (const i of path) {
      if (!session.hand) break;
      if (session.board.cells[i] === EMPTY) session.placeAt(i, color);
    }
    drag.last = to;
    penaltyCheck(before);
    render();
  };

  // --- 動かす ---
  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (drag?.kind === "board") {
      const i = view.pointAt(e.clientX, e.clientY);
      if (i !== null) drag.current = i;
      // 石を持って空点を押したまま別の点へ動かすと、なぞった点に置いていく
      if (drag.dropping && session.hand && session.phase === "arrange" && i !== null && i !== (drag.last ?? drag.start)) {
        swipeTo(i);
      }
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
      if (drag.swiping) {
        // なぞって置いた後: トレイの上で離したら、残りの石を入れる
        if (tray !== null && session.hand) dropToTray(tray);
      } else if (!drag.dropping && drag.current !== drag.start) {
        // 範囲選択（押した点が空点でも石でもよい）。持っている石に追加する
        // 持てる数の上限を超えるときは、起点（押した点）に近い石から持つ
        pickUp(byDistanceFrom(settings.size, pointsInRect(settings.size, drag.start, drag.current), drag.start));
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
        // トレイがいっぱい（空いたマスがない）ときに石を持っていれば、クリックで入れる
        const onStone = start >= 0 && start < count;
        const full = count >= TRAY_SLOTS;
        if (onStone && !(session.hand && (session.phase === "removal" || full))) pickFromTray(owner, 1);
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
    // 持っている石は元に戻す。ここまでの整地は、正しい状態（境界が閉じていて目数が変わっていない）で
    // CPU が続きを計画できれば引き継ぐ。できなければ自分の操作をすべて元に戻し、死に石取りからやり直す
    session.cancel();
    if (!session.canHandOver() || !canPlanAll(session)) session.revertAll();
    if (cpuMode && !decided) recordCpuGame("giveup");
    if (cpuMode) decided = true;
    phaseLabel.textContent = cpuMode ? "ギブアップ（CPU の勝ち）。CPU が代わりに整地しています…" : "ギブアップ。CPU が代わりに整地しています…";
    showGiveUpResult();
    const auto = new Cpu(session, layouts ?? {});
    autoCursor.hidden = false;
    moveCursor(autoCursor, auto, null);
    let idle = 0;
    let busy = false;
    const autoTimer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      cpuTurn(autoCursor, auto, (action) => {
        busy = false;
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
      });
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
      h("div", { class: "buttons" }, [again, back, scoreboardButton()]),
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

  /** 記録に残す設定（このゲームのシード・棋譜を含む）。「再プレイ」で同じゲームを始めるのに使う。 */
  const replaySettings = (): Settings => ({ ...settings });
  /** vs CPU の戦績を残す。 */
  const recordCpuGame = (result: CpuResult) => {
    addCpuRecord<Settings>({
      date: Date.now(),
      result,
      size: settings.size,
      myTime: session.phase === "finished" ? session.elapsed() : null,
      cpuTime: cpuPlayer?.phase === "finished" ? cpuPlayer.elapsed() : null,
      penalties: session.penalties,
      settings: replaySettings(),
    });
  };
  const scoreboardButton = () => {
    const button = h("button", {}, ["スコアボード"]);
    button.addEventListener("click", () => {
      leave();
      showScoreboard(root, settings.size, cpuMode ? "cpu" : "solo");
    });
    return button;
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
      recordCpuGame(winner === "me" ? "win" : "lose");
    } else {
      phaseLabel.textContent = "整地完了！";
      const time = session.elapsed();
      const rank = addSoloRecord<Settings>({
        time,
        penalties: session.penalties,
        date: Date.now(),
        size: settings.size,
        settings: replaySettings(),
      });
      const best = soloRanking(loadScores<Settings>(), settings.size)[0];
      lines.push(
        h("p", {}, [
          rank === 1
            ? `${settings.size} 路のベストタイム更新！`
            : rank !== null
              ? `${settings.size} 路の ${rank} 位（ベスト ${formatTime(best.time)}）`
              : `${settings.size} 路のベスト: ${formatTime(best.time)}`,
        ]),
      );
    }
    resultBox.replaceChildren(
      h("p", {}, [`黒 ${session.initialScores[BLACK]} 目・白 ${session.initialScores[WHITE]} 目`]),
      ...lines,
      h("div", { class: "buttons" }, [again, back, scoreboardButton()]),
    );
    resultBox.hidden = false;
  };

  // --- CPU ---
  let cpuWaiting = false;
  /** CPU のカーソルを、操作した点（またはトレイ）へ動かす。 */
  const moveCpuCursor = (action: CpuAction | null) => {
    if (cpu) moveCursor(cpuCursor, cpu, action);
  };
  const moveCursor = (cursor: HTMLElement, cpu: Cpu, action: CpuAction | null) => {
    let target: { x: number; y: number } | null = null;
    if (action && "point" in action) {
      const box = view.svg.getBoundingClientRect();
      const { x, y } = view.pointBox(action.point);
      target = { x: box.left + x, y: box.top + y };
    } else if (action?.kind === "pick-tray" || action?.kind === "drop-tray") {
      const box = trays[action.owner].view.svg.getBoundingClientRect();
      target = { x: box.left + 20, y: box.top + 15 };
    } else if (!cursor.style.transform) {
      const box = view.svg.getBoundingClientRect();
      target = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    if (target) cursor.style.transform = `translate(${target.x}px, ${target.y}px)`;
    showHeld(cursor, cpu);
  };
  /** カーソルに、CPU が持っている石を表示する。 */
  const showHeld = (cursor: HTMLElement, cpu: Cpu) => {
    const held = cpu.player.hand?.stones[0];
    cursor.classList.toggle("holding-black", held?.color === BLACK);
    cursor.classList.toggle("holding-white", held?.color === WHITE);
  };

  /**
   * CPU の 1 回の操作。先にカーソルを操作する場所へ動かし、着いてから（CURSOR_TRAVEL_MS 後に）
   * 盤やトレイの石を動かす。石がカーソルより先に動いて見えないようにするため。
   */
  const cpuTurn = (cursor: HTMLElement, player: Cpu, after: (action: CpuAction) => void) => {
    const plan = player.decide();
    moveCursor(cursor, player, plan.action);
    const finish = () => {
      plan.run?.();
      showHeld(cursor, player);
      after(plan.action);
    };
    if (plan.action.kind === "idle") {
      finish();
      return;
    }
    const timer = window.setTimeout(() => {
      pendingTimers.delete(timer);
      finish();
    }, CURSOR_TRAVEL_MS);
    pendingTimers.add(timer);
  };
  const pendingTimers = new Set<number>();
  cleanups.push(() => {
    for (const timer of pendingTimers) window.clearTimeout(timer);
  });

  const startCpu = () => {
    if (!cpu) return;
    let busy = false;
    const timer = window.setInterval(() => {
      // 勝敗が決まったら止める（ギブアップのときは、盤を仕上げるために最後まで続ける）
      if (busy || (decided && gaveUpAt === null)) return;
      if (cpu!.player.phase === "finished") return;
      busy = true;
      const before = session.penalties;
      const cpuBefore = cpu!.player.penalties;
      cpuTurn(cpuCursor, cpu!, (action) => {
        busy = false;
        cpuWaiting = action.kind === "idle" && cpu!.player.phase === "arrange";
        penaltyCheck(before);
        if (gaveUpAt === null && cpu!.player.penalties > cpuBefore) notice(`CPU がミスしました（+${PENALTY_MS / 1000} 秒）`);
        render();
        decide();
      });
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
  return h("legend", {}, [text, helpIcon(text, help)]);
}

/** 「?」に重ねると説明の吹き出しを出す。 */
function helpIcon(text: string, help: string): HTMLElement {
  return h("span", { class: "help", tabindex: "0", role: "button", "aria-label": `${text}の説明` }, [
    "?",
    h("span", { class: "help-bubble", role: "tooltip" }, [help]),
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
/** 設定のまとまり（見出しと枠）。 */
function settingGroup(title: string, rows: HTMLElement[]): HTMLElement {
  return h("section", { class: "setting-group" }, [h("h2", {}, [title]), ...rows]);
}

/** 設定の 1 項目（名前と選択肢）。help があれば名前の横に「?」を出す。 */
function setting(label: string, content: (Node | string)[], help?: string, className?: string): HTMLElement {
  return h("div", { class: className ? `setting ${className}` : "setting", role: "group", "aria-label": label }, [
    h("div", { class: "setting-label" }, help ? [label, helpIcon(label, help)] : [label]),
    h("div", { class: "setting-options" }, content),
  ]);
}

/** ラジオボタンの選択肢。 */
function radios(name: string, options: { value: string; label: string; checked: boolean; disabled?: boolean }[]): HTMLElement[] {
  return options.map((o) =>
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
  );
}

/** 担当の地のすべてで、今の盤から整地の形が見つかるか（死に石取りの途中なら見つかるものとする）。 */
function canPlanAll(player: Player): boolean {
  if (player.phase !== "arrange") return true;
  return player.assigned.every(
    (c) => planLayout(player.board, c, player.position.trays[opponent(c)], 20_000, player.match.shapeRules) !== null,
  );
}

/** 一度に持てる石の数の上限として選べる最大値。 */
const MAX_HAND_LIMIT = 99;

function clampHandLimit(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_HAND_LIMIT, n) : DEFAULT_HAND_LIMIT;
}

function handLimitInput(id: string, value: number): HTMLInputElement {
  return h("input", { type: "number", id, min: "1", max: String(MAX_HAND_LIMIT), step: "1", value: String(value), inputmode: "numeric" }, []);
}

function readHandLimit(root: HTMLElement, id: string): number {
  return clampHandLimit(root.querySelector<HTMLInputElement>(`#${id}`)!.value);
}

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

/** 2 点を結ぶ線上の点（両端を含む、ブレゼンハムの方法）。 */
function linePoints(size: number, a: number, b: number): number[] {
  let [x, y] = [a % size, Math.floor(a / size)];
  const [x2, y2] = [b % size, Math.floor(b / size)];
  const dx = Math.abs(x2 - x);
  const dy = -Math.abs(y2 - y);
  const sx = x < x2 ? 1 : -1;
  const sy = y < y2 ? 1 : -1;
  let err = dx + dy;
  const points = [y * size + x];
  while (x !== x2 || y !== y2) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    points.push(y * size + x);
  }
  return points;
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
  beginner: "石は 1 個ずつ、整地ミスや無駄な操作が多い",
  easy: "石は 1 個ずつ、ときどき整地ミスや無駄な操作をする",
  normal: "石を 2 個まで持つ、たまに整地ミスや無駄な操作をする",
  hard: "石を 4 個まで持つ、ミスや無駄な操作はまれ",
  expert: "石を 6 個まで持つ、ミスや無駄な操作をしない",
};

function defaultSettings(): Settings {
  return {
    mode: "solo",
    myColor: BLACK,
    cpuLevel: "normal",
    restricted: true,
    size: 19,
    undoOnPenalty: true,
    handLimit: DEFAULT_HAND_LIMIT,
    handLimits: { [BLACK]: DEFAULT_HAND_LIMIT, [WHITE]: DEFAULT_HAND_LIMIT },
    shapeRules: DEFAULT_SHAPE_RULES,
    replay: false,
    seed: randomSeed(),
  };
}

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return normalizeSettings({ ...saved, seed: undefined });
  } catch {
    return defaultSettings();
  }
}

/** 保存した設定（古い形式や壊れた値を含みうる）を、使える設定にする。 */
function normalizeSettings(saved: Partial<Settings>): Settings {
  const fallback = defaultSettings();
  try {
    const settings: Settings = { ...fallback, ...saved, seed: saved.seed ?? fallback.seed };
    if (!isCpuLevel(settings.cpuLevel)) settings.cpuLevel = fallback.cpuLevel;
    settings.handLimit = clampHandLimit(settings.handLimit);
    const rules: Partial<ShapeRules> = saved.shapeRules ?? {};
    settings.shapeRules = {
      oneLineFrom: rules.oneLineFrom === 5 || rules.oneLineFrom === 10 ? rules.oneLineFrom : null,
      allowFiveByOdd: rules.allowFiveByOdd === true,
    };
    settings.handLimits = {
      [BLACK]: clampHandLimit(settings.handLimits?.[BLACK]),
      [WHITE]: clampHandLimit(settings.handLimits?.[WHITE]),
    };
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

const RESULT_LABEL: Record<CpuResult, string> = { win: "勝ち", lose: "負け", giveup: "ギブアップ" };

/**
 * スコアボード（仕様書 §2.9）。ひとりでモードは盤のサイズごとのベストタイム上位 10 件、
 * vs CPU は直近 10 戦。「再プレイ」で、その記録と同じ設定（シード・整地ルール・棋譜など）で始める。
 */
function showScoreboard(root: HTMLElement, size: number, tab: "solo" | "cpu"): void {
  const scores = loadScores<Settings>();
  const replayButton = (saved: Settings) => {
    const button = h("button", { type: "button", class: "replay" }, ["再プレイ"]);
    button.addEventListener("click", () => {
      const settings = normalizeSettings(saved);
      saveSettings(settings);
      void prepareGame(root, settings);
    });
    return button;
  };
  const source = (r: { settings: Settings }) =>
    r.settings.record ? `棋譜: ${recordLabel(r.settings.record)}` : `シード ${r.settings.seed}`;
  const rulesLabel = (r: { settings: Settings }) => {
    const rules = normalizeSettings(r.settings).shapeRules;
    const parts: string[] = [];
    if (rules.oneLineFrom !== null) parts.push(`1 列は ${rules.oneLineFrom} 目以上禁止`);
    if (rules.allowFiveByOdd) parts.push("5 × 奇数あり");
    return parts.join("・");
  };
  const detail = (r: { settings: Settings }) =>
    h("div", { class: "score-detail" }, [source(r), ...(rulesLabel(r) ? [` ・ ${rulesLabel(r)}`] : [])]);

  // ひとりで: 盤のサイズのタブ
  const sizes = [19, 13, 9];
  let current = sizes.includes(size) ? size : 19;
  const soloBody = h("div", {}, []);
  const sizeTabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    sizes.map((n) => {
      const b = h("button", { type: "button", role: "tab", "data-size": String(n) }, [`${n} 路`]);
      b.addEventListener("click", () => {
        current = n;
        renderSolo();
      });
      return b;
    }),
  );
  const renderSolo = () => {
    for (const b of sizeTabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.size === String(current)));
    const ranking = soloRanking(scores, current);
    soloBody.replaceChildren(
      ranking.length === 0
        ? h("p", { class: "note" }, ["まだ記録がありません。"])
        : h("ol", { class: "score-list" }, ranking.map((r, k) =>
            h("li", {}, [
              h("span", { class: "score-rank" }, [`${k + 1}`]),
              h("div", { class: "score-main" }, [
                h("div", { class: "score-head" }, [
                  h("strong", { class: "score-time" }, [formatTime(r.time)]),
                  h("span", {}, [r.penalties > 0 ? `ペナルティ ${r.penalties} 回` : "ペナルティなし"]),
                  h("span", { class: "score-date" }, [formatDate(r.date)]),
                ]),
                detail(r),
              ]),
              replayButton(r.settings),
            ]),
          )),
    );
  };

  const cpuList =
    scores.cpu.length === 0
      ? h("p", { class: "note" }, ["まだ記録がありません。"])
      : h("ol", { class: "score-list cpu" }, scores.cpu.map((r) =>
          h("li", {}, [
            h("span", { class: `score-result ${r.result}` }, [RESULT_LABEL[r.result]]),
            h("div", { class: "score-main" }, [
              h("div", { class: "score-head" }, [
                h("strong", {}, [`CPU ${CPU_LEVELS[r.settings.cpuLevel]?.label ?? r.settings.cpuLevel}`]),
                h("span", {}, [`${r.settings.myColor === BLACK ? "黒" : "白"}番・${r.size} 路`]),
                h("span", {}, [`あなた ${r.myTime === null ? "未完了" : formatTime(r.myTime)}・CPU ${r.cpuTime === null ? "未完了" : formatTime(r.cpuTime)}`]),
                h("span", { class: "score-date" }, [formatDate(r.date)]),
              ]),
              detail(r),
            ]),
            replayButton(r.settings),
          ]),
        ));

  const soloSection = h("section", { class: "setting-group" }, [h("h2", {}, ["ひとりで（ベストタイム）"]), sizeTabs, soloBody]);
  const cpuSection = h("section", { class: "setting-group" }, [h("h2", {}, ["vs CPU（直近 10 戦）"]), cpuList]);
  const back = h("button", { type: "button" }, ["設定に戻る"]);
  back.addEventListener("click", () => showSettings(root, loadSettings()));
  root.replaceChildren(
    h("main", { class: "settings scoreboard" }, [
      h("h1", {}, ["スコアボード"]),
      ...(tab === "cpu" ? [cpuSection, soloSection] : [soloSection, cpuSection]),
      h("p", { class: "note" }, ["記録はこのブラウザーにだけ保存されます。"]),
      back,
    ]),
  );
  renderSolo();
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ゲーム画面のシードの表示。文字を選択でき、ボタンでコピーできる。 */
function seedNote(seed: string): HTMLElement {
  const copy = h("button", { type: "button", class: "copy-seed", title: "シードをコピー" }, ["コピー"]);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(seed);
      copy.textContent = "コピーしました";
    } catch {
      // クリップボードが使えないときは、文字を選択した状態にする
      const range = document.createRange();
      range.selectNodeContents(value);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      copy.textContent = "選択しました";
    }
    window.setTimeout(() => (copy.textContent = "コピー"), 1500);
  });
  const value = h("span", { class: "seed-value" }, [seed]);
  return h("p", { class: "note seed-note" }, ["シード: ", value, " ", copy]);
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
