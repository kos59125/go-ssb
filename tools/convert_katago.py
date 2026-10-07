#!/usr/bin/env python3
"""KataGo のモデルファイル（.txt / .txt.gz、モデルバージョン 8〜10）を ONNX に変換する。

使い方:
    python3 tools/convert_katago.py kata1-b6c96-s175395328-d26788732.txt.gz public/models/katago.onnx

モデル形式は KataGo の cpp/neuralnet/desc.cpp、推論の計算は cpp/neuralnet/eigenbackend.cpp に従う。

入出力（N はバッチ、H/W は盤サイズ。盤外のパディングは使わない前提）:
    入力  spatial   [N, 22, H, W]   入力特徴量（V7）
          global    [N, 19]         大域特徴量（V7）
    出力  policy    [N, H*W + 1]    着手のロジット（最後がパス）
          value     [N, 3]          勝ち・負け・無勝負のロジット
          score     [N, C]          スコア系の出力（[0] が scoreMean / 20 など）
          ownership [N, H*W]        所有権（tanh 前）

いずれも手番側から見た値。
"""

import gzip
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


class Reader:
    def __init__(self, path):
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt") as f:
            self.tokens = f.read().split()
        self.pos = 0

    def token(self):
        t = self.tokens[self.pos]
        self.pos += 1
        return t

    def int(self):
        return int(self.token())

    def float(self):
        return float(self.token())

    def floats(self, n):
        values = np.array(self.tokens[self.pos : self.pos + n], dtype=np.float32)
        self.pos += n
        return values


class Builder:
    def __init__(self):
        self.nodes = []
        self.inits = []
        self.count = 0

    def name(self, prefix):
        self.count += 1
        return f"{prefix}_{self.count}"

    def const(self, array, prefix="c"):
        name = self.name(prefix)
        self.inits.append(numpy_helper.from_array(np.asarray(array), name))
        return name

    def op(self, op_type, inputs, prefix=None, **attrs):
        out = self.name(prefix or op_type.lower())
        self.nodes.append(helper.make_node(op_type, inputs, [out], **attrs))
        return out


