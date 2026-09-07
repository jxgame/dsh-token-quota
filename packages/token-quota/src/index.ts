/**
 * Daily per-model token quota enforcement and accounting for the harness.
 *
 * The service owns three responsibilities, all driven by the existing agent
 * and session extension points — no loop modification:
 *
 * 1. **Accounting** — folds each live session's `request/header` to learn the
 *    `provider/model` in use, and credits the combined input + output + cache
 *    token count of every `assistant/message` that reports provider usage into
 *    that model's current-UTC-day bucket. Counters persist to a JSON file
 *    under the Harness home and roll over automatically at UTC midnight.
 *
 * 2. **Enforcement** — on the `agent/request` waterfall it awaits the resolved
 *    call config, and when the selected model's daily usage is at or above its
 *    configured cap (a positive limit), it throws an {@link LlmError} with
 *    `TOKEN_QUOTA_EXCEEDED`, ending the turn before any provider request is
 *    dispatched. A limit of `0` (or no entry) leaves the model unlimited.
 *
 * 3. **Limits + pull** — per-model limits live in the settings document
 *    (`token-quota` namespace, written by the Web panel through the settings
 *    scope); every change re-reads them. The current snapshot is served to
 *    consumers over a plugin-owned HTTP route (`GET /token-quota`, registered
 *    on the existing `webServer` service when one exists); the browser panel
 *    polls it, so no core-Harness wiring or generated RPC contract is needed.
 *
 * The browser half (`src/client/`) renders a floating panel from the polled
 * snapshot and writes limits back through the settings scope; this module
 * stays browser-free (the optional route is plain node:http).
 *
 * @module @jxgame2020/dsh-token-quota
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only side-effect: pulls agent/request and agent/pre-step Events augmentations
// the service listens to without importing any runtime value.
import '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmModelInfo, LlmProviderInfo, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  TOKEN_QUOTA_EXCEEDED_CODE,
  TOKEN_QUOTA_NAMESPACE,
  tokenQuotaKey,
  type TokenQuotaConfig,
  type TokenQuotaEntry,
  type TokenQuotaLog,
  type TokenQuotaLogEntry,
  type TokenQuotaReset,
  type TokenQuotaSettings,
  type TokenQuotaSnapshot,
  type TokenQuotaUpgrade,
} from './types.ts'
import { assertTokenQuotaLimit, splitTokenQuotaKey } from './invariant.ts'

/** Inlined at build time (tsdown `define`) from package.json; undefined in the type-check-only host build. */
declare const __TOKEN_QUOTA_VERSION__: string | undefined

/** The plugin's package name, used to locate the profile dependency and the registry endpoint. */
const PACKAGE_NAME = '@jxgame2020/dsh-token-quota'

/** npm registry endpoint for the plugin's latest version. */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@jxgame2020%2Fdsh-token-quota/latest'

/** How often the Host re-checks for a newer version when update checks are enabled. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Map a detected package manager to its install verb. */
function installVerb(manager: string): string {
  switch (manager) {
    case 'pnpm': return 'pnpm add'
    case 'yarn': return 'yarn add'
    case 'bun': return 'bun add'
    default: return 'npm install'
  }
}

/**
 * Build the registry upgrade command(s) for the running OS. macOS/Linux get one
 * bash line; Windows gets a cmd line and a PowerShell line (the Host cannot tell
 * which shell the user opens, so both are offered).
 */
function registryUpgradeCommands(profileDir: string, manager: string): string[] {
  const verb = installVerb(manager)
  const target = `${PACKAGE_NAME}@latest`
  if (process.platform === 'win32') {
    return [
      `cd /d "${profileDir}" && ${verb} ${target}`,
      `cd "${profileDir}"; ${verb} ${target}`,
    ]
  }
  return [`cd "${profileDir}" && ${verb} ${target}`]
}

/** Build the upgrade command for a local `link:`/`file:` install (git pull + rebuild). */
function linkUpgradeCommands(linkPath: string): string[] {
  return [`git -C "${linkPath}" pull`]
}

