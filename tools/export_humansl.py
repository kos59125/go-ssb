#!/usr/bin/env python3
"""KataGo の Human SL ネットワーク（PyTorch のチェックポイント）を ONNX に変換する。

使い方:
    python3 tools/export_humansl.py KATAGO_PYTHON_DIR b18c384nbt-humanv0.ckpt public/models/b18c384nbt-humanv0-int8.onnx

- KATAGO_PYTHON_DIR: KataGo のリポジトリの python ディレクトリ（katago.train.model_pytorch を使う）。
- チェックポイント: https://katagotraining.org/extra_networks/ の "KataGo Human SL Network" の
  "Raw pytorch checkpoint"。
- 必要なパッケージ: torch、onnx、numpy。

チェックポイントは、テンソルと基本的な型だけを許可した unpickler で読む（任意のコードは実行しない）。
SWA の重みを使う。畳み込みの重みは出力チャンネルごとの int8 にして DequantizeLinear で戻す
（約 107 MB → 約 29 MB。fp32 との方策の差は KL で 1e-4 程度）。

入出力（N はバッチ、H/W は盤サイズ）:
    入力  spatial   [N, 22, H, W]   入力特徴量（V7）
          global    [N, 19]         大域特徴量（V7）
          meta      [N, 192]        対局のメタデータ（段級位など。src/ai/humanSl.ts）
    出力  policy    [N, H*W + 1]    着手のロジット（最後がパス）
          value     [N, 3]          勝ち・負け・無勝負のロジット
          score     [N, 4]          [scoreMean, scoreStdev, lead, varTime]（/20 など、変換前の値）
          ownership [N, H*W]        所有権（tanh 前）
"""

import pickle
import sys
import types

import numpy as np
import onnx
import torch
from onnx import helper, numpy_helper

ALLOWED = {
    ("collections", "OrderedDict"),
    ("collections", "defaultdict"),
    *((m, n) for m in ("builtins", "__builtin__") for n in ("float", "int", "dict", "list", "set", "tuple")),
    ("torch._utils", "_rebuild_tensor_v2"),
    ("torch._utils", "_rebuild_parameter"),
    ("torch", "Size"),
    ("torch.storage", "UntypedStorage"),
    *(("torch", f"{t}Storage") for t in ("Float", "Long", "Int", "Half", "BFloat16", "Double", "Bool", "Byte")),
}


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) not in ALLOWED:
            raise pickle.UnpicklingError(f"許可していない型です: {module}.{name}")
        return super().find_class(module, name)


safe_pickle = types.ModuleType("safe_pickle")
safe_pickle.Unpickler = SafeUnpickler
safe_pickle.load = pickle.load


def load_model(katago_dir, ckpt):
    sys.path.insert(0, katago_dir)
    from katago.train.load_model import load_swa_model_state_dict
    from katago.train.model_pytorch import Model

    state_dict = torch.load(ckpt, map_location="cpu", weights_only=False, pickle_module=safe_pickle)
    model = Model(state_dict["config"], 19)
    model.initialize()
    swa = load_swa_model_state_dict(state_dict)
    weights = {k[len("module.") :]: v for k, v in swa.items() if k.startswith("module.")}
    model.load_state_dict(weights)
    model.eval()
    return model


class Wrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spatial, global_, meta):
        policy, value, miscvalue, _, ownership = self.model(spatial, global_, input_meta=meta)[0][:5]
        n = spatial.shape[0]
        return policy[:, 0, :], value, miscvalue[:, 0:4], ownership.reshape(n, -1)


def quantize(model):
    """畳み込みの重みを出力チャンネルごとの int8 + DequantizeLinear にする。"""
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    weights = {n.input[1] for n in graph.node if n.op_type == "Conv" and n.input[1] in inits}
    new_inits, new_nodes = [], []
    for name in sorted(weights):
        w = numpy_helper.to_array(inits[name]).astype(np.float32)
        if w.size < 4096:
            continue
        scale = np.abs(w.reshape(w.shape[0], -1)).max(axis=1) / 127.0
        scale[scale == 0] = 1.0
        q = np.clip(np.round(w / scale.reshape(-1, *[1] * (w.ndim - 1))), -127, 127).astype(np.int8)
        graph.initializer.remove(inits[name])
        new_inits += [
            numpy_helper.from_array(q, name + "_q"),
            numpy_helper.from_array(scale.astype(np.float32), name + "_s"),
            numpy_helper.from_array(np.zeros(w.shape[0], np.int8), name + "_z"),
        ]
        new_nodes.append(helper.make_node("DequantizeLinear", [name + "_q", name + "_s", name + "_z"], [name], axis=0))
    graph.initializer.extend(new_inits)
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(new_nodes + nodes)


def main():
    katago_dir, ckpt, out_path = sys.argv[1:4]
    model = Wrapper(load_model(katago_dir, ckpt)).eval()
    spatial = torch.zeros(1, 22, 9, 9)
    spatial[:, 0] = 1
    tmp = out_path + ".fp32.onnx"
    with torch.no_grad():
        torch.onnx.export(
            model,
            (spatial, torch.zeros(1, 19), torch.zeros(1, 192)),
            tmp,
            input_names=["spatial", "global", "meta"],
            output_names=["policy", "value", "score", "ownership"],
            dynamic_axes={
                "spatial": {0: "n", 2: "h", 3: "w"},
                "global": {0: "n"},
                "meta": {0: "n"},
                "policy": {0: "n", 1: "moves"},
                "value": {0: "n"},
                "score": {0: "n"},
                "ownership": {0: "n", 1: "points"},
            },
            opset_version=17,
            dynamo=False,
        )
    onnx_model = onnx.load(tmp)
    quantize(onnx_model)
    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, out_path)
    print(f"wrote {out_path} (fp32: {tmp})")


if __name__ == "__main__":
    main()
