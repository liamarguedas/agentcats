import manifest from './cat-variants.json' with { type: 'json' };

/**
 * The looks a cat can have: one meme cat each, cut out of its photo by
 * `tools/cat-art/cutout.py` (provenance in `docs/assets.md`). `name` is the
 * meme's name when the source file gave one, used as the cat's default name.
 */
export const CAT_VARIANTS: readonly { readonly id: string; readonly name: string | null }[] =
  manifest;

/** A stable look for a cat created before looks existed, from its id. */
export function fallbackVariant(catId: string): string {
  let hash = 0;
  for (const char of catId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CAT_VARIANTS[hash % CAT_VARIANTS.length]?.id ?? '';
}

/**
 * A look for a new cat: one the fewest cats have, so the board stays easy to
 * tell apart; ties are broken at random.
 */
export function pickVariant(
  inUse: readonly (string | null)[],
  random: () => number = Math.random,
): string {
  const count = (id: string) => inUse.filter((v) => v === id).length;
  const least = Math.min(...CAT_VARIANTS.map((v) => count(v.id)));
  const choices = CAT_VARIANTS.filter((v) => count(v.id) === least);
  return choices[Math.floor(random() * choices.length)]?.id ?? '';
}
