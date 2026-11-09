import { BLACK, Color, opponent } from "../core/board";
import { TrayView } from "./trayView";

/** 画面の部品を作る小さな関数（設定・対局・観戦の画面で共有する）。 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 100);
  const minutes = Math.floor(total / 600);
  const seconds = Math.floor((total % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${total % 10}`;
}

/** CPU のカーソル（矢印と名前）。 */
export function makeCursor(label: string): HTMLDivElement {
  return h("div", { class: "cpu-cursor" }, [h("span", { class: "cpu-cursor-label" }, [label])]);
}

/** who: 対戦でのトレイの持ち主の呼び名（「あなた」「CPU」）。 */
export function trayElement(owner: Color, who?: string) {
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
