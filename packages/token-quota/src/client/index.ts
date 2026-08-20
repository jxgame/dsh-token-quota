/**
 * Token-quota browser half: a floating panel over the frame-wide
 * `shell.overlay` seat. It renders one row per MONITORED model (directory
 * merged with the polled quota snapshot), edits per-model daily caps through
 * the settings scope, and switches the current session's model through the
 * Host RPC — so when one model is full the user flips to another in place.
 *
 * Data flows by pull: the panel polls the plugin's own HTTP snapshot route
 * (`GET /token-quota`) on a short interval and syncs monitoring/strategy
 * preferences from the `token-quota` settings namespace. When the current
 * model is a monitored, capped model at its daily cap, the configured
 * full-quota strategy runs: `stop` shows a notice, the other three
 * auto-switch to a suitable model.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConnectionHandle, ModelProviderGroup, ModelSelection, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.remote merge (forwarded event face).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'shell.overlay' SlotMap declaration (the key's owner)
// so both the register name and PropsRuntime narrow against the real
// declaration — no runtime edge to ui-layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: snapshot/settings shapes live in the plugin's own types module.
import type {
  TokenQuotaFullAction,
  TokenQuotaReset,
  TokenQuotaSettings,
  TokenQuotaSnapshot,
} from '@jxgame2020/dsh-token-quota/types'
import { createTokenQuotaPanelStore } from './store.ts'
import type { TokenQuotaPanelInjected } from './TokenQuotaPanel.tsx'
import { TokenQuotaPanel } from './TokenQuotaPanel.tsx'
import { en, zh, type TokenQuotaKey } from './locales.ts'

export type { TokenQuotaPanelInjected } from './TokenQuotaPanel.tsx'
export type { ModelQuotaRow, TokenQuotaPanelState } from './store.ts'
export { mergeModelRows } from './store.ts'
export type { TokenQuotaKey } from './locales.ts'

/** Dictionary namespace owning the panel copy. */
const NS = 'token-quota'

/** Settings namespace the Host quota package owns. */
const TOKEN_QUOTA_NAMESPACE = 'token-quota'

/** Snapshot pull cadence in milliseconds. */
const POLL_INTERVAL_MS = 3000

// Local response shapes for the session RPCs. The Host's RPC contract types
// resolve through workspace-linked declaration files that may not fully
// resolve in a standalone build; these narrow the destructured callbacks to
// exactly the fields the panel uses.
interface ModelsResult {
  ok: boolean
  value: { groups: readonly ModelProviderGroup[]; current: ModelSelection | null }
  error?: { code: string; message: string }
}

interface SelectModelResult {
  ok: boolean
  value: { selected: ModelSelection | null }
  error?: { code: string; message: string }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The token-quota floating panel's copy. */
    'token-quota': TokenQuotaKey
  }
}

/** Required services: slot registry, connection RPC, locale, settings scope. */
export const inject = ['slots', 'connection', 'locale', 'settingsScope']

