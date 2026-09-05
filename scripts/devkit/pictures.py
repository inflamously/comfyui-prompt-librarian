"""Stand-in renders for word pictures, so the feature can be seen without ComfyUI.

A "render" is a placeholder: a gradient in a colour derived from the word, one
simple shape and the word itself. Deterministic per word, so the same word
always looks the same, and obviously fake, so nobody mistakes it for a model's
output.

Three consumers:

  * :func:`seed_pictures` gives a seeded library pictures for its most used
    words, through the real ``attach_word_image`` use-case;
  * :func:`run_prompt` is the dev server's ``POST /api/prompt``: it takes the
    API-format prompt the word-picture generator queues and "renders" the
    Librarian node's text;
  * :func:`sample_image` puts an image in the fake output directory for the
    harness's image node, to try "Use as picture for word…".
"""

import hashlib
import itertools
import os
import re
import tempfile

#: ComfyUI's image ``type`` -> the scratch subdirectory standing in for it.
KINDS = ("output", "input", "temp")
#: A fresh play library has a picture for every candidate word except this
#: many of the least used, which are left for "Generate word pictures…". The
#: preview only shows the highlighted suggestion, so sparse seeding looks broken.
LEFT_TO_GENERATE = 100

_LATENT = re.compile(r"^Empty\w*Latent")
_OUTPUTS = {"SaveImage": "output", "PreviewImage": "temp"}
_counter = itertools.count(1)


def comfy_dirs(scratch_root):
    """``{kind: directory}`` for the fake ComfyUI output, input and temp folders."""
    return {kind: os.path.join(scratch_root, "comfy", kind) for kind in KINDS}


def render_word(word, width=512, height=512):
    """A placeholder picture of ``word`` as a PIL image."""
    from PIL import Image, ImageDraw, ImageFont

    digest = hashlib.sha1(word.casefold().encode("utf-8")).digest()  # noqa: S324 - a colour, not a secret
    hue = digest[0] / 255
    top, bottom = _colour(hue, 0.55, 0.85), _colour((hue + 0.12) % 1, 0.7, 0.35)
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / max(1, height - 1)
        fill = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom, strict=True))
        draw.line([(0, y), (width, y)], fill=fill)

    side = min(width, height)
    r = side * (0.18 + digest[1] / 255 * 0.12)
    cx = width * (0.3 + digest[2] / 255 * 0.4)
    cy = height * (0.3 + digest[3] / 255 * 0.25)
    shade = _colour((hue + 0.5) % 1, 0.45, 0.95)
    box = [cx - r, cy - r, cx + r, cy + r]
    shape = digest[4] % 3
    if shape == 0:
        draw.ellipse(box, fill=shade)
    elif shape == 1:
        draw.rounded_rectangle(box, radius=r * 0.25, fill=shade)
    else:
        draw.polygon([(cx, cy - r), (cx + r, cy + r * 0.8), (cx - r, cy + r * 0.8)], fill=shade)

    text = word.strip() or "?"
    size = max(12, int(side * 0.16))
    font = ImageFont.load_default(size=size)
    while size > 12 and draw.textlength(text, font=font) > width * 0.9:
        size -= 4
        font = ImageFont.load_default(size=size)
    anchor = (width / 2, height * 0.82)
    draw.text(anchor, text, font=font, anchor="mm", fill="white",
              stroke_width=max(1, size // 12), stroke_fill=(0, 0, 0))
    return image


def _colour(hue, saturation, value):
    import colorsys

    return tuple(round(c * 255) for c in colorsys.hsv_to_rgb(hue, saturation, value))


def _save(image, folder, prefix):
    os.makedirs(folder, exist_ok=True)
    name = f"{prefix}_{next(_counter):05d}_.png"
    image.save(os.path.join(folder, name))
    return name


def seed_pictures(dev_app, leave=LEFT_TO_GENERATE):
    """Attach placeholder pictures to every candidate word but the ``leave`` least used."""
    from prompt_librarian import app
    from prompt_librarian.features.word_images import attach_word_image

    words, _total = app.word_picture_candidates(dev_app, 5000)
    words = words[:max(0, len(words) - leave)]
    root = app.word_images_dir(dev_app)
    with tempfile.TemporaryDirectory(dir=os.path.dirname(dev_app.lib.path)) as scratch:
        for word in words:
            path = os.path.join(scratch, _save(render_word(word, 256, 256), scratch, "seed"))
            attach_word_image(root, word, path, "generated")
    return len(words)


def run_prompt(prompt, dirs):
    """Render an API-format prompt the way the word-picture generator expects.

    Returns:
        ``{node_id: {"images": [{filename, subfolder, type}]}}`` for every Save
        or Preview Image node, as ComfyUI's ``executed`` events report them.

    Raises:
        ValueError: The prompt has no Librarian text or no image output,
            which ComfyUI would also reject.
    """
    if not isinstance(prompt, dict):
        raise ValueError("prompt is not an object")
    nodes = {k: v for k, v in prompt.items() if isinstance(v, dict)}
    texts = [n.get("inputs", {}).get("text") for n in nodes.values()
             if n.get("class_type") == "PromptLibrarian"]
    text = next((t for t in texts if isinstance(t, str)), None)
    if text is None:
        raise ValueError("no Prompt Librarian node with its own text")
    outputs = {k: _OUTPUTS[n.get("class_type")] for k, n in nodes.items()
               if n.get("class_type") in _OUTPUTS}
    if not outputs:
        raise ValueError("Prompt has no outputs")
    width, height = _latent_size(nodes.values())
    image = render_word(text, width, height)
    return {
        node_id: {"images": [{"filename": _save(image, dirs[kind], f"dev_{kind}"),
                              "subfolder": "", "type": kind}]}
        for node_id, kind in outputs.items()
    }


def _latent_size(nodes):
    for node in nodes:
        inputs = node.get("inputs", {})
        if _LATENT.match(str(node.get("class_type", ""))):
            width, height = inputs.get("width"), inputs.get("height")
            if isinstance(width, int) and isinstance(height, int):
                return max(64, min(width, 2048)), max(64, min(height, 2048))
    return 512, 512


def sample_image(dirs, label):
    """An image in the fake output folder, as ComfyUI's ``/view`` names it."""
    return {"filename": _save(render_word(label, 512, 512), dirs["output"], "dev_sample"),
            "subfolder": "", "type": "output"}
