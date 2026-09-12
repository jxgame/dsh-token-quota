/**
 * Token-quota panel store: the shared, remount-surviving view state. The
 * apply-world is the only writer — forwarded `token-quota/updated` snapshots
 * and the model-directory loader feed it — while the panel reads through
 * `useStore`. Display rows are derived data (pure function over the two
 * sources), so the component builds them with `useMemo`, never a store scan.
 *
 * @module @deepseek-ai/dsh-client-ui-token-quota/client/store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
// Type-only: snapshot shape lives in the host quota package.
import type {
  TokenQuotaFullAction,
  TokenQuotaLog,
  TokenQuotaReset,
  TokenQuotaSnapshot,
  TokenQuotaEntry,
  TokenQuotaUpgrade,
} from '@jxgame2020/dsh-token-quota/types'

/** Inlined at build time (tsdown `define`) from package.json. */
declare const __TOKEN_QUOTA_VERSION__: string | undefined

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
  /** Whether the Host is allowed to check npm for newer versions. */
  checkUpdates: boolean
  /** Whether the panel dims while the pointer is away / while typing. */
  dimWhenIdle: boolean
  /** Latest upgrade availability from the Host; null = up to date or unknown. */
  upgrade: TokenQuotaUpgrade | null
  /** Whether the one-shot upgrade banner was dismissed for the current latest version. */
  upgradeDismissed: boolean
  /** Whether a manual update check is in flight. */
  checkingUpdates: boolean
  /** Result of the most recent manual check; 'idle' = nothing to show. */
  lastCheckResult: 'idle' | 'up-to-date' | 'error'
  /** Error message from the most recent update check (shown when lastCheckResult='error'). */
  upgradeError: string | null
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
  /** Filter string for the log table (matches provider/model key). */
  logSearch: string
  /** Current page index (0-based) in the filtered log table. */
  logPage: number
  /** Rows per page in the log table. */
  logPageSize: number
  /** Whether the clear-log confirmation dialog is open. */
  logClearOpen: boolean
  /** The `YYYY-MM-DD` date before which log entries will be cleared. */
  logClearBefore: string
  /** Whether a clear-log request is in flight. */
  logClearing: boolean
}

/** Declared write surface. */
export type TokenQuotaPanelActions = {
  setSnapshot: (d: TokenQuotaPanelState, snapshot: TokenQuotaSnapshot) => void
  setDirectory: (d: TokenQuotaPanelState, groups: readonly ModelProviderGroup[], current: ModelSelection | null) => void
  setLoading: (d: TokenQuotaPanelState, loading: boolean) => void
  setError: (d: TokenQuotaPanelState, error: string | null) => void
  setSettings: (d: TokenQuotaPanelState, monitored: string[] | null, onFull: TokenQuotaFullAction) => void
  setCheckUpdates: (d: TokenQuotaPanelState, checkUpdates: boolean) => void
  setDimWhenIdle: (d: TokenQuotaPanelState, dimWhenIdle: boolean) => void
  setUpgrade: (d: TokenQuotaPanelState, upgrade: TokenQuotaUpgrade | null) => void
  setUpgradeDismissed: (d: TokenQuotaPanelState, dismissed: boolean) => void
  setCheckingUpdates: (d: TokenQuotaPanelState, checking: boolean) => void
  setLastCheckResult: (d: TokenQuotaPanelState, result: 'idle' | 'up-to-date' | 'error') => void
  setUpgradeError: (d: TokenQuotaPanelState, error: string | null) => void
  setDialogOpen: (d: TokenQuotaPanelState, open: boolean) => void
  setFullNotice: (d: TokenQuotaPanelState, notice: string | null) => void
  setReset: (d: TokenQuotaPanelState, reset: TokenQuotaReset | null) => void
  setLogOpen: (d: TokenQuotaPanelState, open: boolean) => void
  setLog: (d: TokenQuotaPanelState, log: TokenQuotaLog | null) => void
  setLogSearch: (d: TokenQuotaPanelState, search: string) => void
  setLogPage: (d: TokenQuotaPanelState, page: number) => void
  setLogPageSize: (d: TokenQuotaPanelState, size: number) => void
  setLogClearOpen: (d: TokenQuotaPanelState, open: boolean) => void
  setLogClearBefore: (d: TokenQuotaPanelState, before: string) => void
  setLogClearing: (d: TokenQuotaPanelState, clearing: boolean) => void
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
      checkUpdates: true,
      dimWhenIdle: false,
      upgrade: null,
      upgradeDismissed: false,
      checkingUpdates: false,
      lastCheckResult: 'idle',
      upgradeError: null,
      dialogOpen: false,
      fullNotice: null,
      reset: null,
      logOpen: false,
      log: null,
      logSearch: '',
      logPage: 0,
      logPageSize: 15,
      logClearOpen: false,
      logClearBefore: '',
      logClearing: false,
    }),
    actions: {
      setSnapshot: (d, snapshot) => { d.snapshot = snapshot },
      setDirectory: (d, groups, current) => { d.groups = groups; d.current = current },
      setLoading: (d, loading) => { d.loading = loading },
      setError: (d, error) => { d.error = error },
      setSettings: (d, monitored, onFull) => { d.monitored = monitored; d.onFull = onFull },
      setCheckUpdates: (d, checkUpdates) => { d.checkUpdates = checkUpdates },
      setDimWhenIdle: (d, dimWhenIdle) => { d.dimWhenIdle = dimWhenIdle },
      setUpgrade: (d, upgrade) => {
        // Guard against host/client version skew (e.g. the host process still
        // runs an older bundle after an upgrade): when the reported "latest"
        // equals the client's own version, there is nothing to upgrade to.
        // This prevents a confusing `v0.1.16 → v0.1.16` banner.
        const normalized = upgrade !== null
          && upgrade.latestVersion !== ''
          && upgrade.latestVersion !== __TOKEN_QUOTA_VERSION__
          ? upgrade
          : null
        // A new latest version re-arms the one-shot banner; the same version
        // stays dismissed until the user dismisses it again (or it changes).
        if (d.upgrade === null || d.upgrade.latestVersion !== normalized?.latestVersion) {
          d.upgradeDismissed = false
        }
        d.upgrade = normalized
      },
      setUpgradeDismissed: (d, dismissed) => { d.upgradeDismissed = dismissed },
      setCheckingUpdates: (d, checking) => { d.checkingUpdates = checking },
      setLastCheckResult: (d, result) => { d.lastCheckResult = result },
      setUpgradeError: (d, error) => { d.upgradeError = error },
      setDialogOpen: (d, open) => { d.dialogOpen = open },
      setFullNotice: (d, notice) => { d.fullNotice = notice },
      setReset: (d, reset) => { d.reset = reset },
      setLogOpen: (d, open) => { d.logOpen = open },
      setLog: (d, log) => { d.log = log },
      setLogSearch: (d, search) => { d.logSearch = search; d.logPage = 0 },
      setLogPage: (d, page) => { d.logPage = page },
      setLogPageSize: (d, size) => { d.logPageSize = size; d.logPage = 0 },
      setLogClearOpen: (d, open) => { d.logClearOpen = open },
      setLogClearBefore: (d, before) => { d.logClearBefore = before },
      setLogClearing: (d, clearing) => { d.logClearing = clearing },
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
