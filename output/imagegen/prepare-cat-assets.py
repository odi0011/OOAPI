"""从两张已抠好的动作图中裁出网页素材，并生成明暗背景检查图。"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
destination = root.parent.parent / 'ooapi-web/public/illustrations'
actions = Image.open(root / 'grey-cat-actions-atlas-transparent.png').convert('RGBA')
detail = Image.open(root / 'grey-cat-detail-atlas-transparent.png').convert('RGBA')
regions = {
    'wave': (actions, (0, 0, 400, 535)),
    'peek': (detail, (0, 0, 768, 540)),
    'key': (detail, (768, 0, 1536, 575)),
    'code': (detail, (0, 540, 768, 1024)),
    'nap': (detail, (768, 575, 1536, 1024)),
    'teach': (actions, (410, 530, 785, 1024)),
    'play': (actions, (785, 530, 1140, 1024)),
    'friends': (actions, (1140, 530, 1536, 1024)),
}
preview = Image.new('RGB', (1600, 900), '#f4f6fa')
draw = ImageDraw.Draw(preview)
draw.rectangle((0, 450, 1600, 900), fill='#1c2230')
for i, (pose, (sheet, box)) in enumerate(regions.items()):
    cropped = sheet.crop(box)
    alpha = cropped.getchannel('A').point(lambda a: 0 if a < 12 else a)
    cropped.putalpha(alpha)
    bounds = alpha.getbbox()
    if not bounds:
        raise ValueError(f'Empty sprite: {pose}')
    cropped = cropped.crop(bounds)
    canvas = Image.new('RGBA', (cropped.width + 16, cropped.height + 16))
    canvas.alpha_composite(cropped, (8, 8))
    canvas.save(destination / f'cat-{pose}.webp', quality=94, method=6)
    draw.text(((i % 4)*400 + 18, (i // 4)*450 + 16), pose, fill='#6681b0')
    shown = canvas.copy()
    shown.thumbnail((350, 385), Image.Resampling.LANCZOS)
    preview.paste(shown, ((i % 4)*400 + (400-shown.width)//2, (i // 4)*450 + 48 + (385-shown.height)//2), shown)
    print(f'{pose}: {canvas.width}x{canvas.height}')
preview.save(root / 'grey-cat-assets-review.jpg', quality=95)