/** Detect the profile's package manager from its lockfiles; defaults to npm. */
function detectManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

/**
 * Locate the profile directory that declares this plugin as a dependency, along
 * with how it is installed and which package manager manages it. Returns
 * `undefined` when no profile declares the plugin (e.g. a bundle-managed mount).
 */
function findProfile(): { dir: string; installKind: 'registry' | 'link'; linkPath?: string; manager: string } | undefined {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const profilesDir = join(home, 'profiles')
  let names: string[]
  try {
    names = readdirSync(profilesDir)
  } catch {
    return undefined
  }
  for (const name of names) {
    const dir = join(profilesDir, name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest: { dependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    } catch {
      continue
    }
    const dep = manifest.dependencies?.[PACKAGE_NAME]
    if (dep === undefined) continue
    const manager = detectManager(dir)
    if (dep.startsWith('link:') || dep.startsWith('file:')) {
      return { dir, installKind: 'link', linkPath: dep.replace(/^(link|file):/, ''), manager }
    }
    return { dir, installKind: 'registry', manager }
  }
  return undefined
}

/** True when `latest` is a strictly higher dotted numeric version than `current`. */
function isNewer(latest: string, current: string): boolean {
  const parse = (version: string): number[] => version
    .replace(/^v/, '')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0)
  const left = parse(latest)
  const right = parse(current)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l > r) return true
    if (l < r) return false
  }
  return false
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The token-quota service (`@jxgame2020/dsh-token-quota`). */
    tokenQuota: TokenQuotaService
  }
}

/** Settings schema resolving the per-model daily caps document. */
const TOKEN_QUOTA_SETTINGS_SCHEMA = z.object({
  limits: z.dict(z.number().step(1).min(0)).default({}),
  monitored: z.array(z.string()).default([]),
  // `switchPriority` is a legacy value accepted for documents saved by older
  // plugin versions; the runtime normalizes it to `switchAll` (see
  // settingsSource below) so existing users keep auto-switching behavior
  // without reconfiguring.
  onFull: z.union(['stop', 'switchQuota', 'switchAll', 'switchPriority']).default('stop'),
  checkUpdates: z.boolean().default(true),
  // `reset` is a user-facing preference outside the validated surface: the
  // panel writes it and the host validates the shape at runtime. `z.any` with
  // a null default keeps it out of the strict fields above.
  reset: z.any().default(null),
})

/** Serialized counter file shape. */
interface PersistedQuota {
  /** Reset-cycle key the counters belong to. */
  cycle: string
  /** Per-model combined token usage for the current cycle. */
  usage: Record<string, number>
  /** Archived per-cycle usage history: cycle key -> model key -> tokens. */
  history: Record<string, Record<string, number>>
}

/** Two-digit zero-pad helper. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** The machine's own UTC offset in whole hours (default reset timezone). */
function localOffsetHours(now: Date = new Date()): number {
  return -now.getTimezoneOffset() / 60
}

/**
 * Resolve the reset-cycle key a timestamp belongs to: the `YYYY-MM-DD@HH:MM`
 * label (in the configured timezone) of the cycle whose `hour:minute` reset
 * moment contains the timestamp. With the default config (machine timezone,
 * 00:00) this reproduces the historical "resets at machine midnight".
 */
function cycleKey(now: Date, reset: TokenQuotaReset): string {
  const offsetMs = reset.offsetHours * 3_600_000
  const zoned = new Date(now.getTime() + offsetMs)
  const zonedDayStartUtc = Date.UTC(
    zoned.getUTCFullYear(), zoned.getUTCMonth(), zoned.getUTCDate(),
  ) - offsetMs
  const resetMinutes = reset.hour * 60 + reset.minute
  const cycleStartToday = zonedDayStartUtc + resetMinutes * 60_000
  const cycleStartUtc = now.getTime() >= cycleStartToday
    ? cycleStartToday
    : cycleStartToday - 86_400_000
  const startZoned = new Date(cycleStartUtc + offsetMs)
  return `${startZoned.getUTCFullYear()}-${pad2(startZoned.getUTCMonth() + 1)}-${pad2(startZoned.getUTCDate())}@${pad2(reset.hour)}:${pad2(reset.minute)}`
}

