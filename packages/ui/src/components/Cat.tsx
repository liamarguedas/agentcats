import type { CatStatus } from '@agentcats/protocol';

/**
 * Placeholder cat, drawn in SVG and animated with CSS per status. One pose per
 * status, as the milestones ask; real sprites arrive in M5.
 */
export function CatSprite({ status }: { status: CatStatus }) {
  return (
    <svg
      className={`cat cat--${status}`}
      viewBox="0 0 220 200"
      role="img"
      aria-label={`Cat, ${status.replace('_', ' ')}`}
    >
      <g className="cat__tail">
        <path d="M160 150 C 200 145, 205 105, 185 90" />
      </g>
      <g className="cat__body">
        <ellipse cx="110" cy="148" rx="58" ry="40" />
      </g>
      <g className="cat__head">
        <path className="cat__ear" d="M66 62 L72 18 L102 46 Z" />
        <path className="cat__ear" d="M154 62 L148 18 L118 46 Z" />
        <path className="cat__ear-inner" d="M73 52 L77 30 L92 45 Z" />
        <path className="cat__ear-inner" d="M147 52 L143 30 L128 45 Z" />
        <circle className="cat__face" cx="110" cy="80" r="47" />
        <Eyes status={status} />
        <path className="cat__nose" d="M104 92 L116 92 L110 99 Z" />
        <path className="cat__mouth" d="M100 104 Q 105 109, 110 103 Q 115 109, 120 104" />
        <g className="cat__whiskers">
          <path d="M60 92 L88 96" />
          <path d="M60 102 L88 101" />
          <path d="M160 92 L132 96" />
          <path d="M160 102 L132 101" />
        </g>
      </g>
      <g className="cat__laptop">
        <path className="cat__laptop-screen" d="M68 150 L152 150 L146 112 L74 112 Z" />
        <rect className="cat__laptop-base" x="56" y="150" width="108" height="9" rx="3" />
        <circle className="cat__laptop-logo" cx="110" cy="131" r="4" />
      </g>
      <g className="cat__paws">
        <ellipse className="cat__paw cat__paw--left" cx="84" cy="160" rx="13" ry="8" />
        <ellipse className="cat__paw cat__paw--right" cx="136" cy="160" rx="13" ry="8" />
      </g>
    </svg>
  );
}

function Eyes({ status }: { status: CatStatus }) {
  if (status === 'done') {
    return (
      <g className="cat__eyes cat__eyes--happy">
        <path d="M84 80 Q 92 70, 100 80" />
        <path d="M120 80 Q 128 70, 136 80" />
      </g>
    );
  }
  if (status === 'error') {
    return (
      <g className="cat__eyes cat__eyes--x">
        <path d="M86 72 L98 84 M98 72 L86 84" />
        <path d="M122 72 L134 84 M134 72 L122 84" />
      </g>
    );
  }
  return (
    <g className="cat__eyes">
      <ellipse cx="92" cy="78" rx="6" ry="8" />
      <ellipse cx="128" cy="78" rx="6" ry="8" />
      <circle className="cat__eye-shine" cx="94" cy="75" r="2" />
      <circle className="cat__eye-shine" cx="130" cy="75" r="2" />
    </g>
  );
}
