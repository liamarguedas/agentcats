/** First letter upper case, the rest unchanged. */
export function capitalize(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** Cut `text` to at most `max` characters, ending with an ellipsis when cut. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
