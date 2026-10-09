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

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only side-effect: pulls agent/request and agent/pre-step Events augmentations
// the service listens to without importing any runtime value.
import '@deepseek-ai/dsh-agent'
// Type-only: pulls the ctx.settings Context merge (SettingsProvider).
import type {} from '@deepseek-ai/dsh-settings'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmModelInfo, LlmProviderInfo, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  TOKEN_QUOTA_EXCEEDED_CODE,
  TOKEN_QUOTA_NAMESPACE,
  tokenQuotaKey,
  type TokenQuotaConfig,
  type TokenQuotaBalance,
  type TokenQuotaEntry,
  type TokenQuotaLog,
  type TokenQuotaLogEntry,
  type TokenQuotaMusicAction,
  type TokenQuotaReset,
  type TokenQuotaSettings,
  type TokenQuotaSnapshot,
  type TokenQuotaUpgrade,
  TOKEN_QUOTA_DEFAULT_MUSIC,
  TOKEN_QUOTA_MAX_NOTES,
  TOKEN_QUOTA_DEFAULT_BALANCE,
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

/**
 * Detect the profile's package manager; defaults to npm.
 *
 * Lockfiles alone are unreliable: a profile can accumulate several of them over
 * time (e.g. a leftover `pnpm-lock.yaml` next to a fresh `package-lock.json`
 * after switching from pnpm to npm), and a bare existence check then reports
 * the WRONG manager. Instead, look at the installer fingerprints inside
 * `node_modules` — each manager leaves a marker when it actually installs —
 * and pick the most recently touched one. Only if no marker exists fall back
 * to comparing lockfile mtimes.
 */
function detectManager(dir: string): string {
  const stat = (path: string): number | undefined => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  }
  // Installer fingerprints inside node_modules, by manager.
  const fingerprints: Array<[string, string]> = [
    ['node_modules/.pnpm', 'pnpm'],
    ['node_modules/.bun', 'bun'],
    ['node_modules/.package-lock.json', 'npm'],
    ['node_modules/.yarn-integrity', 'yarn'],
  ]
  let best: { manager: string; mtime: number } | undefined
  for (const [rel, manager] of fingerprints) {
    const mtime = stat(join(dir, rel))
    if (mtime !== undefined && (best === undefined || mtime > best.mtime)) {
      best = { manager, mtime }
    }
  }
  if (best !== undefined) return best.manager
  // Fallback: the most recently modified lockfile.
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ]
  for (const [rel, manager] of lockfiles) {
    const mtime = stat(join(dir, rel))
    if (mtime !== undefined && (best === undefined || mtime > best.mtime)) {
      best = { manager, mtime }
    }
  }
  return best?.manager ?? 'npm'
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
    try {
      if (!statSync(manifestPath).isFile()) continue
    } catch {
      continue
    }
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
  // Client-side appearance preference; the host only stores it.
  dimWhenIdle: z.boolean().default(false),
  // Drag-to-reorder: display order of model keys, written by the panel.
  order: z.array(z.string()).default([]),
  // Floating scratchpad notes: the panel owns them, the host stores them.
  notes: z.array(z.object({
    id: z.string(),
    title: z.string().default(''),
    text: z.string().default(''),
    x: z.number().default(80),
    y: z.number().default(80),
    width: z.number().default(220),
    height: z.number().default(220),
    collapsed: z.boolean().default(false),
    visible: z.boolean().default(true),
  })).default([]),
  // `reset` is a user-facing preference outside the validated surface: the
  // panel writes it and the host validates the shape at runtime. `z.any` with
  // a null default keeps it out of the strict fields above.
  reset: z.any().default(null),
  // Live music: host persists the document, the browser half plays it.
  music: z.object({
    enabled: z.boolean().default(TOKEN_QUOTA_DEFAULT_MUSIC.enabled),
    volume: z.number().min(0).max(1).default(TOKEN_QUOTA_DEFAULT_MUSIC.volume),
    style: z.union(['major', 'minor', 'pentatonic']).default(TOKEN_QUOTA_DEFAULT_MUSIC.style),
    onlyCurrentSession: z.boolean().default(TOKEN_QUOTA_DEFAULT_MUSIC.onlyCurrentSession),
  }).default({ ...TOKEN_QUOTA_DEFAULT_MUSIC }),
  // Account balance: host polls the provider endpoint, panel displays it.
  balance: z.object({
    enabled: z.boolean().default(TOKEN_QUOTA_DEFAULT_BALANCE.enabled),
    pollMinutes: z.number().min(1).max(120).default(TOKEN_QUOTA_DEFAULT_BALANCE.pollMinutes),
  }).default({ ...TOKEN_QUOTA_DEFAULT_BALANCE }),
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
/**
 * One provider the host can query for account balance, discovered from the
 * model directory rather than hard-coded. `keyEnv` is the credential reference
 * (environment-variable name) that provider declared as its `apiKeyEnv`, and
 * `baseURL` is the provider's own endpoint base.
 */