/**
 * Client plugin body: poll the Host snapshot route, run the full-quota
 * strategy, wire the injected face (directory load, limit write, model
 * switch, preferences), and register the floating panel into `shell.overlay`.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-quota-ui: panel dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<TokenQuotaSettings>({ namespace: TOKEN_QUOTA_NAMESPACE })
  const connection = ctx.get('connection') as ConnectionHandle

  // Store handle shared with the registration; the framework instantiates the
  // live store per entry and hands its bound actions to the inject factory,
  // so the apply-world only ever writes through `bound`.
  const store = createTokenQuotaPanelStore()
  let bound: BoundActions<typeof store> | undefined
  let lastGroups: readonly ModelProviderGroup[] = []
  let lastCurrent: ModelSelection | null = null
  let lastSessionId: SessionId | undefined
  let lastMonitored: string[] | null = null
  let lastOnFull: TokenQuotaFullAction = 'stop'
  let lastReset: TokenQuotaReset | null = null

  const keyOf = (selection: ModelSelection | null): string | undefined => {
    if (selection === null) return undefined
    return `${selection.provider}/${selection.model}`
  }

  const isMonitoredKey = (key: string): boolean => lastMonitored === null || lastMonitored.includes(key)

  /** Pick an auto-switch target for the configured strategy. */
  const pickSwitchTarget = (
    snapshot: TokenQuotaSnapshot,
    currentKey: string,
  ): { provider: string; model: string } | undefined => {
    const entryByKey = new Map(snapshot.entries.map(entry => [entry.key, entry]))
    const candidates: Array<{ key: string; provider: string; model: string; limit: number; used: number }> = []
    for (const group of lastGroups) {
      for (const model of group.models) {
        const key = `${group.id}/${model.id}`
        if (key === currentKey) continue
        const entry = entryByKey.get(key)
        candidates.push({
          key,
          provider: group.id,
          model: model.id,
          limit: entry?.limit ?? 0,
          used: entry?.used ?? 0,
        })
      }
    }
    const available = (candidate: typeof candidates[number]): boolean =>
      isMonitoredKey(candidate.key) && (candidate.limit <= 0 || candidate.used < candidate.limit)
    if (lastOnFull === 'switchQuota') {
      return candidates
        .filter(candidate => isMonitoredKey(candidate.key) && candidate.limit > 0 && candidate.used < candidate.limit)
        .sort((a, b) => (a.used / a.limit) - (b.used / b.limit))[0]
    }
    if (lastOnFull === 'switchAll') {
      return candidates.filter(available)[0]
    }
    // switchPriority: uncapped first, then unmonitored, then capped-but-free.
    const uncapped = candidates.find(candidate => isMonitoredKey(candidate.key) && candidate.limit <= 0)
    if (uncapped !== undefined) return uncapped
    const unmonitored = candidates.find(candidate => !isMonitoredKey(candidate.key))
    if (unmonitored !== undefined) return unmonitored
    return candidates.find(available)
  }

  /** Run the configured full-quota strategy once per exhausted model. */
  const actOnFull = (snapshot: TokenQuotaSnapshot): void => {
    const currentKey = keyOf(lastCurrent)
    if (currentKey === undefined) return
    if (!isMonitoredKey(currentKey)) return
    const entry = snapshot.entries.find(candidate => candidate.key === currentKey)
    if (entry === undefined || entry.limit <= 0 || entry.used < entry.limit) return
    if (lastOnFull === 'stop' || lastSessionId === undefined) {
      bound?.setFullNotice(t('fullNotice'))
      return
    }
    const target = pickSwitchTarget(snapshot, currentKey)
    if (target === undefined) {
      bound?.setFullNotice(t('fullSwitchFailed'))
      return
    }
    void connection.api.sessions.selectModel({
      sessionId: lastSessionId,
      provider: target.provider,
      model: target.model,
    }).then(
      ({ result }: { result: SelectModelResult }) => {
        if (result.ok) {
          lastCurrent = result.value.selected
          bound?.setFullNotice(null)
          pull()
        } else {
          bound?.setFullNotice(t('fullSwitchFailed'))
        }
      },
      () => { bound?.setFullNotice(t('fullSwitchFailed')) },
    )
  }

  // Poll the Host's snapshot route and sync panel preferences. The Host is the
  // single fact source for usage AND the resolved per-model caps; the panel
  // converges within one poll interval (plus an immediate first pull). Every
  // few pulls we re-read the model directory so a model switch made OUTSIDE
  // this panel (the official selector, /model) moves the 「当前」 badge too.
  let pullCount = 0
  const refreshCurrent = (): void => {
    if (lastSessionId === undefined) return
    void connection.api.sessions.models({ sessionId: lastSessionId }).then(
      ({ result }: { result: ModelsResult }) => {
        if (result.ok) {
          lastGroups = result.value.groups
          lastCurrent = result.value.current
          bound?.setDirectory(result.value.groups, result.value.current)
        }
      },
      () => { /* keep the previous directory on a transient failure */ },
    )
  }
  const pull = (): void => {
    pullCount += 1
    const doc = scope.getSnapshot().value
    lastMonitored = doc?.monitored !== undefined && doc.monitored.length > 0 ? doc.monitored : null
    lastOnFull = doc?.onFull ?? 'stop'
    lastReset = doc?.reset !== undefined && doc.reset !== null
      && typeof doc.reset === 'object'
      && typeof (doc.reset as TokenQuotaReset).offsetHours === 'number'
      ? doc.reset as TokenQuotaReset
      : null
    bound?.setSettings(lastMonitored, lastOnFull)
    bound?.setReset(lastReset)
    void fetch('/token-quota', { headers: { accept: 'application/json' } }).then(
      (response) => {
        if (!response.ok) {
          bound?.setError(`quota route: ${String(response.status)}`)
          return
        }
        return response.json() as Promise<TokenQuotaSnapshot>
      },
      () => {
        bound?.setError('quota snapshot pull failed')
      },
    ).then((snapshot) => {
      if (snapshot === undefined) return
      bound?.setSnapshot(snapshot)
      actOnFull(snapshot)
    })
    if (pullCount % 4 === 0) refreshCurrent()
  }
  ctx.effect(() => {
    pull()
    const timer = setInterval(pull, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, 'token-quota-ui: snapshot poll + full strategy')

  const load = (sessionId: SessionId): void => {
    lastSessionId = sessionId
    bound?.setLoading(true)
    bound?.setError(null)
    void connection.api.sessions.models({ sessionId }).then(
      ({ result }: { result: ModelsResult }) => {
        if (result.ok) {
          lastGroups = result.value.groups
          lastCurrent = result.value.current
          bound?.setDirectory(result.value.groups, result.value.current)
          bound?.setLoading(false)
        } else {
          bound?.setError(`${result.error!.code}: ${result.error!.message}`)
          bound?.setLoading(false)
        }
      },
      () => {
        bound?.setLoading(false)
        bound?.setError('directory load failed')
      },
    )
  }

  const setLimit = (key: string, limit: number): void => {
    const current = scope.getSnapshot().value?.limits ?? {}
    void scope.set('limits', { ...current, [key]: limit })
  }

  const setMonitored = (monitored: string[] | null): void => {
    lastMonitored = monitored
    bound?.setSettings(lastMonitored, lastOnFull)
    void scope.set('monitored', monitored ?? [])
  }

  const setOnFull = (action: TokenQuotaFullAction): void => {
    lastOnFull = action
    bound?.setSettings(lastMonitored, lastOnFull)
    void scope.set('onFull', action)
  }

  const setReset = (reset: TokenQuotaReset | null): void => {
    lastReset = reset
    bound?.setReset(reset)
    void scope.set('reset', reset)
  }

  const selectModel = (sessionId: SessionId, provider: string, model: string): void => {
    void connection.api.sessions.selectModel({ sessionId, provider, model }).then(
      ({ result }: { result: SelectModelResult }) => {
        if (result.ok) {
          lastCurrent = result.value.selected
          bound?.setDirectory(lastGroups, result.value.selected)
          // Immediately re-pull the snapshot so the previous model's final
          // usage (credited around the switch) shows without waiting 3 s.
          pull()
        } else {
          bound?.setError(`${result.error!.code}: ${result.error!.message}`)
        }
      },
      () => {
        bound?.setError('model switch failed')
      },
    )
  }

  const injected = (actions: BoundActions<typeof store>): TokenQuotaPanelInjected => {
    bound = actions
    return { load, setLimit, selectModel, setMonitored, setOnFull, setReset }
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'token-quota',
    order: 100,
    label: () => t('title'),
    store,
    locale: NS,
    inject: injected,
  }, TokenQuotaPanel))
}
