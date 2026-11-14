import { z } from 'zod';

import { PermissionMode } from './common.js';
import { AdapterId, AgentcatsConfig } from './config.js';

/**
 * The defaults a user changes from the board's Settings: which agent and
 * model the lead and workers use, how big the team may get, budgets for new
 * cats, and captions. Everything else stays in the config files.
 *
 * Settings are stored in two layers over the built-in defaults: the user's
 * own defaults (`~/.agentcats/agentcats.config.json`, every project) and the
 * project's (`.agentcats/agentcats.config.json`). The project wins.
 */
export const Settings = z.strictObject({
  adapter: AdapterId,
  orchestrator: z.strictObject({
    /** Any adapter id, like the config; `null` follows `adapter`. */
    adapter: z.string().min(1).max(64).nullable(),
    model: z.string().trim().min(1).max(100).nullable(),
  }),
  workers: z.strictObject({
    adapter: z.string().min(1).max(64).nullable(),
    model: z.string().trim().min(1).max(100).nullable(),
    max: z.int().min(1).max(16),
    autoHire: z.boolean(),
    permissionMode: PermissionMode,
  }),
  budget: z.strictObject({
    perCatUsd: z.number().positive().nullable(),
    perCatMinutes: z.number().positive().nullable(),
    globalUsd: z.number().positive().nullable(),
    enforce: z.enum(['metered', 'always', 'never']),
  }),
  captions: z.strictObject({ enabled: z.boolean() }),
});
export type Settings = z.infer<typeof Settings>;

/** Where settings are saved: this project only, or the user's defaults for every project. */
export const SettingsScope = z.enum(['project', 'global']);
export type SettingsScope = z.infer<typeof SettingsScope>;

/** The settings part of a full config. */
export function settingsOf(config: AgentcatsConfig): Settings {
  return {
    adapter: config.adapter,
    orchestrator: {
      adapter: config.orchestrator.adapter,
      model: config.orchestrator.model,
    },
    workers: {
      adapter: config.workers.adapter,
      model: config.workers.model,
      max: config.workers.max,
      autoHire: config.workers.autoHire,
      permissionMode: config.workers.permissionMode,
    },
    budget: {
      perCatUsd: config.budget.perCatUsd,
      perCatMinutes: config.budget.perCatMinutes,
      globalUsd: config.budget.globalUsd,
      enforce: config.budget.enforce,
    },
    captions: { enabled: config.captions.enabled },
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `over` laid over `base`, object by object; arrays and values replace. */
export function mergeConfigLayers(base: unknown, over: unknown): JsonObject {
  const out: JsonObject = isObject(base) ? { ...base } : {};
  if (!isObject(over)) return out;
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(out[key]) ? mergeConfigLayers(out[key], value) : value;
  }
  return out;
}

/**
 * A config file's new contents after saving `settings` into it: the
 * settings that differ from `inherited` (what the layers below give) are
 * written, the ones that equal it are removed, so the file only pins what
 * the user changed. Keys that are not settings are kept as they are.
 */
export function withSettings(file: unknown, settings: Settings, inherited: Settings): JsonObject {
  let out: JsonObject = isObject(file) ? file : {};
  const walk = (path: string[], next: unknown, below: unknown) => {
    if (isObject(next)) {
      for (const [key, value] of Object.entries(next)) {
        walk([...path, key], value, isObject(below) ? below[key] : undefined);
      }
      return;
    }
    out = put(out, path, next === below ? undefined : (next as Json));
  };
  walk([], settings, inherited);
  return out;
}

/**
 * `node` with the value at `path` set, or removed when `value` is
 * `undefined`; objects left empty on the way are removed too.
 */
function put(node: JsonObject, path: readonly string[], value: Json | undefined): JsonObject {
  const [key, ...rest] = path;
  if (key === undefined) return node;
  const others = Object.fromEntries(Object.entries(node).filter(([k]) => k !== key));
  const child = node[key];
  const next = rest.length === 0 ? value : put(isObject(child) ? child : {}, rest, value);
  const empty = next === undefined || (isObject(next) && Object.keys(next).length === 0);
  return empty ? others : { ...others, [key]: next };
}

/** The effective config from the two files' contents, over the built-in defaults. */
export function layeredConfig(global: unknown, project: unknown): AgentcatsConfig {
  return AgentcatsConfig.parse(mergeConfigLayers(global, project));
}

export const SettingsResponse = z.strictObject({
  /** What this project runs with now. */
  settings: Settings,
  /** What the project would get without its own file: built-in defaults and the user's. */
  inherited: Settings,
  /** The built-in defaults, under the user's own. */
  builtIn: Settings,
  files: z.strictObject({ project: z.string(), global: z.string() }),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const SaveSettingsRequest = z.strictObject({
  scope: SettingsScope,
  settings: Settings,
  /** Cats to move to the agent their role now defaults to, from their next session. */
  moveCats: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type SaveSettingsRequest = z.infer<typeof SaveSettingsRequest>;
