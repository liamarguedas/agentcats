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
    cat = keep_largest(remove(Image.open(path).convert('RGB'), session=session))
    box = cat.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox()
    if box:
        cat = cat.crop(box)
    side = int(max(cat.size) * (1 + 2 * PAD))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(cat, ((side - cat.width) // 2, side - cat.height - int(side * PAD)))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


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
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
