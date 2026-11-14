/** The user's theme: `system` follows the OS; the others pin it. Remembered per browser. */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'agentcats.theme';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Stamp the theme on the root element (the stylesheet reads `data-theme`) and remember it. */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private windows may refuse storage; the theme still applies for this visit.
  }
}
