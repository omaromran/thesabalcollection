#!/usr/bin/env python3
"""Sabal festival booth server: static files plus AI portrait compose."""

from __future__ import annotations

import io
import threading
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from rembg import new_session, remove

ROOT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1920, 1080

THEMES = {
    "winter-fireside": {
        "background": "assets/themes/winter-fireside.jpg",
        "scent": "Clove & Smoked Vanilla",
        "clothing": "cream knit sweaters and a soft wool scarf",
        "candle": {"x": 0.84, "y": 0.74, "scale": 0.3},
        "subject": {"scale": 0.78, "y": 0.08},
        "tint": (255, 132, 52),
        "warm": 0.22,
        "dark": 0.1,
    },
    "mykonos": {
        "background": "assets/themes/mykonos.jpg",
        "scent": "Mykonos Sunset",
        "clothing": "linen and warm sunset light",
        "candle": {"x": 0.86, "y": 0.76, "scale": 0.26},
        "subject": {"scale": 0.76, "y": 0.1},
        "tint": (255, 168, 88),
        "warm": 0.26,
        "dark": 0.06,
    },
    "autumn": {
        "background": "assets/themes/autumn-orchard.jpg",
        "scent": "Toasted Vanilla Pumpkin",
        "clothing": "harvest flannel and golden hour light",
        "candle": {"x": 0.85, "y": 0.75, "scale": 0.28},
        "subject": {"scale": 0.8, "y": 0.08},
        "tint": (232, 120, 40),
        "warm": 0.24,
        "dark": 0.08,
    },
    "winter-woods": {
        "background": "assets/themes/winter-woods.jpg",
        "scent": "Winter Woods",
        "clothing": "wool coats in cool pine light",
        "candle": {"x": 0.83, "y": 0.73, "scale": 0.29},
        "subject": {"scale": 0.8, "y": 0.06},
        "tint": (180, 210, 230),
        "warm": 0.08,
        "dark": 0.12,
    },
    "champagne": {
        "background": "assets/themes/champagne-night.jpg",
        "scent": "Oud & Rose",
        "clothing": "evening black and gold candlelight",
        "candle": {"x": 0.86, "y": 0.74, "scale": 0.27},
        "subject": {"scale": 0.76, "y": 0.08},
        "tint": (212, 176, 80),
        "warm": 0.16,
        "dark": 0.14,
    },
    "holiday": {
        "background": "assets/themes/holiday-hearth.jpg",
        "scent": "Holiday Mulled Cider",
        "clothing": "festive knits by firelight",
        "candle": {"x": 0.84, "y": 0.74, "scale": 0.29},
        "subject": {"scale": 0.78, "y": 0.08},
        "tint": (255, 110, 48),
        "warm": 0.22,
        "dark": 0.1,
    },
}

app = Flask(__name__, static_folder=None)
SESSION = None
SESSION_LOCK = threading.Lock()


def get_session():
    global SESSION
    with SESSION_LOCK:
        if SESSION is None:
            SESSION = new_session()
        return SESSION


def warmup():
    tiny = Image.new("RGB", (64, 64), (40, 30, 20))
    remove(tiny, session=get_session())


