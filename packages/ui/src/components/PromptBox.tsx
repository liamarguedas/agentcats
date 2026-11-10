import { type KeyboardEvent, type SyntheticEvent, useState } from 'react';

export interface PromptBoxProps {
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onSubmit: (text: string) => Promise<void>;
}

/** Enter sends, Shift+Enter adds a line. */
export function PromptBox({ disabled, placeholder, onSubmit }: PromptBoxProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !sending && text.trim().length > 0;

  async function submit(e?: SyntheticEvent) {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit(text.trim());
      setText('');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form className="prompt" onSubmit={(e) => void submit(e)}>
      <label className="visually-hidden" htmlFor="prompt-input">
        Task for the cat
      </label>
      <textarea
        id="prompt-input"
        className="prompt__input"
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="button button--primary" disabled={!canSend}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}
