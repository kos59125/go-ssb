/**
 * ゲーム中にブラウザーの「戻る」（モバイルの端からのスワイプなど）でページを離れないようにする。
 * 履歴に 1 つ余分な状態を積んでおき、戻る操作（popstate）が来たら積み直してその場にとどまる。
 */

const GUARD = { goSsbGuard: true };
let blocking = false;
let installed = false;

function onPopState(): void {
  if (blocking) history.pushState(GUARD, "");
}

/** 戻るを無効にする（ゲームの画面に入るとき）。 */
export function blockBack(): void {
  if (!installed) {
    window.addEventListener("popstate", onPopState);
    installed = true;
  }
  blocking = true;
  if (!(history.state as typeof GUARD | null)?.goSsbGuard) history.pushState(GUARD, "");
}

/** 戻るを有効に戻す（設定画面などに戻るとき）。積んでおいた状態は取り除く。 */
export function allowBack(): void {
  if (!blocking) return;
  blocking = false;
  if ((history.state as typeof GUARD | null)?.goSsbGuard) history.back();
}
