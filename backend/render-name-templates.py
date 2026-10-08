#!/usr/bin/env /usr/bin/python3
"""Vẽ mẫu chữ Tống cho từng tên huyệt (dùng để khớp mẫu khi định vị nhãn trong hình — xem
locate-figure-labels.mjs). Vào: names.json {tên: tên_file}; Ra: PNG xám (chữ đen, nền trắng) 96px.
Chạy: python3 render-name-templates.py names.json outdir"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont
names = json.load(open(sys.argv[1], encoding='utf-8')); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 96, index=4)  # STSong Regular — gần nét chữ trong sách
for name, fn in names.items():
    n = len(name)
    img = Image.new('L', (n * 100 + 8, 120), 255); d = ImageDraw.Draw(img)
    for i, ch in enumerate(name):
        d.text((4 + i * 100, 8), ch, font=font, fill=0)
    img.save(os.path.join(out, fn + '.png'))
print(len(names), 'mẫu')
