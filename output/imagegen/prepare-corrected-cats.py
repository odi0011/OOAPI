"""整页生成后统一裁切、去色键；保留白毛和肉垫，检查明暗背景边缘。"""
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

root = Path(__file__).resolve().parent
target = root.parent.parent / 'ooapi-web/public/illustrations'
sheet = Image.open(root / 'grey-cat-corrected-cutout.png').convert('RGB')
pixels = np.asarray(sheet).astype(float)
delta = np.minimum(pixels[:, :, 0], pixels[:, :, 2]) - pixels[:, :, 1]
alpha = np.where(delta > 20, (255 - delta) / 255, 1).clip(0, 1)
alpha[alpha < .12] = 0
edge = (alpha > 0) & (alpha < 1)
for channel, key in [(0, 255), (1, 0), (2, 255)]:
    pixels[:, :, channel][edge] = ((pixels[:, :, channel][edge] - key * (1 - alpha[edge])) / alpha[edge]).clip(0, 255)
rgba = Image.fromarray(np.dstack((pixels, alpha * 255)).astype('uint8'), 'RGBA')
rgba.save(root / 'grey-cat-corrected-transparent.png')
poses = ['wave', 'stretch', 'read', 'sit', 'doze', 'listen']
preview = Image.new('RGB', (1500, 1020), '#f4f6fa')
draw = ImageDraw.Draw(preview)
draw.rectangle((0, 510, 1500, 1020), fill='#20242b')
for index, pose in enumerate(poses):
    col, row = index % 3, index // 3
    crop = rgba.crop((round(col * sheet.width / 3), round(row * sheet.height / 2), round((col + 1) * sheet.width / 3), round((row + 1) * sheet.height / 2)))
    # 格子边缘可能落入相邻动作的一根毛；取主体连通区域，额外保留胡须余量。
    mask = np.asarray(crop.getchannel('A')).copy() > 30
    largest = []
    for y, x in zip(*np.nonzero(mask)):
        if not mask[y, x]:
            continue
        stack, component = [(int(x), int(y))], []
        mask[y, x] = False
        while stack:
            px, py = stack.pop()
            component.append((px, py))
            for nx, ny in ((px-1, py), (px+1, py), (px, py-1), (px, py+1)):
                if 0 <= nx < crop.width and 0 <= ny < crop.height and mask[ny, nx]:
                    mask[ny, nx] = False
                    stack.append((nx, ny))
        if len(component) > len(largest):
            largest = component
    xs, ys = zip(*largest)
    crop = crop.crop((max(0, min(xs)-8), max(0, min(ys)-8), min(crop.width, max(xs)+9), min(crop.height, max(ys)+9)))
    bounds = crop.getchannel('A').getbbox()
    if not bounds:
        raise ValueError(pose)
    crop = crop.crop(bounds)
    padded = Image.new('RGBA', (crop.width + 16, crop.height + 16))
    padded.alpha_composite(crop, (8, 8))
    padded.save(target / f'cat-{pose}.webp', quality=94, method=6)
    print(pose, padded.size)
    shown = padded.copy()
    shown.thumbnail((450, 435), Image.Resampling.LANCZOS)
    preview.paste(shown, (col * 500 + (500 - shown.width) // 2, row * 510 + 45 + (435 - shown.height) // 2), shown)
    draw.text((col * 500 + 20, row * 510 + 20), pose, fill='#748398')
preview.save(root / 'grey-cat-corrected-review.jpg', quality=94)
