"""Generate PWA icons (192/512) for ming-games.

Design (matches the hand-made quiz icon):
  - vertical linear-gradient background in the game's theme color
  - large emoji glyph centered in the upper area
  - the game's Chinese title in bold white below the glyph
  - subtle radial highlight in the top-left

icon-192.png  -> purpose "any"          : gradient + glyph + title, full bleed
icon-512.png  -> purpose "any maskable" : same art scaled to the central 82%
                 safe zone (OS may crop the corners), so nothing important
                 is cut off.

Run:  python tools/gen-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = r"C:\Windows\Fonts"

CN_BOLD = os.path.join(FONTS, "msyhbd.ttc")
EMOJI = os.path.join(FONTS, "seguiemj.ttf")

# game dir -> (title, emoji, gradient top, gradient bottom)
GAMES = [
    ("wild",         "荒野大冒险", "\U0001F3DE", "#3b2a6b", "#15102e"),
    ("one-card",     "一生一世一轮牌", "\U0001F0CF", "#4a2a6b", "#1d1030"),
    ("soudache",     "音速病栋", "\U0001F3E0", "#1d4a6b", "#0b1f33"),
    ("night-shift",  "深夜值班", "\U0001F6C1", "#4a2a3d", "#1d0f1a"),
    ("brain-gym",    "脑力训练场", "\U0001F9E0", "#2a4a6b", "#101f33"),
    ("circuit-lab",  "电路实验室", "\U0001F9EC", "#1f6b5a", "#0a2b26"),
    ("grass-cutter", "割草大师", "\U0001FA79", "#2d6b3a", "#122b19"),
    ("paper-maze",   "纸灯迷径", "\U0001F5FF", "#6b532a", "#2b1f10"),
    ("neon-rhythm",  "霓虹律动", "\U0001F3B5", "#6b2a7a", "#2b0f33"),
    ("pixel-runner", "像素跑酷", "\U0001F3AE", "#4a4a6b", "#1a1a2b"),
    ("shanhai",      "山海旅人", "\U0001F5FA", "#6b3a2a", "#2b1710"),
    ("zhaoyun",      "赵云与阿斗", "\U0001F6E1", "#6b2a2a", "#2b1010"),
]


def gradient(size, top, bottom):
    """Vertical linear gradient."""
    w, h = size
    img = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(img)
    t = tuple(int(top[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(bottom[i:i + 2], 16) for i in (1, 3, 5))
    for y in range(h):
        f = y / max(1, h - 1)
        d.point((0, y), fill=tuple(round(t[i] + (b[i] - t[i]) * f) for i in range(3)))
    return img.resize((w, h), Image.BILINEAR)


def radial_highlight(img, cx=0.28, cy=0.16, radius=0.55, strength=58):
    """Soft white glow in the upper-left."""
    w, h = img.size
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    r = int(min(w, h) * radius)
    gd.ellipse((int(cx * w) - r, int(cy * h) - r, int(cx * w) + r, int(cy * h) + r),
               fill=strength)
    glow = glow.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(r // 3))
    white = Image.new("RGB", (w, h), (255, 255, 255))
    return Image.composite(white, img, glow)


def fit_font(path, text, max_w, max_h, start=200):
    """Largest font size at which `text` fits inside max_w x max_h."""
    size = start
    while size > 10:
        f = ImageFont.truetype(path, size)
        box = f.getbbox(text)
        if box[2] - box[0] <= max_w and box[3] - box[1] <= max_h:
            return f
        size -= 2
    return ImageFont.truetype(path, 10)


def render(size, title, emoji, ctop, cbottom, pad_frac=0.0):
    """Render one icon square.

    pad_frac > 0 means the art is drawn into the central (1-pad_frac*2) area
    and the rest is filled with the gradient (maskable safe zone).
    """
    base = gradient((size, size), ctop, cbottom)
    base = radial_highlight(base)

    inner = int(size * (1 - pad_frac * 2))
    art = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
    ad = ImageDraw.Draw(art)

    # --- emoji glyph (upper area) ---
    glyph_h = int(inner * 0.46)
    ef = ImageFont.truetype(EMOJI, glyph_h)
    # Segoe UI Emoji is monochrome; render it as a solid white silhouette
    # by pasting the glyph bitmap through a white alpha mask.
    mask = Image.new("L", (inner, inner), 0)
    md = ImageDraw.Draw(mask)
    eb = ef.getbbox(emoji)
    glyph_w = eb[2] - eb[0]
    gx = (inner - glyph_w) // 2
    gy = int(inner * 0.14)
    md.text((gx - eb[0], gy - eb[1]), emoji, font=ef, fill=255)
    white = Image.new("RGBA", (inner, inner), (255, 255, 255, 255))
    art.paste(white, (0, 0), mask)

    # --- title text (lower area) ---
    max_w = int(inner * 0.88)
    max_h = int(inner * 0.16)
    tf = fit_font(CN_BOLD, title, max_w, max_h)
    tb = tf.getbbox(title)
    tx = (inner - (tb[2] - tb[0])) // 2 - tb[0]
    ty = int(inner * 0.70) - tb[1]
    # soft shadow so the text stays readable over the gradient
    shadow = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((tx, ty + max(2, inner // 90)), title, font=tf, fill=(0, 0, 0, 140))
    shadow = shadow.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(max(2, inner // 120)))
    art = Image.alpha_composite(art, shadow)
    ad = ImageDraw.Draw(art)
    ad.text((tx, ty), title, font=tf, fill=(255, 255, 255, 255))

    if pad_frac == 0:
        out = base.convert("RGBA")
        out.alpha_composite(art, (0, 0))
        return out.convert("RGB")

    # maskable: art centred in the safe zone
    out = base.convert("RGBA")
    off = (size - inner) // 2
    out.alpha_composite(art, (off, off))
    return out.convert("RGB")


def main():
    for game, title, emoji, ctop, cbottom in GAMES:
        out_dir = os.path.join(BASE, game, "icons")
        os.makedirs(out_dir, exist_ok=True)

        p192 = os.path.join(out_dir, "icon-192.png")
        render(192, title, emoji, ctop, cbottom, pad_frac=0.0).save(p192, "PNG", optimize=True)

        p512 = os.path.join(out_dir, "icon-512.png")
        render(512, title, emoji, ctop, cbottom, pad_frac=0.09).save(p512, "PNG", optimize=True)

        print(f"  {game}: {os.path.getsize(p192)}B / {os.path.getsize(p512)}B")


if __name__ == "__main__":
    print("generating PWA icons ...")
    main()
    print("done")
