import { type CatStatus, fallbackVariant } from '@agentcats/protocol';

/** The meme cat cut-outs, by look id (`CAT_VARIANTS`; provenance in docs/assets.md). */
const IMAGES = import.meta.glob<string>('../assets/cats/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

export function catImage(variant: string): string | undefined {
  return IMAGES[`../assets/cats/${variant}.webp`];
}

/** States drawn as props over the photo; the photo itself never changes. */
export type CatLook = CatStatus | 'fired' | 'promoted';

/**
 * A cat: its meme photo with a prop for what it is doing. Each state reads
 * the same on every cat: a laptop for working, a thought cloud for thinking,
 * a question mark when it needs you, sleep when blocked or paused, a check
 * when done, an alarm when it broke, a box when retired, confetti when
 * promoted.
 */
export function CatPhoto({
  catId,
  variant,
  look,
  name,
}: {
  catId: string;
  variant: string | null;
  look: CatLook;
  name: string;
}) {
  const src = catImage(variant ?? fallbackVariant(catId));
  return (
    <div className={`cat-photo cat-photo--${look}`}>
      {src && (
        <img
          className="cat-photo__img"
          src={src}
          alt={`${name}, ${LOOK_TEXT[look]}`}
          draggable={false}
        />
      )}
      <span className="cat-photo__prop" aria-hidden="true">
        {PROP[look]}
      </span>
      {look === 'fired' && <span className="cat-photo__box" aria-hidden="true" />}
    </div>
  );
}

const LOOK_TEXT: Record<CatLook, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting_approval: 'waiting for your approval',
  blocked: 'blocked',
  done: 'done',
  error: 'in trouble',
  fired: 'retired',
  promoted: 'promoted',
};

const PROP: Record<CatLook, string> = {
  idle: '',
  thinking: '…',
  working: '',
  waiting_approval: '?',
  blocked: 'z',
  done: '✓',
  error: '!',
  fired: '',
  promoted: '★',
};
