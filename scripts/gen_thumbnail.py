#!/usr/bin/env python3
"""Generate the SCF interest-form thumbnail (1280x720) for Turbolong."""

from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 720
BG = (11, 14, 20)            # #0B0E14
MINT_A = (94, 237, 184)      # #5EEDB8
MINT_B = (45, 232, 163)      # #2DE8A3
WHITE = (245, 247, 250)
DIM = (140, 152, 170)
HAIR = (35, 44, 58)

FONT_PATH = "/System/Library/Fonts/Avenir Next.ttc"
F_HEAVY = lambda s: ImageFont.truetype(FONT_PATH, s, index=8)   # Heavy
F_BOLD = lambda s: ImageFont.truetype(FONT_PATH, s, index=0)    # Bold
F_DEMI = lambda s: ImageFont.truetype(FONT_PATH, s, index=2)    # Demi Bold
F_MED = lambda s: ImageFont.truetype(FONT_PATH, s, index=5)     # Medium
F_REG = lambda s: ImageFont.truetype(FONT_PATH, s, index=7)     # Regular


def radial_glow(size, color, radius_frac=0.6, opacity=110):
    """Soft radial glow disc, returned as RGBA."""
    s = max(size)
    g = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    cx = cy = s // 2
    steps = 60
    for i in range(steps, 0, -1):
        r = int((i / steps) * (s * radius_frac))
        a = int((1 - i / steps) ** 2 * opacity)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*color, a))
    g = g.filter(ImageFilter.GaussianBlur(radius=40))
    return g.resize(size)


def draw_logo(img, x, y, size=44):
    """Replicate the landing-page logo: dim circle border + mint lightning polygon."""
    d = ImageDraw.Draw(img, "RGBA")
    # circle border
    d.ellipse([x, y, x + size, y + size], outline=(45, 232, 163, 110), width=2)
    # polygon points from SVG (viewBox 0..64), scaled to `size`
    src = [(38, 8), (22, 34), (31, 34), (27, 56), (43, 28), (34, 28)]
    pts = [(x + p[0] * size / 64, y + p[1] * size / 64) for p in src]
    d.polygon(pts, fill=MINT_B)


def text_w(draw, text, font):
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    return r - l


def main():
    img = Image.new("RGB", (W, H), BG)

    # Background mint glow, top-right
    glow = radial_glow((900, 900), MINT_B, radius_frac=0.55, opacity=70)
    img.paste(glow, (W - 700, -300), glow)
    # Secondary glow, bottom-left, dimmer
    glow2 = radial_glow((700, 700), MINT_A, radius_frac=0.5, opacity=40)
    img.paste(glow2, (-250, H - 350), glow2)

    d = ImageDraw.Draw(img, "RGBA")

    # ---- top-left brand row ----
    pad_x = 72
    draw_logo(img, pad_x, 60, size=44)
    brand_font = F_BOLD(28)
    d.text((pad_x + 60, 68), "TURBO", font=brand_font, fill=WHITE)
    turbo_w = text_w(d, "TURBO", brand_font)
    d.text((pad_x + 60 + turbo_w, 68), "LONG", font=brand_font, fill=MINT_B)

    # ---- top-right "SCF Build • Integration Track" pill ----
    pill_text = "SCF BUILD  •  INTEGRATION TRACK"
    pill_font = F_DEMI(16)
    pw = text_w(d, pill_text, pill_font)
    pill_x2 = W - pad_x
    pill_x1 = pill_x2 - pw - 32
    pill_y1, pill_y2 = 64, 100
    d.rounded_rectangle(
        [pill_x1, pill_y1, pill_x2, pill_y2],
        radius=18,
        outline=(94, 237, 184, 160),
        width=1,
        fill=(45, 232, 163, 22),
    )
    d.text((pill_x1 + 16, pill_y1 + 9), pill_text, font=pill_font, fill=MINT_A)

    # ---- hero ----
    title1 = "Leveraged DeFi"
    title2 = "on Stellar."
    f_title = F_HEAVY(108)

    title_y = 188
    d.text((pad_x, title_y), title1, font=f_title, fill=WHITE)
    # second line: "on " in white, "Stellar." in mint
    on_w = text_w(d, "on ", f_title)
    d.text((pad_x, title_y + 118), "on ", font=f_title, fill=WHITE)
    d.text((pad_x + on_w, title_y + 118), "Stellar.", font=f_title, fill=MINT_B)

    # tagline
    tag = "One-click recursive Blend loops.  Up to 12.9x leverage.  Sub-5s finality."
    f_tag = F_MED(26)
    d.text((pad_x, title_y + 256), tag, font=f_tag, fill=DIM)

    # ---- stats strip ----
    stats = [
        ("3", "POOLS"),
        ("8+", "ASSETS"),
        ("12.9x", "MAX LEVERAGE"),
        ("<5s", "FINALITY"),
    ]
    strip_y = H - 132
    strip_h = 92
    strip_x1 = pad_x
    strip_x2 = W - pad_x
    d.rounded_rectangle(
        [strip_x1, strip_y, strip_x2, strip_y + strip_h],
        radius=14,
        outline=HAIR,
        width=1,
        fill=(20, 26, 36, 180),
    )
    cell_w = (strip_x2 - strip_x1) / len(stats)
    f_val = F_HEAVY(40)
    f_lbl = F_DEMI(13)
    for i, (val, lbl) in enumerate(stats):
        cx = strip_x1 + cell_w * (i + 0.5)
        vw = text_w(d, val, f_val)
        lw = text_w(d, lbl, f_lbl)
        d.text((cx - vw / 2, strip_y + 14), val, font=f_val, fill=MINT_B)
        d.text((cx - lw / 2, strip_y + 62), lbl, font=f_lbl, fill=DIM)
        if i < len(stats) - 1:
            sx = strip_x1 + cell_w * (i + 1)
            d.line([sx, strip_y + 22, sx, strip_y + strip_h - 22], fill=HAIR, width=1)

    # ---- integrations row above stats ----
    integ_y = H - 192
    integ_label = "BUILT ON"
    f_il = F_DEMI(13)
    f_in = F_DEMI(18)
    d.text((pad_x, integ_y), integ_label, font=f_il, fill=DIM)
    label_w = text_w(d, integ_label, f_il)
    items = ["BLEND", "DEFINDEX", "STELLAR BROKER", "ETHERFUSE", "NEAR INTENTS"]
    cursor_x = pad_x + label_w + 22
    for i, name in enumerate(items):
        if i > 0:
            d.text((cursor_x, integ_y - 2), "/", font=f_in, fill=HAIR)
            cursor_x += text_w(d, "/", f_in) + 14
        d.text((cursor_x, integ_y - 2), name, font=f_in, fill=WHITE)
        cursor_x += text_w(d, name, f_in) + 14

    out = "/Users/soyer/claude/turbolong/landing/scf-thumbnail.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out}  ({W}x{H})")


if __name__ == "__main__":
    main()
