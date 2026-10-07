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
| `src/game/session.ts` | ひとりでモードのゲーム進行（フェーズ・ペナルティ・完了判定） |
| `src/game/dummy.ts` | 仮の終局図生成（`?dummy=123` での動作確認用） |
| `src/core/random.ts` | シード付き乱数 |
| `src/ai/go.ts` | 自動対局用の囲碁ルール（取り・コウ・自殺手） |
| `src/ai/features.ts` | KataGo の入力特徴量 |
| `src/ai/model.ts` | ONNX 版 KataGo の評価 |
| `src/ai/generate.ts` | 自動対局と終局処理（死に石・ダメ埋め・盤の向き） |
| `src/ai/sgf.ts` | SGF の読み込み（本譜と初期配置） |
| `src/ai/worker.ts`, `src/ai/client.ts` | Web Worker での生成と先読み |
| `public/samples/` | サンプルの棋譜（セキの確認用など） |
| `tools/convert_katago.py` | KataGo のモデルファイルを ONNX に変換 |
| `src/ui/` | 画面（設定・対局・結果） |

## 公開

`main` に push すると GitHub Actions でビルドし、GitHub Pages に公開します。
初回のみ、リポジトリの Settings → Pages → Source を「GitHub Actions」に設定してください。

動作確認用に `?dummy=123` を URL に付けると、KataGo を使わずに仮の終局図（123 をシードに固定）で遊べます。

## KataGo ネットワークの変換

```sh
pip install onnx numpy
curl -LO https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b6c96-s175395328-d26788732.txt.gz
python3 tools/convert_katago.py kata1-b6c96-s175395328-d26788732.txt.gz public/models/kata1-b6c96-s175395328-d26788732.onnx
```

ネットワークは g170 ラン由来で CC0 です（[public/models/README.md](public/models/README.md)）。
