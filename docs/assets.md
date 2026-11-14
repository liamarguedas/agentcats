# Assets

Every image, sound and font that ships with agentcats, where it came from, and under what terms.

## Meme cats (`packages/ui/src/assets/cats/*.webp`)

**Source:** the Kaggle dataset ["Cats from memes"](https://www.kaggle.com/datasets/vekosek/cats-from-memes) by vekosek3000, version 5, downloaded 2026-11-14.
The 17 files used are listed with their dataset paths in `tools/cat-art/picks.json`.

**License as labeled:** the dataset page lists **Apache 2.0**.

**Known risk, recorded on purpose:** the uploader's description says they "collected cat faces from memes".
The photos were taken by other people, so the uploader may not hold the rights the Apache 2.0 label claims to grant, and some meme cats are also trademarks of their owners.
The maintainer chose to ship them on 2026-11-14 after this was raised (`docs/decisions.md`, M5 art decision).
If a rights holder objects, remove the image, drop its entry from `tools/cat-art/picks.json`, and rerun the cut-out tool; cats with that look fall back to another one.

**How they were made:** `tools/cat-art/cutout.py` removes the background with rembg 2.0.86 (MIT) and the BiRefNet-lite model (MIT). It keeps only the largest piece of the mask, crops to the cat, and saves a 256 px WebP with transparency.
Nothing was drawn or retouched by hand.

**Names:** a source file that names its meme gives the cat a default name.
This dataset's files are named `cat (N).jpg`, so none do.

## Everything else

- **The placeholder SVG cat** (`packages/ui/src/components/Cat.tsx`) and all icons and props on the board: drawn for agentcats in code, MIT like the rest of the repository.
- **Fonts:** none shipped. The UI uses the system font stack. Meme captions use Impact, or Arial Black when Impact is missing, from the user's system.
- **Chart colors:** the data-viz reference palette, a set of hex values, not an asset with a license.
