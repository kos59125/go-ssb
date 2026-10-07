/** 公開しているページ（シェアのリンク先、OGP の URL）。 */
export const SITE_URL = "https://kos59125.github.io/go-ssb/";
const HASHTAG = "囲碁スピード整地バトル";

/** X（旧 Twitter）の投稿画面の URL。 */
export function xShareUrl(text: string): string {
  const params = new URLSearchParams({ text, url: SITE_URL, hashtags: HASHTAG });
  return `https://x.com/intent/post?${params}`;
}

/** X の投稿画面を新しいタブで開く。 */
export function shareOnX(text: string): void {
  window.open(xShareUrl(text), "_blank", "noopener,noreferrer");
}
