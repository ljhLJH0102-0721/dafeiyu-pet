# -*- coding: utf-8 -*-
"""
make_icon.py —— 用她现在的样子做桌面图标（蓝白底 + 圆角）

输入：shots/_icon_src.png（她的窗口截图，1.25 倍物理像素）
输出：assets/icon_256.png / assets/dafeiyu.ico（16~256 多尺寸）

用法：
    python make_icon.py [源图] [输出目录]
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        img.putpixel((0, y), tuple(
            int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((w, h), Image.BILINEAR)


def circle_mask(size):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return m


def build(src_path, out_dir):
    src = Image.open(src_path).convert("RGBA")
    sw, sh = src.size
    # 脸部裁剪：水平居中、从头顶往下约 36% 高度（源图 1.25 倍物理像素）
    face_w = int(sw * 0.52)
    face_h = int(face_w)
    cx = int(sw * 0.50)
    cy = int(sh * 0.16)
    box = (cx - face_w // 2, cy - face_h // 2, cx + face_w // 2, cy + face_h // 2)
    box = (
        max(0, box[0]), max(0, box[1]),
        min(sw, box[2]), min(sh, box[3]),
    )
    face = src.crop(box)

    S = 256
    # 蓝白渐变底
    bg = vertical_gradient((S, S), (234, 242, 255), (214, 231, 255)).convert("RGBA")
    # 中间留白，让脸更"浮"起来
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(inner)
    d.ellipse((24, 18, S - 24, S - 18), fill=(255, 255, 255, 235))
    bg = Image.alpha_composite(bg, inner)

    # 脸部放进圆形，加白边
    fsize = int(S * 0.80)
    face = face.resize((fsize, fsize), Image.LANCZOS)
    mask = circle_mask(fsize)
    ring = Image.new("RGBA", (fsize + 16, fsize + 16), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((0, 0, fsize + 15, fsize + 15), fill=(255, 255, 255, 255))
    pos = ((S - fsize) // 2, (S - fsize) // 2)
    out = bg.copy()
    out.paste(ring, (pos[0] - 8, pos[1] - 8), ring)
    out.paste(face, pos, mask)

    # 蓝色细描边 + 圆角裁切
    border = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        (1, 1, S - 2, S - 2), radius=56, outline=(47, 107, 255, 90), width=2)
    out = Image.alpha_composite(out, border)
    out.putalpha(rounded_mask(S, 56))

    os.makedirs(out_dir, exist_ok=True)
    png_path = os.path.join(out_dir, "icon_256.png")
    ico_path = os.path.join(out_dir, "dafeiyu.ico")
    out.save(png_path)
    out.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                              (64, 64), (128, 128), (256, 256)])
    return png_path, ico_path


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "shots", "_icon_src.png")
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "assets")
    png, ico = build(src, out_dir)
    print("OK", png)
    print("OK", ico)