def read_conv(r, b, x):
    name = r.token()
    ky, kx, ic, oc, dy, dx = (r.int() for _ in range(6))
    assert dy == 1 and dx == 1, f"{name}: dilation is not supported"
    w = r.floats(ky * kx * ic * oc).reshape(ky, kx, ic, oc).transpose(3, 2, 0, 1)
    return b.op("Conv", [x, b.const(np.ascontiguousarray(w), name)], pads=[ky // 2, kx // 2, ky // 2, kx // 2])


def read_bn(r, b, x):
    name = r.token()
    c = r.int()
    eps = r.float()
    has_scale = r.int()
    has_bias = r.int()
    mean = r.floats(c)
    var = r.floats(c)
    scale = r.floats(c) if has_scale else np.ones(c, np.float32)
    bias = r.floats(c) if has_bias else np.zeros(c, np.float32)
    merged_scale = scale / np.sqrt(var + eps)
    merged_bias = bias - mean * merged_scale
    y = b.op("Mul", [x, b.const(merged_scale.reshape(1, c, 1, 1).astype(np.float32), name + "_scale")])
    return b.op("Add", [y, b.const(merged_bias.reshape(1, c, 1, 1).astype(np.float32), name + "_bias")])


def read_act(r, b, x, version):
    r.token()  # name
    if version >= 11:
        kind = r.token()
        assert kind == "ACTIVATION_RELU", kind
    return b.op("Relu", [x])


def read_matmul(r, b, x):
    name = r.token()
    ic, oc = r.int(), r.int()
    w = r.floats(ic * oc).reshape(ic, oc)
    return b.op("MatMul", [x, b.const(w, name)])


def read_matbias(r, b, x):
    name = r.token()
    c = r.int()
    return b.op("Add", [x, b.const(r.floats(c), name)])


def gpool(b, x, sqrt_area_term, value_head=False):
    """KataGo のグローバルプーリング。x: [N, C, H, W] → [N, 3C]"""
    mean = b.op("ReduceMean", [x], axes=[2, 3], keepdims=0)
    scaled = b.op("Mul", [mean, sqrt_area_term])
    if value_head:
        sq = b.op("Mul", [sqrt_area_term, sqrt_area_term])
        third_factor = b.op("Sub", [sq, b.const(np.array(0.1, np.float32))])
        third = b.op("Mul", [mean, third_factor])
    else:
        third = b.op("ReduceMax", [x], axes=[2, 3], keepdims=0)
    return b.op("Concat", [mean, scaled, third], axis=1)


def add_bias_to_spatial(b, x, bias):
    """x: [N, C, H, W] に bias: [N, C] を足す。"""
    return b.op("Add", [x, b.op("Unsqueeze", [bias, b.const(np.array([2, 3], np.int64))])])


def convert(src, dst):
    r = Reader(src)
    b = Builder()

    model_name = r.token()
    version = r.int()
    assert 8 <= version <= 10, f"unsupported model version {version}"
    num_spatial = r.int()
    num_global = r.int()

    spatial = "spatial"
    global_in = "global"

    # (sqrt(盤の点数) - 14) / 10。盤上の点は入力特徴量 0 番がすべて 1。
    ones = b.op("Slice", [spatial, b.const(np.array([0], np.int64)), b.const(np.array([1], np.int64)), b.const(np.array([1], np.int64))])
    area = b.op("ReduceSum", [ones, b.const(np.array([1, 2, 3], np.int64))], keepdims=0)
    area = b.op("Unsqueeze", [area, b.const(np.array([1], np.int64))])
    sqrt_area = b.op("Sqrt", [area])
    sqrt_area_term = b.op("Mul", [b.op("Sub", [sqrt_area, b.const(np.array(14.0, np.float32))]), b.const(np.array(0.1, np.float32))])

    # trunk
    assert r.token() == "trunk"
    num_blocks = r.int()
    for _ in range(5):
        r.int()  # trunk/mid/regular/dilated/gpool channels
    x = read_conv(r, b, spatial)
    x = add_bias_to_spatial(b, x, read_matmul(r, b, global_in))

    for _ in range(num_blocks):
        kind = r.token()
        r.token()  # block name
        if kind == "ordinary_block":
            y = read_act(r, b, read_bn(r, b, x), version)
            y = read_conv(r, b, y)
            y = read_act(r, b, read_bn(r, b, y), version)
            y = read_conv(r, b, y)
        elif kind == "gpool_block":
            a = read_act(r, b, read_bn(r, b, x), version)
            y = read_conv(r, b, a)
            g = read_conv(r, b, a)
            g = read_act(r, b, read_bn(r, b, g), version)
            y = add_bias_to_spatial(b, y, read_matmul(r, b, gpool(b, g, sqrt_area_term)))
            y = read_act(r, b, read_bn(r, b, y), version)
            y = read_conv(r, b, y)
        else:
            raise ValueError(f"unsupported block kind {kind}")
        x = b.op("Add", [x, y])

    trunk = read_act(r, b, read_bn(r, b, x), version)

    # policy head
    r.token()  # name
    p1 = read_conv(r, b, trunk)
    g1 = read_conv(r, b, trunk)
    g1 = read_act(r, b, read_bn(r, b, g1), version)
    g1_pooled = gpool(b, g1, sqrt_area_term)
    p1 = add_bias_to_spatial(b, p1, read_matmul(r, b, g1_pooled))
    p1 = read_act(r, b, read_bn(r, b, p1), version)
    p2 = read_conv(r, b, p1)  # [N, C, H, W]
    pass_logit = read_matmul(r, b, g1_pooled)  # [N, C]
    # 先頭チャンネル（通常の方策）だけを使う
    p2 = b.op("Slice", [p2, b.const(np.array([0], np.int64)), b.const(np.array([1], np.int64)), b.const(np.array([1], np.int64))])
    p2 = b.op("Flatten", [p2], axis=1)
    pass_logit = b.op("Slice", [pass_logit, b.const(np.array([0], np.int64)), b.const(np.array([1], np.int64)), b.const(np.array([1], np.int64))])
    b.nodes.append(helper.make_node("Concat", [p2, pass_logit], ["policy"], axis=1))

    # value head
    r.token()  # name
    v1 = read_conv(r, b, trunk)
    v1 = read_act(r, b, read_bn(r, b, v1), version)
    v_pooled = gpool(b, v1, sqrt_area_term, value_head=True)
    v2 = read_matbias(r, b, read_matmul(r, b, v_pooled))
    v2 = read_act(r, b, v2, version)
    value = read_matbias(r, b, read_matmul(r, b, v2))
    score = read_matbias(r, b, read_matmul(r, b, v2))
    ownership = read_conv(r, b, v1)
    b.nodes.append(helper.make_node("Identity", [value], ["value"]))
    b.nodes.append(helper.make_node("Identity", [score], ["score"]))
    b.nodes.append(helper.make_node("Flatten", [ownership], ["ownership"], axis=1))

    assert r.pos == len(r.tokens), f"{len(r.tokens) - r.pos} tokens left unread"

    graph = helper.make_graph(
        b.nodes,
        model_name,
        [
            helper.make_tensor_value_info(spatial, TensorProto.FLOAT, ["N", num_spatial, "H", "W"]),
            helper.make_tensor_value_info(global_in, TensorProto.FLOAT, ["N", num_global]),
        ],
        [
            helper.make_tensor_value_info("policy", TensorProto.FLOAT, ["N", "P"]),
            helper.make_tensor_value_info("value", TensorProto.FLOAT, ["N", 3]),
            helper.make_tensor_value_info("score", TensorProto.FLOAT, ["N", "S"]),
            helper.make_tensor_value_info("ownership", TensorProto.FLOAT, ["N", "A"]),
        ],
        b.inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="go-ssb")
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"{model_name} (version {version}, {num_blocks} blocks) -> {dst}")


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
