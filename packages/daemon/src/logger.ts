import { redactSecrets } from '@agentcats/protocol';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const consoleLogger: Logger = {
  info: (message) => {
    console.log(`[agentcats] ${redactSecrets(message)}`);
  },
  warn: (message) => {
    console.warn(`[agentcats] ${redactSecrets(message)}`);
  },
  error: (message) => {
    console.error(`[agentcats] ${redactSecrets(message)}`);
  },
};
