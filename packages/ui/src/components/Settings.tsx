import type {
  AdapterId,
  AdapterInfo,
  Cat,
  PermissionMode,
  Settings,
  SettingsResponse,
  SettingsScope,
} from '@agentcats/protocol';
import { type SyntheticEvent, useEffect, useState } from 'react';

import { Dialog } from './Hiring.js';

export interface SettingsDialogProps {
  readonly adapters: readonly AdapterInfo[];
  /** The lead and the workers on the board. */
  readonly cats: readonly Cat[];
  readonly load: () => Promise<SettingsResponse | null>;
  /** Resolves to the saved settings, or `null` if the daemon refused (its error is shown). */
  readonly save: (
    scope: SettingsScope,
    settings: Settings,
    moveCats: string[],
  ) => Promise<SettingsResponse | null>;
  readonly onClose: () => void;
}

const numberOrNull = (text: string) => {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : value;
};
const textOf = (value: number | null) => (value === null ? '' : String(value));

/** The agent a cat of this role gets under these settings. */
function roleAgent(settings: Settings, cat: Cat): string {
  return cat.role === 'orchestrator'
    ? (settings.orchestrator.adapter ?? settings.adapter)
    : (settings.workers.adapter ?? settings.adapter);
}

/**
 * Defaults for new cats: agents and models, team size, budgets, captions.
 * Saved for this project, or as the user's defaults for every project.
 */
