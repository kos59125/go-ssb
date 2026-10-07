/** シード付きの疑似乱数（mulberry32）。同じシードなら同じ列を返す。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 時刻と乱数から作る、新しいシード（8 桁の数字）。 */
export function randomSeed(): string {
  const mixed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  return String(mixed % 100_000_000).padStart(8, "0");
}

/** 入力されたシードを数値にする。数字ならその値、それ以外の文字列はハッシュ（FNV-1a）。 */
export function seedNumber(text: string): number {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(BigInt(trimmed) % 4294967296n);
  let h = 0x811c9dc5;
  for (const ch of trimmed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
