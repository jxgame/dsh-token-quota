/**
 * Token-quota panel store: the shared, remount-surviving view state. The
 * apply-world is the only writer — forwarded `token-quota/updated` snapshots
 * and the model-directory loader feed it — while the panel reads through
 * `useStore`. Display rows are derived data (pure function over the two
 * sources), so the component builds them with `useMemo`, never a store scan.
 *
 * @module @deepseek-ai/dsh-client-ui-token-quota/client/store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: snapshot shape lives in the host quota package.
import type {
  TokenQuotaFullAction,
  TokenQuotaLog,
  TokenQuotaReset,
  TokenQuotaSnapshot,
  TokenQuotaEntry,
} from '@jxgame2020/dsh-token-quota/types'

/** Build the stable per-model key shared by the counter, settings, and snapshot. */
function tokenQuotaKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** One rendered model row: directory identity merged with the quota snapshot. */
export interface ModelQuotaRow {
  /** Stable key `provider/model`. */
  key: string
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Display name from the directory, falling back to the model id. */
  name: string
  /** Tokens used today (input + output + cache). */
  used: number
  /** Daily cap; `0` means unlimited. */
  limit: number
  /** Whether the current session uses this route. */
  current: boolean
}

/** Panel view state. */
export interface TokenQuotaPanelState {
  /** Latest quota snapshot from the Host; null before the first event lands. */
  snapshot: TokenQuotaSnapshot | null
  /** Advisory model directory of the current session (provider groups). */
  groups: readonly ModelProviderGroup[]
  /** Current model selection reported by the Host. */
  current: ModelSelection | null
  /** Directory load in flight. */
  loading: boolean
  /** Last load/selection failure text; null when none. */
  error: string | null
  /**
   * Model keys under active monitoring; `null` means every model (default).
   * Unmonitored models are hidden, not metered, and never capped.
   */
  monitored: string[] | null
  /** Behavior when a monitored, capped model reaches its daily cap. */
  onFull: TokenQuotaFullAction
  /** Whether the settings dialog is open. */
  dialogOpen: boolean
  /** Full-quota notice shown for the `'stop'` strategy; null when none. */
  fullNotice: string | null
  /** Daily reset moment; `null` = machine-local midnight. */
  reset: TokenQuotaReset | null
  /** Whether the usage-log dialog is open. */
  logOpen: boolean
  /** Latest usage history; null before the first fetch. */
  log: TokenQuotaLog | null
}

/** Declared write surface. */
export type TokenQuotaPanelActions = {
  setSnapshot: (d: TokenQuotaPanelState, snapshot: TokenQuotaSnapshot) => void
  setDirectory: (d: TokenQuotaPanelState, groups: readonly ModelProviderGroup[], current: ModelSelection | null) => void
  setLoading: (d: TokenQuotaPanelState, loading: boolean) => void
  setError: (d: TokenQuotaPanelState, error: string | null) => void
  setSettings: (d: TokenQuotaPanelState, monitored: string[] | null, onFull: TokenQuotaFullAction) => void
  setDialogOpen: (d: TokenQuotaPanelState, open: boolean) => void
  setFullNotice: (d: TokenQuotaPanelState, notice: string | null) => void
  setReset: (d: TokenQuotaPanelState, reset: TokenQuotaReset | null) => void
  setLogOpen: (d: TokenQuotaPanelState, open: boolean) => void
  setLog: (d: TokenQuotaPanelState, log: TokenQuotaLog | null) => void
}

/**
 * Declares the panel state and write surface.
 * @returns the store handle.
 */
export function createTokenQuotaPanelStore(): EngineStoreHandle<TokenQuotaPanelState, TokenQuotaPanelActions> {
  return defineStore({
    init: (): TokenQuotaPanelState => ({
      snapshot: null,
      groups: [],
      current: null,
      loading: false,
      error: null,
      monitored: null,
      onFull: 'stop',
      dialogOpen: false,
      fullNotice: null,
      reset: null,
      logOpen: false,
      log: null,
    }),
    actions: {
      setSnapshot: (d, snapshot) => { d.snapshot = snapshot },
      setDirectory: (d, groups, current) => { d.groups = groups; d.current = current },
      setLoading: (d, loading) => { d.loading = loading },
      setError: (d, error) => { d.error = error },
      setSettings: (d, monitored, onFull) => { d.monitored = monitored; d.onFull = onFull },
      setDialogOpen: (d, open) => { d.dialogOpen = open },
      setFullNotice: (d, notice) => { d.fullNotice = notice },
      setReset: (d, reset) => { d.reset = reset },
      setLogOpen: (d, open) => { d.logOpen = open },
      setLog: (d, log) => { d.log = log },
    },
  })
}

/**
 * Merge the session's model directory with the quota snapshot into display
 * rows. Every directory model gets a row (usage/limit fall back to
 * `0`/`0`), and snapshot entries for routes missing from the directory are
 * appended so no counter is ever hidden.
 * @param groups - advisory provider groups of the current session.
 * @param snapshot - latest quota snapshot, or null before the first one.
 * @param current - current model selection reported by the Host.
 * @returns rows sorted by key.
 */
export function mergeModelRows(
  groups: readonly ModelProviderGroup[],
  snapshot: TokenQuotaSnapshot | null,
  current: ModelSelection | null,
): ModelQuotaRow[] {
  const entryByKey = new Map<string, TokenQuotaEntry>((snapshot?.entries ?? []).map(entry => [entry.key, entry]))
  const rows = new Map<string, ModelQuotaRow>()
  for (const group of groups) {
    for (const model of group.models) {
      const key = tokenQuotaKey(group.id, model.id)
      const entry = entryByKey.get(key)
      rows.set(key, {
        key,
        provider: group.id,
        model: model.id,
        name: model.name,
        used: entry?.used ?? 0,
        limit: entry?.limit ?? 0,
        current: current !== null && current.provider === group.id && current.model === model.id,
      })
    }
  }
  for (const entry of snapshot?.entries ?? []) {
    if (rows.has(entry.key)) continue
    rows.set(entry.key, {
      key: entry.key,
      provider: entry.provider,
      model: entry.model,
      name: entry.model,
      used: entry.used,
      limit: entry.limit,
      current: current !== null && current.provider === entry.provider && current.model === entry.model,
    })
  }
  return [...rows.values()].sort((left, right) => left.key.localeCompare(right.key))
}