export function SettingsDialog({ adapters, cats, load, save, onClose }: SettingsDialogProps) {
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load().then((response) => {
      if (!response) return;
      setLoaded(response);
      setForm(response.settings);
    });
  }, [load]);

  const name = (id: string) => adapters.find((a) => a.id === id)?.displayName ?? id;
  const change = (next: Settings) => {
    setForm(next);
    setSaved(null);
  };
  // Cats that would run on another agent than their role's default: offered to move.
  const movable = form
    ? cats.filter((c) => c.role !== 'candidate' && c.adapter !== roleAgent(form, c))
    : [];

  async function submit(scope: SettingsScope, e?: SyntheticEvent) {
    e?.preventDefault();
    if (!form) return;
    setSaving(true);
    const moveCats = movable.filter((c) => !keep.has(c.id)).map((c) => c.id);
    const response = await save(scope, form, moveCats);
    setSaving(false);
    if (!response) return;
    setLoaded(response);
    setForm(response.settings);
    setKeep(new Set());
    setSaved(
      scope === 'global' ? 'Saved as your defaults for every project.' : 'Saved for this project.',
    );
  }

  return (
    <Dialog title="Settings" onClose={onClose} wide>
      {!form || !loaded ? (
        <p className="drawer__muted">Loading…</p>
      ) : (
        <form className="form settings" onSubmit={(e) => void submit('project', e)}>
          <p className="drawer__text">
            Defaults for new cats. Each cat can still be changed in its own panel.
          </p>

          <h3 className="drawer__subtitle">Agents</h3>
          <div className="form__row form__row--three">
            <label className="form__field">
              <span>Default agent</span>
              <select
                value={form.adapter}
                onChange={(e) => {
                  change({ ...form, adapter: e.target.value as AdapterId });
                }}
              >
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="form__field">
              <span>Lead</span>
              <select
                value={form.orchestrator.adapter ?? ''}
                onChange={(e) => {
                  change({
                    ...form,
                    orchestrator: {
                      ...form.orchestrator,
                      adapter: e.target.value || null,
                    },
                  });
                }}
              >
                <option value="">Default ({name(form.adapter)})</option>
                {adapters
                  .filter((a) => a.capabilities.mcp)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="form__field">
              <span>Workers</span>
              <select
                value={form.workers.adapter ?? ''}
                onChange={(e) => {
                  change({
                    ...form,
                    workers: {
                      ...form.workers,
                      adapter: e.target.value || null,
                    },
                  });
                }}
              >
                <option value="">Default ({name(form.adapter)})</option>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form__row">
            <label className="form__field">
              <span>Lead model</span>
              <input
                value={form.orchestrator.model ?? ''}
                placeholder="agent default"
                onChange={(e) => {
                  change({
                    ...form,
                    orchestrator: { ...form.orchestrator, model: e.target.value.trim() || null },
                  });
                }}
              />
            </label>
            <label className="form__field">
              <span>Worker model</span>
              <input
                value={form.workers.model ?? ''}
                placeholder="agent default"
                onChange={(e) => {
                  change({
                    ...form,
                    workers: { ...form.workers, model: e.target.value.trim() || null },
                  });
                }}
              />
            </label>
          </div>
          {movable.length > 0 && (
            <fieldset className="warning-box" aria-label="Cats on another agent">
              <legend>These cats keep the agent they were created with</legend>
              {movable.map((c) => (
                <label key={c.id} className="radio">
                  <input
                    type="checkbox"
                    checked={!keep.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(keep);
                      if (e.target.checked) next.delete(c.id);
                      else next.add(c.id);
                      setKeep(next);
                    }}
                  />
                  Move {c.name}
                  {c.role === 'orchestrator' ? ' (lead)' : ''} from {name(c.adapter)} to{' '}
                  {name(roleAgent(form, c))}
                </label>
              ))}
              <p className="drawer__hint">A moved cat uses its new agent from its next session.</p>
            </fieldset>
          )}

          <h3 className="drawer__subtitle">Team</h3>
          <div className="form__row form__row--three">
            <label className="form__field">
              <span>Workers at once</span>
              <input
                type="number"
                min={1}
                max={16}
                value={form.workers.max}
                onChange={(e) => {
                  const max = Math.min(16, Math.max(1, Math.round(Number(e.target.value) || 1)));
                  change({ ...form, workers: { ...form.workers, max } });
                }}
              />
            </label>
            <label className="form__field">
              <span>Worker permission mode</span>
              <select
                value={form.workers.permissionMode}
                onChange={(e) => {
                  change({
                    ...form,
                    workers: { ...form.workers, permissionMode: e.target.value as PermissionMode },
                  });
                }}
              >
                <option value="ask">Ask before changes</option>
                <option value="accept_edits">Edit files freely, ask for the rest</option>
                <option value="auto">Auto (agent decides what is safe)</option>
              </select>
            </label>
            <label className="radio settings__check">
              <input
                type="checkbox"
                checked={form.workers.autoHire}
                onChange={(e) => {
                  change({ ...form, workers: { ...form.workers, autoHire: e.target.checked } });
                }}
              />
              Hire workers automatically
            </label>
          </div>

          <h3 className="drawer__subtitle">Budgets</h3>
          <div className="form__row form__row--three">
            <label className="form__field">
              <span>Per new cat ($)</span>
              <input
                inputMode="decimal"
                value={textOf(form.budget.perCatUsd)}
                placeholder="no limit"
                onChange={(e) => {
                  change({
                    ...form,
                    budget: { ...form.budget, perCatUsd: numberOrNull(e.target.value) },
                  });
                }}
              />
            </label>
            <label className="form__field">
              <span>Per new cat (min)</span>
              <input
                inputMode="decimal"
                value={textOf(form.budget.perCatMinutes)}
                placeholder="no limit"
                title="For agents that report no cost, like Codex"
                onChange={(e) => {
                  change({
                    ...form,
                    budget: { ...form.budget, perCatMinutes: numberOrNull(e.target.value) },
                  });
                }}
              />
            </label>
            <label className="form__field">
              <span>Whole team ($)</span>
              <input
                inputMode="decimal"
                value={textOf(form.budget.globalUsd)}
                placeholder="no limit"
                onChange={(e) => {
                  change({
                    ...form,
                    budget: { ...form.budget, globalUsd: numberOrNull(e.target.value) },
                  });
                }}
              />
            </label>
          </div>
          <label className="form__field">
            <span>Enforce budgets</span>
            <select
              value={form.budget.enforce}
              onChange={(e) => {
                change({
                  ...form,
                  budget: {
                    ...form.budget,
                    enforce: e.target.value as Settings['budget']['enforce'],
                  },
                });
              }}
            >
              <option value="metered">Only for pay-per-use agents</option>
              <option value="always">Always, also on subscription plans</option>
              <option value="never">Never, only show the totals</option>
            </select>
          </label>

          <label className="radio">
            <input
              type="checkbox"
              checked={form.captions.enabled}
              onChange={(e) => {
                change({ ...form, captions: { enabled: e.target.checked } });
              }}
            />
            Meme captions on failures, promotions and retirements
          </label>

          <p className="drawer__hint">
            This project: <code>{loaded.files.project}</code>
            <br />
            Your defaults, for every project: <code>{loaded.files.global}</code>
            <br />A project's own settings win over your defaults.
          </p>
          <div className="drawer__actions">
            <button type="submit" className="button button--primary" disabled={saving}>
              Save for this project
            </button>
            <button
              type="button"
              className="button"
              disabled={saving}
              onClick={() => void submit('global')}
            >
              Save as my default
            </button>
            {saved && (
              <span className="drawer__muted" role="status">
                {saved}
              </span>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