interface BalanceSource {
  provider: string
  keyEnv: string
  baseURL: string
}

/** DeepSeek's public API host; used to recognise DeepSeek-family providers. */
const DEEPSEEK_BALANCE_HOST = 'api.deepseek.com'

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
  private settingsSource: () => TokenQuotaSettings = () => ({ limits: {}, monitored: [], onFull: 'stop', checkUpdates: true, dimWhenIdle: false, music: { ...TOKEN_QUOTA_DEFAULT_MUSIC }, order: [], notes: [], balance: { ...TOKEN_QUOTA_DEFAULT_BALANCE } })
  /** Whether update checks are enabled (mirrors the settings document). */
  private checkUpdates = true
  /** Cached upgrade availability; recomputed by {@link refreshUpgrade}. */
  private upgrade: TokenQuotaUpgrade | null = null
  /** Error message from the most recent update check; null = no error. */
  private upgradeError: string | null = null
  /** Timer for the periodic update check. */
  private updateTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the account balance is enabled (mirrors the settings document). */
  private balanceEnabled = TOKEN_QUOTA_DEFAULT_BALANCE.enabled
  /** Cached per-provider account balances, served in the snapshot. */
  private balances = new Map<string, TokenQuotaBalance>()
  /** Timer for the periodic balance poll. */
  private balanceTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight balance refreshes by provider, to coalesce overlapping triggers. */
  private balanceFetches = new Map<string, Promise<void>>()
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
  /** Disposer for the optional clear-log route (`POST /token-quota/clear-log`). */
  private disposeRouteClear: (() => void) | undefined
  /** Disposer for the optional balance-refresh route (`POST /token-quota/refresh-balance`). */
  private disposeRouteBalance: (() => void) | undefined
  /** Disposer for the optional music-event route (`GET /token-quota/events`, SSE). */
  private disposeRouteEvents: (() => void) | undefined
  /** Live SSE subscribers receiving streamed music actions. */
  private readonly musicClients = new Set<ServerResponse>()
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
    // the section watcher pushes every change back here. DSH 0.1.5 replaced
    // the standalone `installSettingsSection` helper with
    // `SettingsProvider.installSection`, reached through `ctx.inject` so the
    // settings service is guaranteed to be up before registration.
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, TOKEN_QUOTA_NAMESPACE, TOKEN_QUOTA_SETTINGS_SCHEMA, { limits: {} }, {
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
            dimWhenIdle: doc.dimWhenIdle ?? false,
            order: Array.isArray(doc.order) ? doc.order : [],
            balance: {
              enabled: doc.balance?.enabled ?? TOKEN_QUOTA_DEFAULT_BALANCE.enabled,
              pollMinutes: typeof doc.balance?.pollMinutes === 'number'
                ? Math.max(1, Math.min(120, Math.round(doc.balance.pollMinutes)))
                : TOKEN_QUOTA_DEFAULT_BALANCE.pollMinutes,
            },
            notes: Array.isArray(doc.notes)
              ? doc.notes.slice(0, TOKEN_QUOTA_MAX_NOTES).flatMap((note) => {
                if (typeof note.id !== 'string') return []
                return [{
                  id: note.id,
                  title: note.title ?? '',
                  text: note.text ?? '',
                  x: note.x ?? 80,
                  y: note.y ?? 80,
                  width: note.width ?? 220,
                  height: note.height ?? 220,
                  collapsed: note.collapsed ?? false,
                  visible: note.visible ?? true,
                }]
              })
              : [],
            reset: doc.reset ?? undefined,
            music: {
              enabled: doc.music?.enabled ?? TOKEN_QUOTA_DEFAULT_MUSIC.enabled,
              volume: doc.music?.volume ?? TOKEN_QUOTA_DEFAULT_MUSIC.volume,
              style: doc.music?.style ?? TOKEN_QUOTA_DEFAULT_MUSIC.style,
              onlyCurrentSession: doc.music?.onlyCurrentSession ?? TOKEN_QUOTA_DEFAULT_MUSIC.onlyCurrentSession,
            },
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
        const balanceEnabled = doc.balance?.enabled ?? TOKEN_QUOTA_DEFAULT_BALANCE.enabled
        const turnedOn = balanceEnabled && !this.balanceEnabled
        this.balanceEnabled = balanceEnabled
        if (!balanceEnabled) this.balances.clear()
        this.syncBalancePolling()
        // Flipping the toggle on: fetch right away so the panel shows numbers.
        if (turnedOn) void this.refreshAllBalances()
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
    // Account balance: schedule its poll and fetch once now (cheap; the panel
    // gets a number immediately even before the settings document resolves).
    this.syncBalancePolling()
    if (this.balanceEnabled) void this.refreshAllBalances()

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
    this.disposeRouteBalance = server.register({
      kind: 'exact',
      path: '/token-quota/refresh-balance',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405); res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
        req.on('end', () => {
          let provider: string | undefined
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (raw !== '') {
              const parsed: unknown = JSON.parse(raw)
              if (typeof parsed === 'object' && parsed !== null
                && typeof (parsed as { provider?: unknown }).provider === 'string') {
                provider = (parsed as { provider: string }).provider
              }
            }
          } catch {
            // Malformed body: fall back to refreshing everything.
          }
          const task = provider !== undefined
            ? this.refreshProviderBalance(provider)
            : this.refreshAllBalances()
          void task.finally(() => {
            const body = JSON.stringify(this.readSnapshot())
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(body)
          })
        })
      },
    })
    this.disposeRouteClear = server.register({
      kind: 'exact',
      path: '/token-quota/clear-log',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405); res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
        req.on('end', () => {
          let before = ''
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (raw.length > 0) {
              const payload = JSON.parse(raw) as { before?: string }
              before = typeof payload.before === 'string' ? payload.before : ''
            }
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'bad payload' }))
            return
          }
          const updated = this.clearLogBefore(before)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(updated))
        })
      },
    })
    this.disposeRouteEvents = server.register({
      kind: 'exact',
      path: '/token-quota/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        })
        this.musicClients.add(res)
        res.write(': token-quota music stream\n\n')
        // Heartbeat: the client uses this to detect a dead stream and stop
        // the soundtrack (a stuck drone is worse than no music). SSE comments
        // don't fire client listeners, so send a named event.
        const hb = setInterval(() => {
          try { res.write('event: hb\ndata: 1\n\n') } catch { clearInterval(hb) }
        }, 5000)
        req.on('close', () => {
          clearInterval(hb)
          this.musicClients.delete(res)
        })
      },
    })
  }

  /** Broadcast one action to every open SSE music subscriber. */
  private pushMusicAction(action: TokenQuotaMusicAction): void {
    if (this.musicClients.size === 0) return
    const data = `event: action\ndata: ${JSON.stringify(action)}\n\n`
    for (const res of this.musicClients) {
      try { res.write(data) } catch { this.musicClients.delete(res) }
    }
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
      this.upgradeError = null
      return
    }
    let latest: string | undefined
    try {
      // NOTE: do NOT send `accept: application/vnd.npm.install-v1+json` here —
      // that install-manifest media type gets 406 from some proxies/mirrors/CDNs.
      // Plain JSON works everywhere and still carries the `version` field.
      const response = await fetch(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        this.upgrade = null
        this.upgradeError = `registry responded ${response.status} ${response.statusText}`
        return
      }
      const manifest = await response.json() as { version?: string }
      latest = typeof manifest.version === 'string' ? manifest.version : undefined
    } catch (err) {
      this.upgrade = null
      const msg = err instanceof Error ? err.message : String(err)
      // Common Node fetch error shapes include the URL; surface a short reason.
      this.upgradeError = msg.includes('fetch failed')
        ? '无法访问 npm registry（网络超时或被墙）'
        : msg.includes('aborted')
          ? '请求超时（10s）'
          : msg
      return
    }
    if (latest === undefined || !isNewer(latest, current)) {
      this.upgrade = null
      this.upgradeError = null
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
    this.upgradeError = null
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

  /**
   * Start or stop the periodic balance poll to match the current setting. The
   * interval comes from the settings document; a poll chain re-arms itself
   * after each refresh. No fetch happens here — callers decide (startup and
   * the enabled-transition in `onChange` fetch immediately).
   */
  private syncBalancePolling(): void {
    if (this.balanceTimer !== undefined) {
      clearTimeout(this.balanceTimer)
      this.balanceTimer = undefined
    }
    if (!this.balanceEnabled) return
    const minutes = this.settingsSource().balance?.pollMinutes
      ?? TOKEN_QUOTA_DEFAULT_BALANCE.pollMinutes
    const schedule = (): void => {
      if (!this.balanceEnabled) return
      this.balanceTimer = setTimeout(() => {
        this.balanceTimer = undefined
        void this.refreshAllBalances().finally(schedule)
      }, Math.max(60_000, minutes * 60_000))
    }
    schedule()
  }

  /** Refresh every DeepSeek-family provider found in the model directory. */
  private refreshAllBalances(): Promise<void> {
    return Promise.all(
      [...this.discoverBalanceSources().values()]
        .map(source => this.refreshProviderBalance(source.provider, source)),
    ).then(() => undefined)
  }

  /**
   * Discover every provider in the model directory that looks like DeepSeek,
   * together with its own credential reference and endpoint base. This is what
   * decides which providers are queried: a provider qualifies when its base URL
   * points at DeepSeek's API host or its credential reference is named with the
   * `DEEPSEEK` prefix, and it must declare an `apiKeyEnv`.
   */
  private discoverBalanceSources(): Map<string, BalanceSource> {
    const found = new Map<string, BalanceSource>()
    const llm = this.ctx.get('llm') as {
      listConfigurableProviders?: () => Array<{
        provider: string
        settingsNs: string
        settingsPath?: readonly string[]
      }>
    } | undefined
    const settings = this.ctx.get('settings') as { get: (ns: string) => unknown } | undefined
    const fallback = (): BalanceSource => ({
      provider: 'deepseek',
      keyEnv: 'DEEPSEEK_API_KEY',
      baseURL: process.env.DEEPSEEK_BASE_URL ?? `https://${DEEPSEEK_BALANCE_HOST}`,
    })
    if (llm?.listConfigurableProviders === undefined) {
      found.set('deepseek', fallback())
      return found
    }
    for (const entry of llm.listConfigurableProviders()) {
      try {
        let profile: unknown = settings?.get(entry.settingsNs)
        for (const segment of entry.settingsPath ?? []) {
          profile = profile !== null && typeof profile === 'object'
            ? (profile as Record<string, unknown>)[segment]
            : undefined
        }
        if (profile === null || typeof profile !== 'object') continue
        const record = profile as Record<string, unknown>
        const keyEnv = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv !== ''
          ? record.apiKeyEnv
          : undefined
        const baseURL = typeof record.baseURL === 'string' && record.baseURL !== ''
          ? record.baseURL
          : undefined
        const isDeepSeek = (baseURL !== undefined && baseURL.includes(DEEPSEEK_BALANCE_HOST))
          || (keyEnv !== undefined && keyEnv.startsWith('DEEPSEEK'))
          || entry.provider.startsWith('deepseek')
        if (!isDeepSeek || keyEnv === undefined) continue
        found.set(entry.provider, {
          provider: entry.provider,
          keyEnv,
          baseURL: baseURL ?? `https://${DEEPSEEK_BALANCE_HOST}`,
        })
      } catch {
        // Malformed provider entry — skip it and keep the others.
      }
    }
    if (found.size === 0) found.set('deepseek', fallback())
    return found
  }

  /**
   * Refresh one provider's cached account balance. The API key is resolved
   * through the harness credential seam (`credentials.resolve`) with the
   * environment as a fallback, so the Models page key is used with nothing to
   * type. A failed fetch keeps the previous value and marks it as an error.
   */
  private async refreshProviderBalance(provider: string, source?: BalanceSource): Promise<void> {
    const resolved = source ?? this.discoverBalanceSources().get(provider)
    if (resolved === undefined) return
    const existing = this.balanceFetches.get(provider)
    if (existing !== undefined) return existing
    const run = async (): Promise<void> => {
      if (!this.balanceEnabled) return
      const credentials = this.ctx.get('credentials') as
        | { resolve(ref: string): Promise<{ value: string } | undefined> }
        | undefined
      let key: string | undefined
      if (credentials !== undefined) {
        try {
          key = (await credentials.resolve(resolved.keyEnv))?.value
        } catch {
          // Seam unreachable: fall through to the environment.
        }
      }
      if (key === undefined || key === '') key = process.env[resolved.keyEnv]
      if (key === undefined || key === '') {
        this.balances.set(provider, {
          provider,
          currency: 'CNY',
          total: 0,
          isAvailable: false,
          fetchedAt: Date.now(),
          status: 'unconfigured',
        })
        return
      }
      const base = resolved.baseURL
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 10_000)
        let res: Response
        try {
          res = await fetch(`${base}/user/balance`, {
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as {
          is_available?: unknown
          balance_infos?: unknown
        } | null
        const first = Array.isArray(data?.balance_infos)
          ? (data.balance_infos[0] as { currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown } | undefined)
          : undefined
        const num = (value: unknown): number => {
          const n = typeof value === 'number' ? value
            : typeof value === 'string' && value !== '' ? Number(value)
            : NaN
          return Number.isFinite(n) ? n : 0
        }
        this.balances.set(provider, {
          provider,
          currency: typeof first?.currency === 'string' && first.currency !== ''
            ? first.currency
            : 'CNY',
          total: num(first?.total_balance),
          granted: num(first?.granted_balance),
          toppedUp: num(first?.topped_up_balance),
          isAvailable: data?.is_available !== false,
          fetchedAt: Date.now(),
          status: 'ok',
        })
      } catch (error) {
        const previous = this.balances.get(provider)
        const next: TokenQuotaBalance = {
          provider,
          currency: previous?.currency ?? 'CNY',
          total: previous?.total ?? 0,
          isAvailable: false,
          fetchedAt: previous?.fetchedAt ?? Date.now(),
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }
        // Keep the last good numbers (and only set them when present, since
        // exactOptionalPropertyTypes forbids explicit `undefined`).
        if (previous?.granted !== undefined) next.granted = previous.granted
        if (previous?.toppedUp !== undefined) next.toppedUp = previous.toppedUp
        this.balances.set(provider, next)
      }
    }
    const promise = run().finally(() => { this.balanceFetches.delete(provider) })
    this.balanceFetches.set(provider, promise)
    return promise
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

  /**
   * Remove all historical cycles whose day portion strictly precedes `before`
   * (format `YYYY-MM-DD`). The current cycle is never cleared. Returns the
   * trimmed log so the client can refresh immediately.
   */
  clearLogBefore(before: string): TokenQuotaLog {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return this.readLog()
    const kept: Record<string, Record<string, number>> = {}
    for (const [cycle, usageByKey] of Object.entries(this.history)) {
      const dayPart = cycle.slice(0, 10)
      if (dayPart >= before) {
        kept[cycle] = usageByKey
      }
    }
    this.history = kept
    this.scheduleWrite()
    return this.readLog()
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
    const snapshot: TokenQuotaSnapshot = {
      day: this.cycle,
      entries,
      upgrade: this.upgrade,
      upgradeError: this.upgradeError,
    }
    if (this.balanceEnabled && this.balances.size > 0) snapshot.balances = [...this.balances.values()]
    return snapshot
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
    const sessionId = String(session.id)
    switch (event.type) {
      case 'turn/start':
        this.pushMusicAction({ type: 'turn/start', sessionId })
        break
      case 'turn/end':
        this.pushMusicAction({ type: 'turn/end', sessionId, reason: event.data.reason.kind })
        break
      case 'step/start':
        this.pushMusicAction({ type: 'step/start', sessionId })
        break
      case 'request/header': {
        const { provider, model } = event.data.header.config
        this.headerKeys.set(session, tokenQuotaKey(provider, model))
        this.pushMusicAction({ type: 'request/header', sessionId, provider, model })
        return
      }
      case 'tool/call':
        this.pushMusicAction({ type: 'tool/call', sessionId, name: event.data.name })
        break
      case 'tool/result':
        this.pushMusicAction({ type: 'tool/result', sessionId, error: event.data.error !== undefined })
        break
      case 'assistant/attempt':
        this.pushMusicAction({ type: 'assistant/attempt', sessionId })
        break
      case 'assistant/message':
        this.pushMusicAction({ type: 'assistant/message', sessionId, interrupted: event.data.interrupted === true })
        if (event.data.usage !== undefined) {
          const key = this.headerKeys.get(session)
          if (key === undefined) return
          if (!this.isMonitored(key)) return
          const tokens = usageTokens(event.data.usage)
          if (tokens <= 0) return
          this.rollCycleIfNeeded()
          this.usage[key] = (this.usage[key] ?? 0) + tokens
          this.scheduleWrite()
        }
        break
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
    if (this.disposeRouteClear !== undefined) this.disposeRouteClear()
    if (this.disposeRouteBalance !== undefined) this.disposeRouteBalance()
    if (this.balanceTimer !== undefined) {
      clearTimeout(this.balanceTimer)
      this.balanceTimer = undefined
    }
    if (this.disposeRouteEvents !== undefined) this.disposeRouteEvents()
    for (const res of this.musicClients) {
      try { res.end() } catch { /* ignore */ }
    }
    this.musicClients.clear()
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