def open_rgb(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def fit_cover(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    resized = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def extract_subject(photo: Image.Image) -> Image.Image:
    photo = photo.convert("RGB")
    photo.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    cutout = remove(photo, session=get_session())
    if cutout.mode != "RGBA":
        cutout = cutout.convert("RGBA")
    arr = np.array(cutout).astype(np.float32)
    rgb, alpha = arr[:, :, :3], arr[:, :, 3]
    src = np.array(photo)
    h, w = src.shape[:2]
    corners = np.stack(
        [
            src[0, 0],
            src[0, w - 1],
            src[h - 1, 0],
            src[h - 1, w - 1],
            src[4, 4],
            src[4, w - 5],
            src[h - 5, 4],
            src[h - 5, w - 5],
        ]
    ).mean(axis=0)
    # Un-mix original backdrop from fringe so edges are not a white sticker halo.
    a = np.clip(alpha / 255.0, 0.001, 1.0)[..., None]
    fg = (rgb - corners * (1 - a)) / a
    rgb = np.clip(fg, 0, 255)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    choked = cv2.erode((alpha > 18).astype(np.uint8), kernel, iterations=1) * 255
    alpha = cv2.GaussianBlur(choked.astype(np.float32), (15, 15), 0)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    cutout = Image.fromarray(out, "RGBA")
    bbox = cutout.getbbox()
    if not bbox:
        raise ValueError("Could not find a person or pet in the photo")
    return cutout.crop(bbox)


def scale_subject(subject: Image.Image, theme: dict) -> Image.Image:
    target_h = int(HEIGHT * max(0.88, theme["subject"]["scale"] + 0.14))
    ratio = target_h / max(subject.height, 1)
    size = (max(1, int(subject.width * ratio)), target_h)
    return subject.resize(size, Image.Resampling.LANCZOS)


def subject_placement(subject: Image.Image, theme: dict) -> tuple[int, int]:
    x = (WIDTH - subject.width) // 2 - int(WIDTH * 0.04)
    y = HEIGHT - subject.height - 88
    y = max(12, min(HEIGHT - subject.height - 88, y))
    x = max(20, min(WIDTH - subject.width - 220, x))
    return x, y


def feather_alpha(alpha: np.ndarray, pixels: int = 14) -> np.ndarray:
    binary = (alpha > 20).astype(np.uint8)
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    soft = np.clip(dist / max(pixels, 1), 0, 1)
    return (soft * np.maximum(alpha, 1)).astype(np.uint8)


def reinhard_match(subject_rgb: np.ndarray, target_rgb: np.ndarray, alpha: np.ndarray, strength: float = 0.72):
    mask = alpha > 24
    if mask.sum() < 200:
        return subject_rgb
    src = cv2.cvtColor(subject_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    dst = cv2.cvtColor(target_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    for c in range(3):
        src_c = src[:, :, c][mask]
        dst_c = dst[:, :, c]
        src_mean, src_std = float(src_c.mean()), float(src_c.std() + 1e-6)
        dst_mean, dst_std = float(dst_c.mean()), float(dst_c.std() + 1e-6)
        mapped = (src[:, :, c] - src_mean) * (dst_std / src_std) + dst_mean
        src[:, :, c] = src[:, :, c] * (1 - strength) + mapped * strength
    src = np.clip(src, 0, 255).astype(np.uint8)
    return cv2.cvtColor(src, cv2.COLOR_LAB2RGB)


PROMPTS = {
    "winter-fireside": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally sitting in a luxury winter cabin by a roaring stone fireplace, "
        "snowy pines in the window. Dress them in cream knit sweaters. Warm firelight wraps their skin. "
        "Soft natural shadows. A lit matte black luxury candle on a wood table in the foreground. "
        "Cinematic 16:9 photoreal editorial. No cutout, no sticker, no white halo, no collage."
    ),
    "mykonos": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally on a Mykonos sunset terrace under a cream umbrella, Aegean sea behind them. "
        "Linen clothes, golden hour light wrapping their skin. Soft natural shadows. "
        "A lit matte black luxury candle on a white ledge in the foreground. "
        "Cinematic 16:9 photoreal travel editorial. No cutout, no sticker, no white halo, no collage."
    ),
    "autumn": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally in a golden apple orchard at sunset with falling maple leaves. "
        "Flannel and knit layers. Warm amber light wrapping their skin. Soft natural shadows. "
        "A lit matte black luxury candle on a rustic table in the foreground. "
        "Cinematic 16:9 photoreal editorial. No cutout, no sticker, no white halo, no collage."
    ),
    "winter-woods": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally on a snowy cabin porch among pine trees and lanterns at dusk. "
        "Wool coats. Cool twilight mixed with warm porch light. Soft natural shadows in snow. "
        "A lit matte black luxury candle in the foreground. "
        "Cinematic 16:9 photoreal editorial. No cutout, no sticker, no white halo, no collage."
    ),
    "champagne": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally in a midnight penthouse with city lights and gold candelabras. "
        "Black-tie evening clothes. Warm candlelight on their skin. Soft natural shadows. "
        "A lit matte black luxury candle in the foreground. "
        "Cinematic 16:9 photoreal editorial. No cutout, no sticker, no white halo, no collage."
    ),
    "holiday": (
        "Keep this exact person and their exact pet — same real faces. "
        "Photograph them naturally by a decorated Christmas tree and fireplace in cream and burgundy knits. "
        "Warm holiday lights wrapping their skin. Soft natural shadows. "
        "A lit matte black luxury candle in the foreground. "
        "Cinematic 16:9 photoreal editorial. No cutout, no sticker, no white halo, no collage."
    ),
}

SCENE_LIGHT = {
    "winter-fireside": (255, 132, 48),
    "mykonos": (255, 156, 72),
    "autumn": (232, 118, 40),
    "winter-woods": (190, 210, 230),
    "champagne": (220, 176, 78),
    "holiday": (255, 112, 48),
}