/** Default counter file under the Harness home (overridable through config). */
function defaultStoragePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'token-quota.json')
}

/** Combined input + output + cache token count of one provider usage report. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/**
 * Daily token-quota service.
 *
 * Mount it beside the other rows (`@jxgame2020/dsh-token-quota`) and write
 * per-model limits through the `token-quota` settings namespace.
 */
export class TokenQuotaService extends Service {
  static Config: z<TokenQuotaConfig> = z.object({
    storagePath: z.string().default(''),
  })

  private readonly storagePath: string
  private reset: TokenQuotaReset = {
    offsetHours: localOffsetHours(),
    hour: 0,
    minute: 0,
  }
  private cycle = cycleKey(new Date(), this.reset)
  private usage: Record<string, number> = {}
  private history: Record<string, Record<string, number>> = {}
  private limits: Record<string, number> = {}
  private monitored: Set<string> | undefined = undefined
  private settingsSource: () => TokenQuotaSettings = () => ({ limits: {}, monitored: [], onFull: 'stop', checkUpdates: true })
  /** Whether update checks are enabled (mirrors the settings document). */
  private checkUpdates = true
  /** Cached upgrade availability; recomputed by {@link refreshUpgrade}. */
  private upgrade: TokenQuotaUpgrade | null = null
  /** Timer for the periodic update check. */
  private updateTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight update check, to coalesce the periodic and manual triggers. */
  private upgradeCheck: Promise<void> | undefined
  /** Per-session folded model key from the latest `request/header`. */
  private readonly headerKeys = new WeakMap<Session, string | undefined>()
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  /** Cached model directory: list of providers and their models, refreshed lazily. */
  private cachedModels: Array<{ provider: string; model: string }> = []
  private modelsCachedAt = 0
  /** How long to reuse the cached model directory before refreshing (30s). */
  private static readonly MODEL_CACHE_TTL_MS = 30_000
  /** Disposer for the optional HTTP snapshot route (`GET /token-quota`). */
  private disposeRoute: (() => void) | undefined
  /** Disposer for the optional usage-history route (`GET /token-quota/log`). */
  private disposeRouteLog: (() => void) | undefined
  /** Disposer for the optional manual-check route (`POST /token-quota/check-updates`). */
  private disposeRouteCheck: (() => void) | undefined
  /** Disposer for the webServer-arrival watcher when the service mounts later. */
  private disposeRouteWatcher: (() => void) | undefined

