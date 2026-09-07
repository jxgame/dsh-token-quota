/**
 * Shared wire/type vocabulary for the daily token-quota plugin.
 *
 * The Host half owns the durable per-model daily counter and the enforcement
 * gate; the browser half renders a floating panel from the snapshot it pulls
 * over a plugin-owned HTTP route, and writes per-model limits and panel
 * preferences through the settings document. This module is the one meeting
 * point of the two planes: it carries strings and shapes only, never a
 * runtime import from the other half.
 *
 * @module @jxgame2020/dsh-token-quota/types
 */

/** Settings namespace owning the per-model daily limits document. */
export const TOKEN_QUOTA_NAMESPACE = 'token-quota'

/** Stable machine code thrown from `agent/request` when a model is over its daily cap. */
export const TOKEN_QUOTA_EXCEEDED_CODE = 'TOKEN_QUOTA_EXCEEDED'

/**
 * What to do once a monitored, quota-capped model reaches its daily cap.
 * Selected in the panel's settings dialog; the panel acts on it (b/c auto
 * switch, a stops and prompts).
 */
export const TOKEN_QUOTA_FULL_ACTIONS = ['stop', 'switchQuota', 'switchAll'] as const

/** One of the {@link TOKEN_QUOTA_FULL_ACTIONS} values. */
export type TokenQuotaFullAction = typeof TOKEN_QUOTA_FULL_ACTIONS[number]

/**
 * Daily reset moment: every day at `hour:minute` in the chosen timezone
 * (a fixed UTC offset in hours, -12 through +14) the counters roll over.
 * Absent from settings (or host default) means the machine's own timezone at
 * midnight — the historical behaviour.
 */
export interface TokenQuotaReset {
  /** Fixed UTC offset in whole hours, -12 .. +14. */
  offsetHours: number
  /** Reset hour in that timezone, 0..23. */
  hour: number
  /** Reset minute in that timezone, 0..59. */
  minute: number
}

/** Default reset: machine-local midnight (offset = host timezone, 00:00). */
export const TOKEN_QUOTA_DEFAULT_RESET: TokenQuotaReset = { offsetHours: 0, hour: 0, minute: 0 }

/**
 * Per-model daily-limit settings document shape. Keys are `provider/model`
 * and a value of `0` (or an absent key) means unlimited for that model.
 */
export interface TokenQuotaSettings {
  /**
   * Daily token caps keyed by `provider/model`. `0` or absent = unlimited.
   * Positive integers cap the combined input + output + cache token count
   * for the current UTC day.
   */
  limits: Record<string, number>
  /**
   * Model keys (`provider/model`) under active monitoring. An empty array
   * means EVERY model is monitored (the install default). Unmonitored models
   * are hidden from the panel, not metered, and never capped.
   */
  monitored: string[]
  /**
   * Behavior when a monitored, capped model hits its daily cap:
   * `'stop'` stops and prompts, `'switchQuota'` auto-switches to another
   * monitored capped-but-available model, `'switchAll'` auto-switches to
   * another monitored available model — capped models first, uncapped ones
   * as fallback. Only monitored models ever participate in a switch.
   */
  onFull: TokenQuotaFullAction
  /**
   * Whether the Host periodically queries the npm registry for a newer version
   * and surfaces an update notice in the panel. `true` by default.
   */
  checkUpdates: boolean
  /**
   * Client-side appearance preference: dim the floating panel while the
   * pointer is away (and more while typing) so the content behind stays
   * readable. `false` by default — the panel stays fully opaque.
   */
  dimWhenIdle: boolean
  /**
   * Daily reset moment (timezone + clock time). Absent = machine-local
   * midnight (the historical behaviour).
   */
  reset?: TokenQuotaReset
}

/** Token-quota plugin configuration. */
export interface TokenQuotaConfig {
  /**
   * Counter JSON file path. Defaults to `token-quota.json` under the Harness
   * home (`DSH_HOME` or `~/.dsh`).
   */
  storagePath?: string
}

/** One model's live quota row, as rendered in the floating panel. */
export interface TokenQuotaEntry {
  /** Stable key `provider/model`; also the settings-document key. */
  key: string
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Tokens used today (input + output + cache). */
  used: number
  /** Daily cap; `0` means unlimited. */
  limit: number
}

/**
 * Upgrade availability, computed by the Host by querying the npm registry and
 * inspecting the running profile's install layout. Carried on the snapshot so
 * the panel can render an update notice and copy-ready upgrade commands.
 */
export interface TokenQuotaUpgrade {
  /** Latest published version; the Host only fills this in when it is newer than the running version. */
  latestVersion: string
  /**
   * Upgrade commands to run in the user's terminal, one entry per applicable
   * shell (macOS/Linux give one bash line; Windows gives cmd and PowerShell).
   */
  commands: string[]
  /**
   * How this plugin is installed: `registry` = a normal npm dependency (upgrade
   * via install), `link` = a local source path (upgrade via git pull + rebuild).
   */
  installKind: 'registry' | 'link'
}

/**
 * Full quota snapshot. The Host is the single fact source; the panel replaces
 * its whole view on each pull, so replay is order-independent.
 */
export interface TokenQuotaSnapshot {
  /** Reset-cycle key the counters belong to (`YYYY-MM-DD@HH:MM` in the reset timezone). */
  day: string
  /** Per-model rows, sorted by key. */
  entries: TokenQuotaEntry[]
  /** Upgrade availability; `null` when no newer version is known. */
  upgrade: TokenQuotaUpgrade | null
  /** Error from the most recent update check; `null` = no error (or never checked). */
  upgradeError: string | null
}

/** One historical daily usage record, shown in the log dialog. */
export interface TokenQuotaLogEntry {
  /** Reset-cycle key (`YYYY-MM-DD@HH:MM`) the record belongs to. */
  day: string
  /** Stable key `provider/model`. */
  key: string
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Tokens used that cycle (input + output + cache). */
  used: number
}

/**
 * Full usage history: one entry per model per reset cycle with a record.
 * Independent of the monitored set — every metered model appears.
 */
export interface TokenQuotaLog {
  /** Entries sorted by day desc then key. */
  entries: TokenQuotaLogEntry[]
}

/** Build the stable per-model key shared by the counter, settings, and snapshot. */
export function tokenQuotaKey(provider: string, model: string): string {
  return `${provider}/${model}`
}
