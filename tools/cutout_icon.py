#!/usr/bin/env python3
"""
把一张白底图抠成透明底 PNG，用作气泡图标。

为什么不能简单地「把白色变透明」：画面内部的米饭、蕾丝头饰、裙边与眼睛高光
都是白色，全局替换会把它们一起掏空。所以这里从图像四边做**连通域填充**，
只把与边缘相连的那片白当作背景。

顺带清掉零碎的杂点（例如右下角的生成式水印文字）：抠完之后按连通域面积
过滤，只保留主体。

用法：
    python tools/cutout_icon.py <源图> <输出png> [--size 256] [--tol 40] [--pad 0.03]
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def cutout(src: Path, tol: int, soft_floor: int = 8):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.int16)

    # 距离纯白：d 越小越接近白
    d = 255 - a.min(axis=2)

    # 1) 候选背景：够白
    candidate = d < tol

    # 2) 只认与图像边缘相连的那一片（8 邻域）
    labels, n = ndimage.label(candidate, structure=np.ones((3, 3), bool))
    if n == 0:
        raise SystemExit("整张图都不像白底，无法抠图")
    border_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    border_labels.discard(0)
    background = np.isin(labels, list(border_labels))

    # 3) 主体 = 不是背景的部分；按面积过滤掉零碎杂点（水印、噪点）
    subject = ~background
    sub_labels, sub_n = ndimage.label(subject, structure=np.ones((3, 3), bool))
    if sub_n > 1:
        sizes = ndimage.sum(np.ones_like(sub_labels), sub_labels, index=range(1, sub_n + 1))
        biggest = int(np.argmax(sizes)) + 1
        keep_area = max(sizes[biggest - 1] * 0.01, 200)   # 小于主体 1% 或 200 像素的丢掉
        keep = {i + 1 for i, s in enumerate(sizes) if s >= keep_area}
        keep.add(biggest)
        subject = np.isin(sub_labels, list(keep))

    # 4) alpha：
    #    主体不透明；背景**只在紧贴主体的 1~2 像素内**按离白的远近给过渡值（防锯齿），
    #    其余背景一律全透明 —— 否则远离主体的浅灰杂点（例如生成式水印文字）
    #    会因为落在柔和带里而留下半透明的痕迹。
    gap = ndimage.distance_transform_edt(~subject)
    edge_band = gap <= 1.6
    soft = np.clip((d - soft_floor) / max(tol - soft_floor, 1) * 255, 0, 255)
    alpha = np.where(subject, 255, np.where(edge_band, soft, 0)).astype(np.uint8)

    out = np.dstack([np.asarray(im).astype(np.uint8), alpha])
    return Image.fromarray(out, "RGBA")


def trim_and_square(im: Image.Image, pad_ratio: float, size: int):
    bbox = im.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox()
    if bbox is None:
        raise SystemExit("抠完什么都没有了，检查 --tol 是否过大")
    im = im.crop(bbox)
    side = int(max(im.size) * (1 + pad_ratio * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--size", type=int, default=256)
    p.add_argument("--tol", type=int, default=40, help="多大程度上算白（0-255）")
    p.add_argument("--pad", type=float, default=0.03, help="四周留白比例")
    args = p.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    if not src.exists():
        print(f"找不到源图：{src}", file=sys.stderr)
        return 1

    img = cutout(src, args.tol)
    img = trim_and_square(img, args.pad, args.size)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, optimize=True)

    arr = np.asarray(img)
    opaque = int((arr[:, :, 3] > 200).sum())
    print(f"源图：{src}  {Image.open(src).size}")
    print(f"输出：{dst}  {img.size}  {dst.stat().st_size} 字节")
    print(f"不透明像素占比：{opaque / (img.width * img.height) * 100:.1f}%")
    print(f"四角 alpha：{arr[0,0,3]} {arr[0,-1,3]} {arr[-1,0,3]} {arr[-1,-1,3]}（应为 0）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