  /**
   * @param ctx - owning context (events and the settings section register on it).
   * @param config - optional counter path.
   */
  constructor(ctx: Context, config: TokenQuotaConfig = {}) {
    super(ctx, 'tokenQuota')
    this.storagePath = config.storagePath !== undefined && config.storagePath.length > 0
      ? config.storagePath
      : defaultStoragePath()
    this.load()

    // Limits live in the user settings document; the Web panel writes them and
    // the section watcher pushes every change back here.
    installSettingsSection(ctx, settingsNamespace(TOKEN_QUOTA_NAMESPACE), TOKEN_QUOTA_SETTINGS_SCHEMA, { limits: {} }, {
      setSource: (current) => {
        // Normalize the resolved (schema-shaped) document into the plugin's
        // required shape: empty monitored = monitor everything, absent onFull
        // falls back to 'stop'.
        this.settingsSource = () => {
          const doc = current()
          return {
            limits: doc.limits ?? {},
            monitored: doc.monitored ?? [],
            // Legacy `switchPriority` (removed in 0.1.7) maps to `switchAll`:
            // capped models first, then uncapped — both monitored-only.
            onFull: doc.onFull === 'switchPriority' ? 'switchAll' : (doc.onFull ?? 'stop'),
            checkUpdates: doc.checkUpdates ?? true,
            reset: doc.reset ?? undefined,
          }
        }
      },
      validate: (value) => {
        for (const [key, limit] of Object.entries(value.limits ?? {})) {
          assertTokenQuotaLimit(limit, key)
          splitTokenQuotaKey(key)
        }
      },
      onChange: () => {
        const doc = this.settingsSource()
        this.limits = { ...doc.limits }
        this.monitored = doc.monitored !== undefined && doc.monitored.length > 0
          ? new Set(doc.monitored)
          : undefined
        this.checkUpdates = doc.checkUpdates
        this.syncUpdateChecking()
        if (doc.reset !== undefined
          && typeof doc.reset === 'object'
          && doc.reset !== null
          && typeof (doc.reset as TokenQuotaReset).offsetHours === 'number'
          && typeof (doc.reset as TokenQuotaReset).hour === 'number'
          && typeof (doc.reset as TokenQuotaReset).minute === 'number') {
          const configured = doc.reset as TokenQuotaReset
          this.reset = {
            offsetHours: Math.max(-12, Math.min(14, Math.round(configured.offsetHours))),
            hour: Math.max(0, Math.min(23, Math.round(configured.hour))),
            minute: Math.max(0, Math.min(59, Math.round(configured.minute))),
          }
          this.rollCycleIfNeeded()
        } else {
          // null / malformed (unset) = machine-local midnight — the default.
          this.reset = { offsetHours: localOffsetHours(), hour: 0, minute: 0 }
          this.rollCycleIfNeeded()
        }
      },
    })

    // Snapshot route: optional — only mounted when a webServer service exists
    // (the Web profile); headless deployments keep the enforcement without it.
    this.tryMountRoute()
    if (this.disposeRoute === undefined) {
      this.disposeRouteWatcher = ctx.on('internal/service', (name) => {
        if (name === 'webServer') this.tryMountRoute()
      })
    }

    // Accounting: learn the model from each request header, credit usage on
    // every provider-reported assistant message for that model.
    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })

    // For every newly created agent, install an agent-scoped enforcement
    // listener at the OUTERMOST position of the `agent/request` waterfall
    // (`prepend: true`). The waterfall runs outermost-first, so this listener
    // awaits the api-proxy model-selection listener (registered during agent
    // setup, innermost) and therefore sees the user's ACTUAL selected model —
    // not the agent's creation-time default. A manual switch in the panel or
    // the composer's model picker then correctly bypasses an exhausted model,
    // and when the configured strategy allows it, an automatic switch here
    // returns a rewritten config with no outer listener left to override it.
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.on(
        'agent/request',
        async (payload, next) => this.onRequest(payload, next),
        { prepend: true },
      )
    })

    // Update checks: start the periodic registry poll now (idempotent — the
    // settings onChange above may already have started it once the document
    // resolved; this guarantees a check even when the document arrives later).
    this.syncUpdateChecking()

    ctx.effect(() => () => { this.disposeLocal() }, 'token-quota: flush on unload')
  }

  /** Serve the current snapshot over the plugin-owned HTTP route. */
  private tryMountRoute(): void {
    const server = this.ctx.get('webServer') as { register: (route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void
    }) => () => void } | undefined
    if (server === undefined || this.disposeRoute !== undefined) return
    this.disposeRoute = server.register({
      kind: 'exact',
      path: '/token-quota',
      handler: (_req, res) => {
        const body = JSON.stringify(this.readSnapshot())
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
      },
    })
    this.disposeRouteLog = server.register({
      kind: 'exact',
      path: '/token-quota/log',
      handler: (_req, res) => {
        const body = JSON.stringify(this.readLog())
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
      },
    })
    this.disposeRouteCheck = server.register({
      kind: 'exact',
      path: '/token-quota/check-updates',
      handler: (_req, res) => {
        void this.refreshUpgrade().finally(() => {
          const body = JSON.stringify(this.readSnapshot())
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(body)
        })
      },
    })
  }

  /** Query the npm registry and rebuild the cached upgrade info (coalesced). */
  private refreshUpgrade(): Promise<void> {
    if (!this.checkUpdates) {
      this.upgrade = null
      return Promise.resolve()
    }
    if (this.upgradeCheck !== undefined) return this.upgradeCheck
    this.upgradeCheck = this.doRefreshUpgrade().finally(() => {
      this.upgradeCheck = undefined
    })
    return this.upgradeCheck
  }

  private async doRefreshUpgrade(): Promise<void> {
    const current = __TOKEN_QUOTA_VERSION__
    if (current === undefined || current === '') {
      this.upgrade = null
      return
    }
    let latest: string | undefined
    try {
      const response = await fetch(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        this.upgrade = null
        return
      }
      const manifest = await response.json() as { version?: string }
      latest = typeof manifest.version === 'string' ? manifest.version : undefined
    } catch {
      // Offline / registry failure: keep showing nothing rather than erroring.
      this.upgrade = null
      return
    }
    if (latest === undefined || !isNewer(latest, current)) {
      this.upgrade = null
      return
    }
    const profile = findProfile()
    const commands = profile === undefined
      ? []
      : profile.installKind === 'link'
        ? linkUpgradeCommands(profile.linkPath ?? profile.dir)
        : registryUpgradeCommands(profile.dir, profile.manager)
    this.upgrade = {
      latestVersion: latest,
      commands,
      installKind: profile?.installKind ?? 'registry',
    }
  }

  /** Start or stop the periodic update check to match the current setting. */
  private syncUpdateChecking(): void {
    if (this.updateTimer !== undefined) {
      clearTimeout(this.updateTimer)
      this.updateTimer = undefined
    }
    if (!this.checkUpdates) {
      this.upgrade = null
      return
    }
    // Immediate first check on startup, then a periodic re-check.
    void this.refreshUpgrade()
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined
      void this.refreshUpgrade()
      this.syncUpdateChecking()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  /** Read the full per-cycle usage history (log dialog data). */
  readLog(): TokenQuotaLog {
    this.rollCycleIfNeeded()
    const entries: TokenQuotaLogEntry[] = []
    for (const [cycle, usageByKey] of Object.entries(this.history)) {
      for (const [key, used] of Object.entries(usageByKey)) {
        const parts = this.safeSplit(key)
        if (parts === undefined || used <= 0) continue
        entries.push({ day: cycle, key, provider: parts.provider, model: parts.model, used })
      }
    }
    // Include the current cycle's live counters too.
    for (const [key, used] of Object.entries(this.usage)) {
      const parts = this.safeSplit(key)
      if (parts === undefined || used <= 0) continue
      entries.push({ day: this.cycle, key, provider: parts.provider, model: parts.model, used })
    }
    entries.sort((left, right) => right.day.localeCompare(left.day) || left.key.localeCompare(right.key))
    return { entries }
  }

  /** Read the current snapshot (also used by tests and inspection). */
  readSnapshot(): TokenQuotaSnapshot {
    this.rollCycleIfNeeded()
    const keys = new Set([...Object.keys(this.usage), ...Object.keys(this.limits)])
    const entries: TokenQuotaEntry[] = []
    for (const key of keys) {
      const parts = this.safeSplit(key)
      if (parts === undefined) continue
      entries.push({
        key,
        provider: parts.provider,
        model: parts.model,
        used: this.usage[key] ?? 0,
        limit: this.limitOf(key),
      })
    }
    entries.sort((left, right) => left.key.localeCompare(right.key))
    return { day: this.cycle, entries, upgrade: this.upgrade }
  }

  /** Today's used tokens for one model key, or `0`. */
  usedToday(key: string): number {
    this.rollCycleIfNeeded()
    return this.usage[key] ?? 0
  }

  /** Whether a model is under active monitoring (undefined = every model). */
  isMonitored(key: string): boolean {
    return this.monitored === undefined || this.monitored.has(key)
  }

  /** Resolve one model's daily cap: positive = capped, `0` = unlimited. */
  limitOf(key: string): number {
    const limit = this.limits[key]
    return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : 0
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      this.headerKeys.set(session, tokenQuotaKey(provider, model))
      return
    }
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      const key = this.headerKeys.get(session)
      if (key === undefined) return
      if (!this.isMonitored(key)) return
      const tokens = usageTokens(event.data.usage)
      if (tokens <= 0) return
      this.rollCycleIfNeeded()
      this.usage[key] = (this.usage[key] ?? 0) + tokens
      this.scheduleWrite()
    }
  }

  /**
   * Refresh the cached list of all registered providers and their advertised
   * models. Re-uses a still-fresh cache; any provider discovery failure is
   * swallowed — we'd rather miss a candidate than crash the request waterfall.
   */
  private async refreshModels(): Promise<void> {
    const now = Date.now()
    if (this.cachedModels.length > 0 && now - this.modelsCachedAt < TokenQuotaService.MODEL_CACHE_TTL_MS) {
      return
    }
    const llm = this.ctx.get('llm') as {
      listProviders: () => LlmProviderInfo[]
      listModels: (provider: string) => Promise<readonly LlmModelInfo[]>
    } | undefined
    if (llm === undefined) {
      this.cachedModels = []
      this.modelsCachedAt = now
      return
    }
    const next: Array<{ provider: string; model: string }> = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          next.push({ provider: provider.id, model: model.id })
        }
      } catch (error: unknown) {
        // Transient provider failure — keep whatever we already have for that
        // provider and continue with the others.
        this.ctx.logger.debug?.('token-quota: failed to list models for provider "%s": %o', provider.id, error)
      }
    }
    this.cachedModels = next
    this.modelsCachedAt = now
  }

  /**
   * Choose a replacement model for the exhausted current model according to
   * the configured `onFull` strategy. Returns `undefined` when no eligible
   * candidate exists (caller falls back to the historical stop-and-throw).
   */
  private pickReplacementModel(currentKey: string): { provider: string; model: string; key: string } | undefined {
    const doc = this.settingsSource()
    const onFull = doc.onFull ?? 'stop'
    if (onFull === 'stop') return undefined
    if (this.cachedModels.length === 0) return undefined

    const availability = (key: string): { limit: number; used: number } => {
      const limit = this.limitOf(key)
      const used = this.usage[key] ?? 0
      return { limit, used }
    }
    const isMonitored = (key: string): boolean => this.isMonitored(key)

    // Build candidate list excluding the currently exhausted model.
    const candidates = this.cachedModels
      .filter(({ provider, model }) => tokenQuotaKey(provider, model) !== currentKey)
      .map(({ provider, model }) => {
        const key = tokenQuotaKey(provider, model)
        const { limit, used } = availability(key)
        return { provider, model, key, limit, used, monitored: isMonitored(key) }
      })

    switch (onFull) {
      case 'switchQuota': {
        // Another monitored, capped model that still has headroom, sorted by
        // lowest fill ratio so we spread load across capped models evenly.
        const eligible = candidates
          .filter(c => c.monitored && c.limit > 0 && c.used < c.limit)
          .sort((a, b) => (a.used / a.limit) - (b.used / b.limit))
        return eligible[0]
      }
      case 'switchAll': {
        // Monitored models only. Capped models with headroom first (lowest
        // fill ratio wins, spreading load), then uncapped monitored models as
        // fallback — quotas are preferred, uncapped only when every capped
        // monitored model is exhausted.
        const cappedFree = candidates
          .filter(c => c.monitored && c.limit > 0 && c.used < c.limit)
          .sort((a, b) => (a.used / a.limit) - (b.used / b.limit))
        if (cappedFree.length > 0) return cappedFree[0]
        return candidates.find(c => c.monitored && c.limit <= 0)
      }
      default:
        return undefined
    }
  }

  private async onRequest(
    payload: { agent: { session: Session } },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> {
    const config = await next()
    const { provider, model } = config
    if (!provider || !model) return config
    const key = tokenQuotaKey(provider, model)
    // Bind the request's model to its session now (not on the later
    // request/header append): an in-flight reply that lands after a model
    // switch still credits the model that actually produced it.
    this.headerKeys.set(payload.agent.session, key)
    if (!this.isMonitored(key)) return config
    const limit = this.limitOf(key)
    if (limit <= 0) return config
    const used = this.usage[key] ?? 0
    if (used < limit) return config

    // Current model is at or over cap. Try an automatic switch when the
    // configured strategy allows it and a candidate exists; otherwise fall
    // through to the historical hard stop.
    await this.refreshModels()
    const replacement = this.pickReplacementModel(key)
    if (replacement !== undefined) {
      this.ctx.logger.info(
        'token-quota: "%s" is full (%d/%d); auto-switching to "%s" (%s strategy).',
        key, used, limit, replacement.key, this.settingsSource().onFull,
      )
      this.headerKeys.set(payload.agent.session, replacement.key)
      // Invalidate the cached directory so the next request re-discovers any
      // newly-registered models and so the next client-side poll sees the
      // switch reflected without waiting a full TTL.
      this.modelsCachedAt = 0
      this.cachedModels = []
      return {
        ...config,
        provider: replacement.provider,
        model: replacement.model,
      }
    }

    throw new LlmError(
      `Daily token limit reached for "${provider}/${model}": ${used}/${limit} tokens used today. `
      + 'Switch model in the quota panel or raise its limit.',
      TOKEN_QUOTA_EXCEEDED_CODE,
    )
  }

  /**
   * Roll over to a new reset cycle, archiving the finished cycle's counters
   * into the history log, when the cycle key changed.
   * @returns whether a rollover happened.
   */
  private rollCycleIfNeeded(): boolean {
    const now = cycleKey(new Date(), this.reset)
    if (this.cycle === now) return false
    if (Object.keys(this.usage).length > 0) {
      this.history[this.cycle] = { ...this.usage }
    }
    this.cycle = now
    this.usage = {}
    this.scheduleWrite()
    return true
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== undefined) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      this.flush()
    }, 500)
  }

  private flush(): void {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
    }
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      writeFileSync(this.storagePath, JSON.stringify({
        cycle: this.cycle,
        usage: this.usage,
        history: this.history,
      }, null, 2))
    } catch (error: unknown) {
      this.ctx.logger.warn('token-quota: failed to persist counters: %o', error)
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown
      const candidate = parsed as (Partial<PersistedQuota> & { day?: string }) | null
      this.cycle = typeof candidate?.cycle === 'string' && candidate.cycle.length > 0
        ? candidate.cycle
        // Legacy files stored a bare `day` (machine-local date); adopt it as
        // the current cycle so no usage is dropped on upgrade.
        : typeof candidate?.day === 'string' && candidate.day.length > 0
          ? candidate.day
          : cycleKey(new Date(), this.reset)
      const usage: unknown = candidate?.usage
      this.usage = typeof usage === 'object' && usage !== null && !Array.isArray(usage)
        ? usage as Record<string, number>
        : {}
      const history: unknown = candidate?.history
      this.history = typeof history === 'object' && history !== null && !Array.isArray(history)
        ? history as Record<string, Record<string, number>>
        : {}
      this.rollCycleIfNeeded()
    } catch {
      // Missing or corrupt counter file starts fresh; it must never crash the harness.
    }
  }

  private disposeLocal(): void {
    if (this.updateTimer !== undefined) {
      clearTimeout(this.updateTimer)
      this.updateTimer = undefined
    }
    if (this.disposeRouteWatcher !== undefined) this.disposeRouteWatcher()
    if (this.disposeRoute !== undefined) this.disposeRoute()
    if (this.disposeRouteLog !== undefined) this.disposeRouteLog()
    if (this.disposeRouteCheck !== undefined) this.disposeRouteCheck()
    this.flush()
  }

  private safeSplit(key: string): { provider: string; model: string } | undefined {
    try {
      return splitTokenQuotaKey(key)
    } catch {
      return undefined
    }
  }
}

export default TokenQuotaService
