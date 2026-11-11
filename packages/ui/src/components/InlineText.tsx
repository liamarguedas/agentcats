/**
 * Agent text with `inline code` and **bold** rendered. Everything else stays
 * plain text; no HTML from the agent is ever interpreted.
 */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part;
      })}
    </>
  );
}
