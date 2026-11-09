import { BLACK, Color, WHITE } from "../core/board";
import { SITE_URL } from "./share";

/**
 * 対局のようすを動画にする（仕様書 §2.11）。
 *
 * 対局中は、盤・アゲハマ・印・CPU のカーソル・タイマーが変わったときだけ、その状態を時刻付きで記録する。
 * 終わったら、その記録を canvas に描き直しながら MediaRecorder で録画する（ブラウザーの中だけで作る）。
 * 映すのは碁盤とアゲハマだけ。タイム（黒・白それぞれ、先に終わった方はそこで止める）は碁盤の上の帯に出し、
 * 最後に結果を重ねる。早送りはせず、
 * 動画は最大 5 分（それより長い対局は動画にしない）。
 */

/** 記録する 1 時点の状態。 */
interface Snapshot {
  /** 記録を始めてからの時刻（ミリ秒）。 */
  t: number;
  cells: Uint8Array;
  trays: Record<Color, number>;
  marks: number[];
  /** CPU のカーソル（盤の点）。 */
  cursors: { label: string; color: string; point: number }[];
  /** タイマー（黒・白それぞれ。ひとりでは 1 つ）。 */
  clocks: RecordedClock[];
}

/** 記録するタイマー。ms はその時点の値（ペナルティ込み）、running は進んでいるか（完了したら止まる）。 */
export interface RecordedClock {
  label: string;
  ms: number;
  running: boolean;
}

export interface RecordedCursor {
  label: string;
  /** カーソルの色（CSS の色）。 */
  color: string;
  point: number | null;
}

export class GameRecorder {
  private readonly snapshots: Snapshot[] = [];
  private startedAt: number | null = null;
  private last = "";

  /** @param rotated 画面で盤を 180° 回して見せているか（動画は黒番から見た向きに戻す） */
  constructor(
    readonly size: number,
    private readonly rotated = false,
  ) {}

  get length(): number {
    return this.snapshots.length;
  }

  /** 状態を記録する（前と同じなら記録しない）。開始の合図より前は記録しない。 */
  capture(state: {
    started: boolean;
    cells: Uint8Array;
    trays: Record<Color, number>;
    marks: Iterable<number>;
    cursors: RecordedCursor[];
    clocks: RecordedClock[];
  }): void {
    if (!state.started) return;
    const now = performance.now();
    this.startedAt ??= now;
    // 盤を 180° 回して見せていたら、点の番号を反転して黒番から見た向きにそろえる
    const last = state.cells.length - 1;
    const flip = (i: number) => (this.rotated ? last - i : i);
    const cells = this.rotated ? state.cells.slice().reverse() : state.cells;
    const cursors = state.cursors
      .filter((c) => c.point !== null)
      .map((c) => ({ label: c.label, color: c.color, point: flip(c.point!) }));
    const marks = [...state.marks].map(flip);
    const key = `${cells.join("")}|${state.trays[BLACK]},${state.trays[WHITE]}|${marks.join(",")}|${cursors
      .map((c) => c.point)
      .join(",")}|${state.clocks.map((c) => (c.running ? "r" : c.ms)).join(",")}`;
    // タイマーだけが進んでいるときは記録しない（再生時に時刻から計算する）
    if (key === this.last) return;
    this.last = key;
    this.snapshots.push({
      t: now - this.startedAt,
      cells: cells.slice(),
      trays: { ...state.trays },
      marks,
      cursors,
      clocks: state.clocks.map((c) => ({ ...c })),
    });
  }

  /** 時刻 t（ミリ秒）の状態（その時刻までの最後の記録）。 */
  at(t: number): Snapshot | null {
    const s = this.snapshots;
    if (s.length === 0) return null;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return s[lo];
  }

  /** 記録の長さ（ミリ秒）。 */
  get duration(): number {
    return this.snapshots.at(-1)?.t ?? 0;
  }
}

export interface VideoOptions {
  /** 最後に出す結果（例: 「整地完了！」と「0:54.6（ペナルティ 1 回）」）。 */
  result: string[];
  onProgress?: (done: number, total: number) => void;
}

export interface VideoFile {
  blob: Blob;
  /** 拡張子（mp4 / webm）。 */
  extension: string;
  type: string;
}

const WIDTH = 720;
/** 上のタイムの帯、碁盤（正方形）、下のアゲハマの帯。 */
const TOP_H = 64;
const BOARD = WIDTH;
const TRAY_H = 80;
const HEIGHT = TOP_H + BOARD + TRAY_H;
const FPS = 30;
/** 最後に結果を出す長さ。 */
const END_MS = 3000;
/** 動画の最大の長さ（対局と最後の結果を合わせて）。 */
export const MAX_VIDEO_MS = 5 * 60_000;

