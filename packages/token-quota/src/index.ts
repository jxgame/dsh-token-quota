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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only side-effect: pulls agent/request and agent/pre-step Events augmentations
// the service listens to without importing any runtime value.
import '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, TokenUsage } from '@deepseek-ai/dsh-llm'
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
} from './types.ts'
import { assertTokenQuotaLimit, splitTokenQuotaKey } from './invariant.ts'

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
  onFull: z.union(['stop', 'switchQuota', 'switchAll', 'switchPriority']).default('stop'),
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
  private settingsSource: () => TokenQuotaSettings = () => ({ limits: {}, monitored: [], onFull: 'stop' })
  /** Per-session folded model key from the latest `request/header`. */
  private readonly headerKeys = new WeakMap<Session, string | undefined>()
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  /** Disposer for the optional HTTP snapshot route (`GET /token-quota`). */
  private disposeRoute: (() => void) | undefined
  /** Disposer for the optional usage-history route (`GET /token-quota/log`). */
  private disposeRouteLog: (() => void) | undefined
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
            onFull: doc.onFull ?? 'stop',
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

    // Enforcement + accounting lock: the waterfall's resolved config is the
    // authoritative model for this request — bind it to the agent's session
    // so a model switch mid-flight never misattributes the in-flight reply.
    ctx.on('agent/request', async (payload, next) => this.onRequest(payload, next))

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
    return { day: this.cycle, entries }
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
    if (this.disposeRouteWatcher !== undefined) this.disposeRouteWatcher()
    if (this.disposeRoute !== undefined) this.disposeRoute()
    if (this.disposeRouteLog !== undefined) this.disposeRouteLog()
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
