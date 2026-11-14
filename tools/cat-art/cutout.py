"""Cut the picked meme cats out of their photos for the board.

Each pick in picks.json is cut out with rembg's ISNet model (rembg is MIT, the
ISNet weights Apache-2.0), cropped to the cat, centered on a square and saved
as a 256 px WebP with transparency in packages/ui/src/assets/cats/. The list
of looks goes to packages/protocol/src/cat-variants.json, which the daemon
picks from and the UI draws. Provenance and license: docs/assets.md.

Usage
-----
    python -m venv .venv && .venv/bin/pip install "rembg[cpu]==2.0.86" pillow scipy
    .venv/bin/python tools/cat-art/cutout.py <unzipped dataset folder>

A file name that names its meme (not ``cat (12).jpg``) becomes the cat's
default name; the user can rename the cat on the board.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'packages' / 'ui' / 'src' / 'assets' / 'cats'
MANIFEST = ROOT / 'packages' / 'protocol' / 'src' / 'cat-variants.json'
SIZE = 256
PAD = 0.06
# BiRefNet (MIT): cleaner masks than ISNet on close-up meme faces.
MODEL = 'birefnet-general-lite'
# A side of the photo that cuts through the cat is faded out over this much of it.
FADE = 0.22
TOUCH = 0.04


def meme_name(file_name: str) -> str | None:
    """The cat name a file name suggests, or None for a generic one.

    Parameters
    ----------
    file_name : str
        Base name of the source image, for example ``grumpy_cat.jpg``.

    Returns
    -------
    str or None
        ``"Grumpy Cat"`` for ``grumpy_cat.jpg``; None for names like
        ``cat (12).jpg`` that say nothing about the meme.

    Examples
    --------
    >>> meme_name('grumpy_cat.jpg')
    'Grumpy Cat'
    >>> meme_name('cat (12).jpg') is None
    True
    """
    stem = re.sub(r'\.[a-z0-9]+$', '', file_name, flags=re.I)
    words = [w for w in re.split(r'[\s_\-]+', stem) if w]
    if not words or all(re.fullmatch(r'cats?|\(?\d+\)?|img|image|photo', w, re.I) for w in words):
        return None
    return ' '.join(w.capitalize() for w in words)[:40]


def cut_out(path: Path, session) -> Image.Image:
    """Remove the background, crop to the cat and fit it on a square canvas.

    Parameters
    ----------
    path : Path
        Source photo.
    session
        A rembg session, reused across images.

    Returns
    -------
    PIL.Image.Image
        RGBA image, ``SIZE`` x ``SIZE``, the cat centered with a small margin.
    """
    cat = fade_cut_edges(keep_largest(remove(Image.open(path).convert('RGB'), session=session)))
    box = cat.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox()
    if box:
        cat = cat.crop(box)
    side = int(max(cat.size) * (1 + 2 * PAD))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(cat, ((side - cat.width) // 2, side - cat.height - int(side * PAD)))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def fade_cut_edges(image: Image.Image, band: float = FADE, touch: float = TOUCH) -> Image.Image:
    """Fade the cat out toward each side of the photo that cuts through it.

    A meme photo often crops the cat: its body runs into the frame. Cut out,
    that side ends in a hard straight line, which looks like a pasted
    rectangle on the board. Each side the cat touches along more than
    ``touch`` of its length gets a linear alpha ramp, from fully transparent
    at the frame to unchanged ``band`` of the cat's extent inward.

    Parameters
    ----------
    image : PIL.Image.Image
        RGBA cut-out at the source photo's size, before cropping.
    band : float, default FADE
        Ramp length as a fraction of the cat's width (left and right sides)
        or height (top and bottom).
    touch : float, default TOUCH
        Fraction of a side's length the cat must cover for that side to
        count as a cut. Lower values catch an ear or a paw grazing the frame.

    Returns
    -------
    PIL.Image.Image
        The same image with the ramps applied; unchanged if no side is cut.

    Notes
    -----
    A mask's own soft rim covers a few pixels at most, so the 2 px border
    strip tested here only shows real cuts.
    """
    rgba = np.array(image)
    alpha = rgba[..., 3].astype(np.float32)
    solid = alpha > 24
    if not solid.any():
        return image
    ys, xs = np.nonzero(solid)
    height, width = alpha.shape
    ramp_x = max(2, int((xs.max() - xs.min()) * band))
    ramp_y = max(2, int((ys.max() - ys.min()) * band))
    sides = {
        'left': (solid[:, :2].any(axis=1).mean(), np.arange(width)[None, :], ramp_x),
        'right': (solid[:, -2:].any(axis=1).mean(), (width - 1 - np.arange(width))[None, :], ramp_x),
        'top': (solid[:2, :].any(axis=0).mean(), np.arange(height)[:, None], ramp_y),
        'bottom': (solid[-2:, :].any(axis=0).mean(), (height - 1 - np.arange(height))[:, None], ramp_y),
    }
    for covered, distance, ramp in sides.values():
        if covered > touch:
            alpha *= np.clip(distance / ramp, 0.0, 1.0)
    rgba[..., 3] = alpha.round().astype(np.uint8)
    return Image.fromarray(rgba)


def keep_largest(image: Image.Image) -> Image.Image:
    """Clear every opaque island except the largest: specks the mask left behind.

    Parameters
    ----------
    image : PIL.Image.Image
        RGBA cut-out.

    Returns
    -------
    PIL.Image.Image
        The same image with smaller separate pieces made transparent.
    """
    rgba = np.array(image)
    labels, count = ndimage.label(rgba[..., 3] > 24)
    if count > 1:
        sizes = ndimage.sum(np.ones_like(labels), labels, range(1, count + 1))
        rgba[..., 3][(labels != 0) & (labels != int(np.argmax(sizes)) + 1)] = 0
    return Image.fromarray(rgba)


def main(dataset: Path) -> None:
    """Cut out every pick and write the UI manifest.

    Parameters
    ----------
    dataset : Path
        The unzipped dataset folder, containing ``cats_from_memes/``.
    """
    picks = json.loads((Path(__file__).parent / 'picks.json').read_text(encoding='utf8'))
    session = new_session(MODEL)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for pick in picks['cats']:
        source = dataset / pick['file']
        cut_out(source, session).save(OUT / f"{pick['id']}.webp", 'WEBP', quality=86, method=6)
        manifest.append({'id': pick['id'], 'name': meme_name(source.name)})
        print('cut', pick['id'])
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8', newline='\n')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
