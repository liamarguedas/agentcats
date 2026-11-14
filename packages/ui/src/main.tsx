import { TOKEN_FRAGMENT_KEY } from '@agentcats/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { BoardClient } from './board-client.js';
import './styles.css';
import { applyTheme, storedTheme } from './theme.js';

const TOKEN_STORAGE_KEY = 'agentcats.token';

/**
 * The CLI opens `/#token=...`. Move the token into session storage and strip
 * it from the address bar so it does not end up in screenshots or history.
 */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get(TOKEN_FRAGMENT_KEY);
  if (fromHash) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

// Before the first paint, so a pinned theme never flashes the other one.
applyTheme(storedTheme());

const root = createRoot(document.getElementById('root') as HTMLElement);
const token = takeToken();

if (token) {
  const client = new BoardClient({ baseUrl: location.origin, token });
  client.start();
  root.render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
} else {
  root.render(
    <main className="no-token">
      <h1>agentcats</h1>
      <p>
        Open the board from the link printed by <code>agentcats</code> in your terminal. It contains
        the access token.
      </p>
    </main>,
  );
}