/** この記録を動画にできる長さか（5 分以内）。 */
export function fitsVideo(recorder: GameRecorder): boolean {
  return recorder.length > 0 && recorder.duration + END_MS <= MAX_VIDEO_MS;
}

/** このブラウザーで動画にできるか（canvas の録画と MediaRecorder があるか）。 */
export function canRecordVideo(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    "captureStream" in HTMLCanvasElement.prototype &&
    pickType() !== null
  );
}

/** 使える動画の形式。スマートフォンで扱いやすい MP4 を優先する。 */
function pickType(): { type: string; extension: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    { type: "video/mp4;codecs=avc1", extension: "mp4" },
    { type: "video/mp4", extension: "mp4" },
    { type: "video/webm;codecs=vp9", extension: "webm" },
    { type: "video/webm;codecs=vp8", extension: "webm" },
    { type: "video/webm", extension: "webm" },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.type)) ?? null;
}

/** 記録から動画を作る。作るのに、できあがる動画と同じくらいの時間がかかる。 */
export async function makeVideo(recorder: GameRecorder, options: VideoOptions): Promise<VideoFile> {
  const format = pickType();
  if (!format) throw new Error("このブラウザーは動画の作成に対応していません");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(FPS);
  const media = new MediaRecorder(stream, { mimeType: format.type, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  media.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (media.onstop = () => resolve()));

  if (!fitsVideo(recorder)) throw new Error("5 分を超える対局は動画にできません");
  // 早送りはしない（対局の時間そのまま）
  const playMs = recorder.duration;
  const total = playMs + END_MS;

  draw(ctx, recorder, 0, options, false);
  media.start(250);
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const elapsed = performance.now() - start;
      options.onProgress?.(Math.min(elapsed, total), total);
      if (elapsed >= total) {
        resolve();
        return;
      }
      draw(ctx, recorder, Math.min(elapsed, playMs), options, elapsed >= playMs);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  media.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  const type = format.type.split(";")[0];
  return { blob: new Blob(chunks, { type }), extension: format.extension, type };
}

function draw(ctx: CanvasRenderingContext2D, recorder: GameRecorder, t: number, options: VideoOptions, ending: boolean): void {
  const snap = recorder.at(t);
  ctx.fillStyle = "#f3eee6";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawBoard(ctx, recorder.size, snap);
  if (snap) drawTrays(ctx, snap.trays);

  // タイムは碁盤の上の帯に（黒は左、白は右。ひとりでは左だけ）。完了した方はそこで止まる
  if (snap) {
    ctx.fillStyle = "#2b2620";
    ctx.fillRect(0, 0, WIDTH, TOP_H);
    ctx.textBaseline = "middle";
    snap.clocks.forEach((c, k) => {
      const ms = c.running ? c.ms + (t - snap.t) : c.ms;
      const right = k === 1;
      ctx.textAlign = right ? "right" : "left";
      const x = right ? WIDTH - 20 : 20;
      ctx.font = "22px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
      ctx.fillStyle = "#d8cfc2";
      const label = c.label;
      ctx.fillText(label, x, TOP_H / 2);
      const lw = ctx.measureText(label).width + 12;
      ctx.font = "bold 34px ui-monospace, 'SF Mono', Menlo, monospace";
      ctx.fillStyle = c.running ? "#ffffff" : "#ffd23f";
      ctx.fillText(formatClock(ms), right ? x - lw : x + lw, TOP_H / 2);
    });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  // 最後に結果を重ねる
  if (ending) {
    ctx.fillStyle = "rgba(30, 25, 20, 0.72)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    let y = HEIGHT / 2 - 45 * options.result.length;
    for (const [k, line] of options.result.entries()) {
      ctx.font = k === 0 ? "bold 56px 'Hiragino Sans', 'Noto Sans JP', sans-serif" : "32px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
      ctx.fillText(line, WIDTH / 2, y);
      y += k === 0 ? 84 : 50;
    }
    ctx.font = "bold 26px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
    ctx.fillText("囲碁スピード整地バトル", WIDTH / 2, HEIGHT - 120);
    ctx.font = "24px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
    ctx.fillStyle = "#ffd23f";
    ctx.fillText(SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, ""), WIDTH / 2, HEIGHT - 80);
    ctx.textAlign = "left";
  }
}

const BOARD_X = 0;
const BOARD_Y = TOP_H;

function drawBoard(ctx: CanvasRenderingContext2D, size: number, snap: Snapshot | null): void {
  ctx.fillStyle = "#dcb35c";
  ctx.fillRect(BOARD_X, BOARD_Y, BOARD, BOARD);
  const margin = BOARD / (size + 1);
  const cell = (BOARD - margin * 2) / (size - 1);
  const pos = (i: number) => [BOARD_X + margin + (i % size) * cell, BOARD_Y + margin + Math.floor(i / size) * cell];
  ctx.strokeStyle = "#4a3b22";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let k = 0; k < size; k++) {
    const a = margin + k * cell;
    ctx.moveTo(BOARD_X + margin, BOARD_Y + a);
    ctx.lineTo(BOARD_X + BOARD - margin, BOARD_Y + a);
    ctx.moveTo(BOARD_X + a, BOARD_Y + margin);
    ctx.lineTo(BOARD_X + a, BOARD_Y + BOARD - margin);
  }
  ctx.stroke();
  if (!snap) return;
  const r = cell * 0.47;
  for (let i = 0; i < snap.cells.length; i++) {
    const c = snap.cells[i];
    if (c === 0) continue;
    const [x, y] = pos(i);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = c === BLACK ? "#1c1c1c" : "#fafafa";
    ctx.fill();
    if (c === WHITE) {
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // 間違いの印
  ctx.strokeStyle = "#e0322a";
  ctx.lineWidth = Math.max(2, cell * 0.08);
  for (const i of snap.marks) {
    const [x, y] = pos(i);
    const d = r * 0.6;
    ctx.beginPath();
    ctx.moveTo(x - d, y - d);
    ctx.lineTo(x + d, y + d);
    ctx.moveTo(x + d, y - d);
    ctx.lineTo(x - d, y + d);
    ctx.stroke();
  }
  // CPU のカーソル
  for (const cursor of snap.cursors) {
    const [x, y] = pos(cursor.point);
    ctx.fillStyle = cursor.color;
    ctx.beginPath();
    ctx.moveTo(x - 2, y - 2);
    ctx.lineTo(x + 16, y - 2);
    ctx.lineTo(x - 2, y + 16);
    ctx.closePath();
    ctx.fill();
    ctx.font = "bold 16px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
    const w = ctx.measureText(cursor.label).width + 12;
    ctx.beginPath();
    ctx.roundRect(x + 12, y + 12, w, 22, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(cursor.label, x + 18, y + 15);
  }
}

function drawTrays(ctx: CanvasRenderingContext2D, trays: Record<Color, number>): void {
  const y = TOP_H + BOARD + (TRAY_H - 28) / 2;
  ctx.font = "22px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
  ctx.textBaseline = "middle";
  const items: [string, Color, number][] = [
    ["黒のアゲハマ", WHITE, trays[BLACK]],
    ["白のアゲハマ", BLACK, trays[WHITE]],
  ];
  items.forEach(([label, stone, count], k) => {
    const x = 24 + k * (WIDTH / 2);
    ctx.fillStyle = "#2b2620";
    ctx.fillText(label, x, y + 14);
    ctx.beginPath();
    ctx.arc(x + 150, y + 14, 11, 0, Math.PI * 2);
    ctx.fillStyle = stone === BLACK ? "#1c1c1c" : "#fafafa";
    ctx.fill();
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#2b2620";
    ctx.fillText(`× ${count}`, x + 168, y + 14);
  });
  ctx.textBaseline = "top";
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 100);
  const minutes = Math.floor(total / 600);
  const seconds = Math.floor((total % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${total % 10}`;
}

/** 動画を保存する（スマートフォンでは共有シート、そうでなければダウンロード）。 */
export async function shareOrSaveVideo(video: VideoFile, text: string, preferShare: boolean): Promise<"shared" | "saved"> {
  const name = `go-ssb-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.${video.extension}`;
  const file = new File([video.blob], name, { type: video.type });
  if (preferShare && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], text });
    return "shared";
  }
  const url = URL.createObjectURL(video.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "saved";
}

/** 共有シートで動画を送れるか（スマートフォンなど）。 */
export function canShareVideo(extension: string): boolean {
  if (typeof navigator.canShare !== "function") return false;
  const probe = new File([new Blob([], { type: `video/${extension}` })], `probe.${extension}`, { type: `video/${extension}` });
  return navigator.canShare({ files: [probe] });
}
