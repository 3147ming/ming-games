import base64, io, os, re, sys
from PIL import Image, ImageDraw

ART_DIR = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d78-ffb1f71e8000/new4/jigsaw/art'
KEYS = ['sunflower-cat','daisy-rabbit','rose-squirrel','cat-basket','ocean-fish','dessert-rabbit',
        'succulent-cat','fruit-basket','forest-bug','forest-deer','snow-village','star-camp']

def jpeg_bytes(im, q=85):
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=q, optimize=True, progressive=True)
    return b.getvalue()

def to_data_uri(raw, mime='image/jpeg'):
    return 'data:%s;base64,%s' % (mime, base64.b64encode(raw).decode('ascii'))

def grid_overlay(size=660, n=6, color=(120,100,80), alpha=110, lw=2):
    """成品图上的淡灰切割线：外框 + 等分格线，透明 PNG。"""
    im = Image.new('RGBA', (size, size), (0,0,0,0))
    d = ImageDraw.Draw(im)
    step = size / n
    c = color + (alpha,)
    for i in range(1, n):
        x = i*step
        d.line([(x, 0), (x, size)], fill=c, width=lw)
        y = i*step
        d.line([(0, y), (size, y)], fill=c, width=lw)
    d.rectangle([0,0,size-1,size-1], outline=color+(min(255,alpha+40),), width=lw+1)
    b = io.BytesIO(); im.save(b, 'PNG', optimize=True)
    return b.getvalue()

art, thumb, hero, grid = {}, {}, {}, {}
total = 0
for k in KEYS:
    p = os.path.join(ART_DIR, k + '.jpg')
    raw = open(p, 'rb').read()
    total += len(raw)//4*3
    art[k] = to_data_uri(raw)
    im = Image.open(p).convert('RGB')
    # 缩略图 160（选关卡片 / 图鉴）
    t = im.resize((160,160), Image.LANCZOS)
    thumb[k] = to_data_uri(jpeg_bytes(t, 84))
    # 首屏封面 360
    h = im.resize((360,360), Image.LANCZOS)
    hero_k = to_data_uri(jpeg_bytes(h, 86))
    if k == 'sunflower-cat':
        hero = hero_k
    # 成品图切割线（36/64 两档）
    grid[k] = {}
    for n in (6, 8):
        grid[k][n] = to_data_uri(grid_overlay(660, n), 'image/png')

def js_map(d):
    return '{\n' + ',\n'.join('  "%s": "%s"' % (k, v) for k, v in d.items()) + '\n}'

path = '/tmp/mg/jigsaw/index.html'
src = open(path, encoding='utf-8').read()

block = ('/* 拼图底图内联资源：art/*.jpg（900×900）原字节转 data URI，缩略图 160×160、首屏封面 360×360 */\n'
         'window.MG_JIGSAW_ART = ' + js_map(art) + ';\n'
         'window.MG_JIGSAW_THUMB = ' + js_map(thumb) + ';\n'
         'window.MG_JIGSAW_HERO = "%s";\n' % hero +
         'window.MG_JIGSAW_GRID = {\n' +
         ',\n'.join('  "%s": {"6": "%s", "8": "%s"}' % (k, grid[k][6], grid[k][8]) for k in KEYS) +
         '\n};\n')

start = src.index('/* 拼图底图内联资源')
end = src.index('window.MG_JIGSAW_GRID = {};') + len('window.MG_JIGSAW_GRID = {};')
src = src[:start] + block.rstrip('\n') + src[end:]
open(path, 'w', encoding='utf-8').write(src)
print('wrote', path, os.path.getsize(path), 'bytes')
