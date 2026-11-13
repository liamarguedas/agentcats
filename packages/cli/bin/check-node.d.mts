/** Oldest supported Node, `[major, minor]`. */
export declare const MINIMUM: readonly [number, number];
/** A message for the user if `version` (like `v20.11.0`) is too old, else `null`. */
export declare function nodeVersionProblem(version: string): string | null;
