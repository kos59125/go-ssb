import { h } from "./dom";
import { shareOnX, xShareText } from "./share";
import { GameRecorder, MAX_VIDEO_MS, VideoFile, canRecordVideo, canShareVideo, fitsVideo, makeVideo, shareOrSaveVideo } from "./recorder";

/**
 * 対局のようすを動画にするダイアログ。作っている間は進み具合を出し、できたら見られるようにして、
 * 共有（スマートフォンの共有シート）と保存のボタンを出す。
 */
export function openVideoDialog(root: HTMLElement, recorder: GameRecorder, result: string[], shareText: string): void {
  const dialog = h("dialog", { class: "result-dialog video-dialog" }, []);
  const status = h("p", {}, ["動画を作っています…"]);
  const bar = h("progress", { max: "1", value: "0" }, []);
  const close = h("button", { type: "button" }, ["閉じる"]);
  const buttons = h("div", { class: "buttons" }, [close]);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(h("h2", {}, ["動画を保存"]), status, bar, buttons);
  root.append(dialog);
  dialog.showModal();

  if (!canRecordVideo()) {
    status.textContent = "このブラウザーは動画の作成に対応していません。";
    bar.remove();
    return;
  }
  let cancelled = false;
  dialog.addEventListener("close", () => (cancelled = true));
  void makeVideo(recorder, {
    result,
    shouldStop: () => cancelled,
    onProgress: (done, total) => {
      bar.value = done / total;
      status.textContent = `動画を作っています… ${Math.floor(done / 1000)} / ${Math.ceil(total / 1000)} 秒`;
    },
  })
    .then((video: VideoFile) => {
      if (cancelled) return;
      bar.remove();
      status.textContent = `できました（${video.extension.toUpperCase()}、${(video.blob.size / 1024 / 1024).toFixed(1)} MB）。`;
      const preview = h("video", { controls: "", playsinline: "", muted: "", class: "video-preview" }, []);
      preview.src = URL.createObjectURL(video.blob);
      status.after(preview);
      const save = h("button", { type: "button" }, ["保存"]);
      save.addEventListener("click", () => void shareOrSaveVideo(video, shareText, false));
      // X でシェア: スマートフォンでは共有シートで動画と文を送る（X を選ぶ）。動画を送れない環境では、
      // 動画を保存してから X の投稿画面を開く（保存した動画を添付してもらう）
      const share = h("button", { type: "button", class: "share-x" }, ["X でシェア"]);
      share.addEventListener("click", () => {
        if (canShareVideo(video.extension)) {
          shareOrSaveVideo(video, xShareText(shareText), true).catch(() => {
            // 共有シートを閉じただけなら何もしない
          });
        } else {
          void shareOrSaveVideo(video, shareText, false).then(() => shareOnX(shareText));
        }
      });
      buttons.prepend(share, save);
    })
    .catch((err) => {
      if (cancelled) return;
      bar.remove();
      status.textContent = `動画を作れませんでした: ${err instanceof Error ? err.message : err}`;
    });
}

/**
 * 「動画を保存」ボタン。動画にできないとき（5 分を超える対局、対応していないブラウザー）は押せないようにして、
 * 理由を添える。
 */
export function videoButton(root: HTMLElement, recorder: GameRecorder, result: () => string[], shareText: () => string): HTMLElement {
  const button = h("button", { type: "button" }, ["動画を保存"]);
  const reason = !canRecordVideo()
    ? "このブラウザーは動画の作成に対応していません。"
    : !fitsVideo(recorder)
      ? `${MAX_VIDEO_MS / 60_000} 分を超える対局は動画にできません。`
      : null;
  if (reason) {
    button.setAttribute("disabled", "");
    return h("span", { class: "video-button" }, [button, h("small", { class: "note" }, [reason])]);
  }
  button.addEventListener("click", () => openVideoDialog(root, recorder, result(), shareText()));
  return button;
}

