#!/usr/bin/env python3
"""生成 PWA 图标。改了配色或字形后重跑一次即可:  python3 tools/make-icons.py"""
from PIL import Image, ImageDraw, ImageFont
import os

FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc'
FONT_SC = 2                      # 该 ttc 里简体中文那一张脸
OUT = os.path.join(os.path.dirname(__file__), '..', 'public')

BG_TOP, BG_BOT = (13, 42, 51), (4, 14, 19)     # 和页面下半屏同一套深青
CYAN = (42, 195, 242)

def base(size, inset):
    """inset: 主体内容占整张图的比例。maskable 图标要留出 20% 安全边。"""
    img = Image.new('RGB', (size, size), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(size):                       # 竖向渐变
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)],
               fill=tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))

    # 就一个「译」字。试过在下面加声波,32px 下糊成噪点还跟字撞在一起 ——
    # 主屏图标在 60px 左右被看,越简单越认得出。
    box = size * inset
    f = ImageFont.truetype(FONT, size=int(box * 0.86), index=FONT_SC)
    txt = '译'
    l, t, r, b = d.textbbox((0, 0), txt, font=f)
    d.text((size / 2 - (r + l) / 2, size / 2 - (b + t) / 2), txt, font=f, fill=CYAN)
    return img

def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, 'PNG', optimize=True)
    print(f'  {name:24s} {img.size[0]}x{img.size[1]}  {os.path.getsize(path)/1024:.1f} KB')

print('生成图标:')
# manifest 用:留 20% 安全边,被裁成圆形也不丢内容
m = base(1024, 0.68)
for s in (192, 512):
    save(m.resize((s, s), Image.LANCZOS), f'icon-{s}.png')
# iOS 主屏图标:系统自己加圆角,所以内容可以铺得满一些,且不能有透明通道
a = base(1024, 0.80)
save(a.resize((180, 180), Image.LANCZOS), 'apple-touch-icon.png')
save(a.resize((32, 32), Image.LANCZOS), 'favicon.png')