def relight_from_scene(subject_rgb: np.ndarray, scene_rgb: np.ndarray, alpha: np.ndarray, theme_id: str) -> np.ndarray:
    gray = cv2.cvtColor(subject_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    muted = np.dstack([gray, gray, gray]) * 0.42 + subject_rgb.astype(np.float32) * 0.58
    light = cv2.GaussianBlur(scene_rgb.astype(np.float32), (0, 0), 36)
    mean = np.maximum(light.mean(axis=(0, 1), keepdims=True), 16)
    gain = np.clip(light / mean, 0.5, 2.1)
    tint = np.array(SCENE_LIGHT.get(theme_id, (255, 150, 70)), dtype=np.float32)
    wash = muted * (gain * 0.72) + tint * 0.28
    # Directional wrap: warmer on the left for fire/sunset scenes.
    ramp = np.linspace(1.18, 0.82, subject_rgb.shape[1], dtype=np.float32)
    wash *= ramp[None, :, None]
    mask = (alpha.astype(np.float32) / 255.0)[..., None]
    return np.clip(muted * (1 - mask) + wash * mask, 0, 255).astype(np.uint8)


def light_wrap(subject_rgba: Image.Image, backdrop: Image.Image, x: int, y: int) -> Image.Image:
    rgb = np.array(subject_rgba.convert("RGB")).astype(np.float32)
    alpha = np.array(subject_rgba.split()[-1]).astype(np.float32)
    sample = np.array(
        backdrop.crop((x, y, x + subject_rgba.width, y + subject_rgba.height)).convert("RGB")
    ).astype(np.float32)
    blurred = cv2.GaussianBlur(alpha, (0, 0), 12)
    edge = np.clip((blurred / 255.0) * (1.0 - alpha / 255.0) * 3.4, 0, 1)[..., None]
    mixed = rgb * (1 - edge * 0.7) + sample * (edge * 0.7)
    out = np.dstack([np.clip(mixed, 0, 255), alpha]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def draw_contact_shadow(base: Image.Image, subject: Image.Image, x: int, y: int) -> None:
    shadow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    cx = x + subject.width * 0.5
    cy = min(HEIGHT - 130, y + subject.height * 0.93)
    rx = subject.width * 0.28
    ry = 22
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base.alpha_composite(shadow)


def poisson_blend(backdrop: Image.Image, subject: Image.Image, x: int, y: int) -> Image.Image:
    dest = cv2.cvtColor(np.array(backdrop.convert("RGB")), cv2.COLOR_RGB2BGR)
    src_rgba = np.array(subject)
    src = cv2.cvtColor(src_rgba[:, :, :3], cv2.COLOR_RGB2BGR)
    alpha = src_rgba[:, :, 3]
    mask = cv2.GaussianBlur(alpha, (0, 0), 1.8)
    _, mask = cv2.threshold(mask, 18, 255, cv2.THRESH_BINARY)
    mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=1)
    mask = cv2.GaussianBlur(mask, (9, 9), 0)
    if int(mask.max()) < 32:
        raise ValueError("empty mask")

    # Keep the source fully inside the destination — seamlessClone fails at the rim.
    x = max(8, min(WIDTH - src.shape[1] - 8, x))
    y = max(8, min(HEIGHT - src.shape[0] - 8, y))
    center = (x + src.shape[1] // 2, y + src.shape[0] // 2)
    mode = getattr(cv2, "NORMAL_CLONE_WIDE", cv2.NORMAL_CLONE)
    blended = cv2.seamlessClone(src, dest, mask, center, mode)
    return Image.fromarray(cv2.cvtColor(blended, cv2.COLOR_BGR2RGB))


def alpha_blend(backdrop: Image.Image, subject: Image.Image, x: int, y: int) -> Image.Image:
    layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    soft = subject.copy()
    alpha = soft.split()[-1].filter(ImageFilter.GaussianBlur(2.4))
    soft.putalpha(alpha)
    layer.paste(soft, (x, y), soft)
    out = backdrop.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


def apply_grade(image: Image.Image, theme: dict) -> Image.Image:
    rgb = np.array(image).astype(np.float32)
    tint = np.array(theme["tint"], dtype=np.float32)
    warm = theme["warm"]
    dark = theme["dark"]
    soft = rgb * (1 - warm) + (255 - (255 - rgb) * (255 - tint) / 255.0) * warm
    mul = rgb * (1 - dark) * np.array([0.96, 0.93, 0.90])
    mixed = np.clip(soft * 0.62 + mul * 0.38, 0, 255).astype(np.uint8)
    graded = Image.fromarray(mixed)
    overlay = Image.new("RGB", graded.size, tuple(int(c) for c in tint))
    return Image.blend(graded, overlay, 0.14)


def draw_candle(image: Image.Image, theme: dict) -> Image.Image:
    candle = Image.open(ROOT / "assets/candle.png").convert("RGBA")
    candle_h = int(HEIGHT * theme["candle"]["scale"])
    candle_w = int(candle.width * candle_h / candle.height)
    candle = candle.resize((candle_w, candle_h), Image.Resampling.LANCZOS)
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    cx = int(WIDTH * theme["candle"]["x"] - candle_w / 2)
    cy = int(HEIGHT * theme["candle"]["y"] - candle_h / 2)
    blob = Image.new("RGBA", (candle_w + 80, candle_h + 80), (0, 0, 0, 0))
    draw = ImageDraw.Draw(blob)
    draw.ellipse((10, 8, candle_w + 70, 90), fill=(255, 170, 70, 70))
    blob = blob.filter(ImageFilter.GaussianBlur(22))
    glow.paste(blob, (cx - 40, cy - 40), blob)
    out = image.convert("RGBA")
    out.alpha_composite(glow)
    out.alpha_composite(candle, (cx, cy))
    return out


def draw_brand(image: Image.Image, theme: dict) -> Image.Image:
    out = image.convert("RGBA")
    bar = Image.new("RGBA", (WIDTH, 92), (8, 7, 6, 150))
    out.alpha_composite(bar, (0, HEIGHT - 92))
    logo = Image.open(ROOT / "assets/logo-gold.png").convert("RGBA")
    logo.thumbnail((220, 72), Image.Resampling.LANCZOS)
    out.alpha_composite(logo, (36, HEIGHT - 82))
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
        small = font
    draw.text((WIDTH - 40, HEIGHT - 62), "FESTIVAL PORTRAIT", font=font, fill=(243, 234, 215, 255), anchor="rt")
    draw.text((WIDTH - 40, HEIGHT - 32), theme["scent"].upper(), font=small, fill=(197, 181, 25, 255), anchor="rt")
    return out.convert("RGB")


def generate_with_flux(photo: Image.Image, theme_id: str) -> Image.Image:
    from gradio_client import Client, handle_file

    buf = io.BytesIO()
    photo.convert("RGB").save(buf, format="JPEG", quality=90)
    tmp = Path("/tmp") / f"sabal-guest-{threading.get_ident()}.jpg"
    tmp.write_bytes(buf.getvalue())
    client = Client("black-forest-labs/FLUX.1-Kontext-Dev")
    result = client.predict(
        input_image=handle_file(str(tmp)),
        prompt=PROMPTS.get(theme_id, PROMPTS["winter-fireside"]),
        seed=0,
        randomize_seed=True,
        guidance_scale=2.5,
        steps=28,
        api_name="/infer",
    )
    path = result[0] if isinstance(result, (list, tuple)) else result
    if isinstance(path, dict):
        path = path.get("path")
    image = Image.open(path).convert("RGB")
    return fit_cover(image, WIDTH, HEIGHT)


def compose_locally(photo: Image.Image, theme_id: str) -> Image.Image:
    theme = THEMES.get(theme_id) or THEMES["winter-fireside"]
    background = fit_cover(open_rgb(ROOT / theme["background"]), WIDTH, HEIGHT)
    subject = scale_subject(extract_subject(photo), theme)
    x, y = subject_placement(subject, theme)

    region = background.crop((x, y, x + subject.width, y + subject.height))
    rgb = np.array(subject.convert("RGB"))
    alpha = feather_alpha(np.array(subject.split()[-1]), 16)
    rgb = cv2.GaussianBlur(rgb, (3, 3), 0)
    rgb = relight_from_scene(rgb, np.array(region), alpha, theme_id)
    rgb = reinhard_match(rgb, np.array(region), alpha, strength=0.62)
    subject = Image.fromarray(np.dstack([rgb, alpha]))
    subject = light_wrap(subject, background, x, y)

    scene = background.convert("RGBA")
    draw_contact_shadow(scene, subject, x, y)
    blended = alpha_blend(scene, subject, x, y)
    graded = apply_grade(blended, theme)
    with_candle = draw_candle(graded, theme)
    return draw_brand(with_candle, theme)


def compose_portrait(photo: Image.Image, theme_id: str) -> Image.Image:
    theme = THEMES.get(theme_id) or THEMES["winter-fireside"]
    try:
        generated = generate_with_flux(photo, theme_id)
        return draw_brand(generated, theme)
    except Exception as error:
        print("FLUX compose failed, using local blend:", error)
        return compose_locally(photo, theme_id)


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "ready": SESSION is not None})


@app.post("/api/warmup")
@app.get("/api/warmup")
def warmup_route():
    warmup()
    return jsonify({"ok": True})


@app.post("/api/compose")
def compose_route():
    theme_id = request.form.get("theme") or (request.json or {}).get("theme")
    upload = request.files.get("photo")
    if upload is None:
        return jsonify({"error": "photo required"}), 400
    photo = Image.open(upload.stream).convert("RGB")
    result = compose_portrait(photo, theme_id or "winter-fireside")
    buf = io.BytesIO()
    result.save(buf, format="JPEG", quality=90, optimize=True)
    buf.seek(0)
    return send_file(buf, mimetype="image/jpeg")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def static_files(path: str):
    if path == "" or path.endswith("/"):
        path = "index.html"
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    threading.Thread(target=warmup, daemon=True).start()
    app.run(host="0.0.0.0", port=4173, threaded=True)
