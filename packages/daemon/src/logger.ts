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
    console.log(`[agentcats] ${message}`);
  },
  warn: (message) => {
    console.warn(`[agentcats] ${message}`);
  },
  error: (message) => {
    console.error(`[agentcats] ${message}`);
  },
};
