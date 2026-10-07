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
| `src/game/session.ts` | ひとりでモードのゲーム進行（フェーズ・ペナルティ・完了判定） |
| `src/game/dummy.ts` | 仮の終局図生成（KataGo 導入までのつなぎ） |
| `src/ui/` | 画面（設定・対局・結果） |

## 公開

`main` に push すると GitHub Actions でビルドし、GitHub Pages に公開します。
初回のみ、リポジトリの Settings → Pages → Source を「GitHub Actions」に設定してください。

動作確認用に `?seed=123` を URL に付けると、仮の終局図を固定できます。
