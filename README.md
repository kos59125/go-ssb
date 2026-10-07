# 囲碁スピード整地バトル

囲碁の整地を素早く完了させた方が勝ち、という対戦ゲームの HTML アプリケーションです。

- [仕様書](docs/spec.md)
- [ルールブック](docs/rulebook.md)

## 開発

```sh
npm install
npm run dev        # 開発サーバー
npm test           # 単体テスト
npm run build      # 型チェックとビルド（dist/）
```

## 構成

| パス | 内容 |
| --- | --- |
| `src/core/board.ts` | 盤面（石の色と死に石フラグ） |
| `src/core/analysis.ts` | 領域・地・セキの判定と目数計算 |
| `src/core/shapes.ts` | 区間の形の判定（10 の倍数・余り） |
| `src/core/judge.ts` | 整地完了と死に石取りフェーズの判定 |
| `src/core/placement.ts` | 複数の石を置くときの配置 |
