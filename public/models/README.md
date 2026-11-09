# KataGo ネットワーク

`kata1-b6c96-s175395328-d26788732.onnx` は、KataGo の g170 ランから kata1 に取り込まれた
ネットワーク `kata1-b6c96-s175395328-d26788732` を ONNX に変換したものです。

- 入手元: https://katagotraining.org/networks/
- ライセンス: g170 ランのネットワークは CC0（パブリックドメイン相当）です。
  https://katagotraining.org/network_license/ の "Exceptions" を参照してください。
- 変換: `python3 tools/convert_katago.py kata1-b6c96-s175395328-d26788732.txt.gz public/models/kata1-b6c96-s175395328-d26788732.onnx`

## Human SL ネットワーク

`b18c384nbt-humanv0-int8.onnx` は、KataGo の Human SL ネットワーク `b18c384nbt-humanv0` を ONNX に変換したものです。
段級位などのメタデータを与えると、その棋力の人が打ちそうな手を予測します。終局図の「打ち手の棋力」で使います。

- 入手元: https://katagotraining.org/extra_networks/ （"KataGo Human SL Network" の "Raw pytorch checkpoint"）
- 変換: `python3 tools/export_humansl.py <KataGo の python ディレクトリ> b18c384nbt-humanv0.ckpt public/models/b18c384nbt-humanv0-int8.onnx`
  （SWA の重みを使い、畳み込みの重みを出力チャンネルごとの int8 にしています）
- ライセンス: https://katagotraining.org/network_license/ の "KataGo Neural Network License" です。

```
KataGo Neural Network License

Copyright 2026 David J Wu ("lightvector").

Permission is hereby granted, free of charge, to any person obtaining a copy of the neural net files or training weight files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
