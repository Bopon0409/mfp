"""Real-ESRGAN .pth -> ONNX for the in-browser upscaler (apps/editor/public/upscaler).

Needs Python 3.12 with torch, spandrel, onnx, onnxscript, onnxconverter-common, onnxruntime.
Usage: python tools/upscaler/convert-models.py <folder with .pth> [--out apps/editor/public/upscaler]

Weights (BSD-3-Clause, https://github.com/xinntao/Real-ESRGAN/releases):
  realesr-general-x4v3.pth, RealESRGAN_x4plus.pth, RealESRGAN_x4plus_anime_6B.pth
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxconverter_common import float16
from spandrel import ModelLoader

MODELS = {
    "realesr-general-x4v3": "realesr-general-x4v3.pth",
    "realesr-x4plus": "RealESRGAN_x4plus.pth",
    "realesr-x4plus-anime": "RealESRGAN_x4plus_anime_6B.pth",
}


def export(pth: Path, out: Path) -> None:
    model = ModelLoader(device="cpu").load_from_file(str(pth)).model.eval()
    dummy = torch.rand(1, 3, 64, 64)
    torch.onnx.export(
        model,
        dummy,
        str(out),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "oh", 3: "ow"}},
        opset_version=17,
        dynamo=False,
    )
    with torch.inference_mode():
        expected = model(dummy).numpy()
    got = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"]).run(None, {"input": dummy.numpy()})[0]
    print(f"  {out.name}: {out.stat().st_size / 2**20:.1f} MB, max diff vs torch {np.abs(got - expected).max():.2e}")


def to_fp16(src: Path, dst: Path) -> None:
    model = float16.convert_float_to_float16(onnx.load(str(src)), keep_io_types=True)
    onnx.save(model, str(dst))
    x = np.random.rand(1, 3, 64, 64).astype(np.float32)
    a = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"]).run(None, {"input": x})[0]
    b = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"]).run(None, {"input": x})[0]
    print(f"  {dst.name}: {dst.stat().st_size / 2**20:.1f} MB, max diff vs fp32 {np.abs(a - b).max():.2e}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("weights", type=Path)
    parser.add_argument("--out", type=Path, default=Path("apps/editor/public/upscaler"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, file in MODELS.items():
        pth = args.weights / file
        if not pth.exists():
            print(f"skip {name}: no {pth}", file=sys.stderr)
            continue
        print(name)
        fp32 = args.out / f"{name}.fp32.onnx"
        export(pth, fp32)
        to_fp16(fp32, args.out / f"{name}.fp16.onnx")


if __name__ == "__main__":
    main()
