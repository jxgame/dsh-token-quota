/**
 * Token-quota floating panel, registered into the frame-wide `shell.overlay`
 * seat. Renders one row per MONITORED model of the current session's
 * directory merged with the live quota snapshot: name, a compact `选择` action,
 * `used / limit`, a progress bar, and an icon-folded limit editor. A settings
 * dialog (header button) chooses which models are monitored and what to do
 * when a capped model is full. The panel is pure presentation — every fact
 * arrives through the props shares and every mutation through the injected
 * callbacks.
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'shell.overlay' SlotMap declaration (the key's owner)
// into this program so PropsRuntime<'shell.overlay'> typechecks against the
// real declaration — no runtime edge to ui-layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  TokenQuotaFullAction,
  TokenQuotaLog,
  TokenQuotaReset,
} from '@jxgame2020/dsh-token-quota/types'
import type { createTokenQuotaPanelStore, ModelQuotaRow } from './store.ts'
import { mergeModelRows } from './store.ts'
import type { TokenQuotaKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import css from './TokenQuotaPanel.module.css'

/** Injected business face: data loading and mutations wired in `apply`. */
export interface TokenQuotaPanelInjected {
  /** Refresh the model directory for one session. */
  load: (sessionId: SessionId) => void
  /** Persist one model's daily cap (0 = unlimited) through the settings scope. */
  setLimit: (key: string, limit: number) => void
  /** Switch the current session to one route through the Host RPC. */
  selectModel: (sessionId: SessionId, provider: string, model: string) => void
  /** Persist the monitored-model selection (null = every model). */
  setMonitored: (monitored: string[] | null) => void
  /** Persist the full-quota strategy. */
  setOnFull: (action: TokenQuotaFullAction) => void
  /** Persist the daily reset moment (null = machine-local midnight). */
  setReset: (reset: TokenQuotaReset | null) => void
}

/** Full component props: runtime + store + locale + injected face. */
export type TokenQuotaPanelComponentProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createTokenQuotaPanelStore>>
  & PropsLocale<'token-quota'>
  & TokenQuotaPanelInjected

/** Compact a token count for display. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Bar fill state for one row. */
type BarState = 'idle' | 'warn' | 'over'

function barStateOf(row: ModelQuotaRow): BarState {
  if (row.limit <= 0) return row.used > 0 ? 'warn' : 'idle'
  if (row.used >= row.limit) return 'over'
  if (row.used / row.limit >= 0.8) return 'warn'
  return 'idle'
}

/** Full-quota strategy choices, in display order. */
const FULL_ACTIONS: ReadonlyArray<{ value: TokenQuotaFullAction; labelKey: TokenQuotaKey }> = [
  { value: 'stop', labelKey: 'fullStop' },
  { value: 'switchQuota', labelKey: 'fullSwitchQuota' },
  { value: 'switchAll', labelKey: 'fullSwitchAll' },
  { value: 'switchPriority', labelKey: 'fullSwitchPriority' },
]

/**
 * Render the floating panel (or its collapsed tab).
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function TokenQuotaPanel({
  t, load, setLimit, selectModel, setMonitored, setOnFull, setReset, useStore, actions, useSessions,
}: TokenQuotaPanelComponentProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const sessionId = useSessions(s => s.current)
  const snapshot = useStore(s => s.snapshot)
  const groups = useStore(s => s.groups)
  const current = useStore(s => s.current)
  const monitored = useStore(s => s.monitored)
  const onFull = useStore(s => s.onFull)
  const reset = useStore(s => s.reset)
  const dialogOpen = useStore(s => s.dialogOpen)
  const logOpen = useStore(s => s.logOpen)
  const log = useStore(s => s.log)
  const fullNotice = useStore(s => s.fullNotice)
  const loading = useStore(s => s.loading)
  const error = useStore(s => s.error)

  // Refresh the advisory model directory whenever the current session changes.
  useEffect(() => {
    if (sessionId !== undefined) load(sessionId)
  }, [sessionId, load])

  const rows = useMemo(
    () => mergeModelRows(groups, snapshot, current),
    [groups, snapshot, current],
  )

  // All directory models, flattened for the monitoring picker.
  const allModels = useMemo(
    () => groups.flatMap(group => group.models.map((model: { id: string; name: string }) => ({
      key: `${group.id}/${model.id}`,
      name: model.name,
    }))).sort((a, b) => a.key.localeCompare(b.key)),
    [groups],
  )

  const isMonitoredKey = (key: string): boolean => monitored === null || monitored.includes(key)

  if (collapsed) {
    return (
      <div
        className={css.tab}
        role="button"
        tabIndex={0}
        title={t('title')}
        onClick={() => { setCollapsed(false) }}
      >
        <span className={css.tabLabel}>{t('expand')}</span>
      </div>
    )
  }

  const openSettings = (): void => {
    actions.setDialogOpen(true)
  }

  // Fetch the usage log whenever the log dialog opens.
  useEffect(() => {
    if (!logOpen) return
    let cancelled = false
    void fetch('/token-quota/log', { headers: { accept: 'application/json' } }).then(
      (response) => response.json() as Promise<TokenQuotaLog>,
      () => null,
    ).then((data) => {
      if (!cancelled) actions.setLog(data)
    })
    return () => { cancelled = true }
  }, [logOpen, actions])

  const commitLimit = (row: ModelQuotaRow): void => {
    const raw = drafts[row.key]?.trim()
    setDrafts((prev) => {
      const { [row.key]: _dropped, ...rest } = prev
      return rest
    })
    setEditingKey(null)
    if (raw === undefined || raw === '') return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return
    setLimit(row.key, parsed)
  }

  const visibleRows = rows.filter(row => isMonitoredKey(row.key) || row.current)

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <div className={css.headerText}>
          <div className={css.title}>{t('title')}</div>
          <div className={css.subtitle}>{t('subtitle')}</div>
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.settingsBtn} onClick={() => { actions.setLogOpen(true) }}>
            {t('logs')}
          </button>
          <button type="button" className={css.settingsBtn} onClick={openSettings}>
            {t('settings')}
          </button>
          <button type="button" className={css.collapse} onClick={() => { setCollapsed(true) }}>
            {t('collapse')}
          </button>
        </div>
      </div>
      <div className={css.body}>
        {loading && <div className={css.notice}>{t('loading')}</div>}
        {error !== null && <div className={css.noticeError}>{error}</div>}
        {fullNotice !== null && (
          <div className={css.fullNotice} role="alert">{fullNotice}</div>
        )}
        {!loading && error === null && visibleRows.length === 0 && (
          <div className={css.notice}>
            {monitored !== null && monitored.length === 0 ? t('noMonitored') : t('waiting')}
          </div>
        )}
        {visibleRows.map((row) => {
          const state = barStateOf(row)
          const pct = row.limit > 0 ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0
          const barClass = state === 'over'
            ? css.fillOver
            : state === 'warn'
              ? css.fillWarn
              : css.fillIdle
          const editing = editingKey === row.key
          return (
            <div key={row.key} className={css.row}>
              <div className={css.rowHeader}>
                <span className={css.rowName} title={row.key}>
                  {row.name}
                  {row.current && <span className={css.currentBadge}>{t('current')}</span>}
                  {sessionId !== undefined && !row.current && (
                    <button
                      type="button"
                      className={css.selectBtn}
                      onClick={() => { selectModel(sessionId, row.provider, row.model) }}
                    >
                      {t('select')}
                    </button>
                  )}
                </span>
                <span className={css.rowMeta}>
                  {row.limit > 0
                    ? `${formatTokens(row.used)} / ${formatTokens(row.limit)}`
                    : `${formatTokens(row.used)} · ${t('unlimited')}`}
                  <button
                    type="button"
                    className={css.gearBtn}
                    title={t('setLimitHint')}
                    onClick={() => { setEditingKey(editing ? null : row.key) }}
                  >
                    ⚙
                  </button>
                </span>
              </div>
              <div className={css.bar}>
                <div className={barClass} style={{ width: `${pct}%` }} />
              </div>
              {editing && (
                <div className={css.controls}>
                  <input
                    className={css.input}
                    type="number"
                    min={0}
                    step={10000}
                    placeholder={t('limitPlaceholder')}
                    value={drafts[row.key] ?? ''}
                    onChange={(event) => { setDrafts(prev => ({ ...prev, [row.key]: event.target.value })) }}
                    onKeyDown={(event) => { if (event.key === 'Enter') commitLimit(row) }}
                  />
                  <button type="button" className={css.save} onClick={() => { commitLimit(row) }}>
                    {t('save')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {dialogOpen && (
        <div className={css.dialogBackdrop} onClick={() => { actions.setDialogOpen(false) }}>
          <div className={css.dialog} onClick={(event) => { event.stopPropagation() }}>
            <div className={css.dialogHeader}>
              <div className={css.dialogTitle}>{t('settingsTitle')}</div>
              <button
                type="button"
                className={css.dialogClose}
                title={t('close')}
                onClick={() => { actions.setDialogOpen(false) }}
              >
                ×
              </button>
            </div>
            <div className={css.dialogSection}>
              <div className={css.dialogLabel}>{t('monitorLabel')}</div>
              <div className={css.monitorHint}>{t('monitorHint')}</div>
              <div className={css.monitorList}>
                {allModels.map(model => (
                  <label key={model.key} className={css.monitorRow}>
                    <input
                      type="checkbox"
                      checked={monitored === null || monitored.includes(model.key)}
                      onChange={(event) => {
                        const base = monitored === null ? allModels.map(m => m.key) : monitored
                        const next = new Set(base)
                        if (event.target.checked) next.add(model.key)
                        else next.delete(model.key)
                        // Auto-save on every change; all selected stores as null.
                        setMonitored(next.size === allModels.length ? null : [...next])
                      }}
                    />
                    <span className={css.monitorName} title={model.key}>{model.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className={css.dialogSection}>
              <div className={css.dialogLabel}>{t('fullActionLabel')}</div>
              {FULL_ACTIONS.map(action => (
                <label key={action.value} className={css.radioRow}>
                  <input
                    type="radio"
                    name="token-quota-onfull"
                    checked={onFull === action.value}
                    onChange={() => { setOnFull(action.value) }}
                  />
                  <span>{t(action.labelKey)}</span>
                </label>
              ))}
            </div>
            <div className={css.dialogSection}>
              <div className={css.dialogLabel}>{t('resetLabel')}</div>
              <div className={css.monitorHint}>{t('resetHint')}</div>
              <div className={css.resetRow}>
                <select
                  className={css.resetSelect}
                  value={reset?.offsetHours ?? -new Date().getTimezoneOffset() / 60}
                  onChange={(event) => {
                    setReset({
                      offsetHours: Number(event.target.value),
                      hour: reset?.hour ?? 0,
                      minute: reset?.minute ?? 0,
                    })
                  }}
                >
                  {Array.from({ length: 27 }, (_, i) => i - 12).map(offset => (
                    <option key={offset} value={offset}>
                      UTC{offset >= 0 ? `+${offset}` : offset}
                    </option>
                  ))}
                </select>
                <select
                  className={css.resetSelect}
                  value={reset?.hour ?? 0}
                  onChange={(event) => {
                    setReset({
                      offsetHours: reset?.offsetHours ?? -new Date().getTimezoneOffset() / 60,
                      hour: Number(event.target.value),
                      minute: reset?.minute ?? 0,
                    })
                  }}
                >
                  {Array.from({ length: 24 }, (_, i) => i).map(hour => (
                    <option key={hour} value={hour}>{String(hour).padStart(2, '0')} 时</option>
                  ))}
                </select>
                <select
                  className={css.resetSelect}
                  value={reset?.minute ?? 0}
                  onChange={(event) => {
                    setReset({
                      offsetHours: reset?.offsetHours ?? -new Date().getTimezoneOffset() / 60,
                      hour: reset?.hour ?? 0,
                      minute: Number(event.target.value),
                    })
                  }}
                >
                  {Array.from({ length: 12 }, (_, i) => i * 5).map(minute => (
                    <option key={minute} value={minute}>{String(minute).padStart(2, '0')} 分</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}
      {logOpen && (
        <div className={css.dialogBackdrop} onClick={() => { actions.setLogOpen(false) }}>
          <div className={css.dialog} onClick={(event) => { event.stopPropagation() }}>
            <div className={css.dialogHeader}>
              <div className={css.dialogTitle}>{t('logsTitle')}</div>
              <button
                type="button"
                className={css.dialogClose}
                title={t('close')}
                onClick={() => { actions.setLogOpen(false) }}
              >
                ×
              </button>
            </div>
            {log !== null && log.entries.length === 0 && (
              <div className={css.notice}>{t('logEmpty')}</div>
            )}
            <table className={css.logTable}>
              <thead>
                <tr>
                  <th>{t('logDay')}</th>
                  <th>{t('logModel')}</th>
                  <th className={css.logUsedCol}>{t('logUsed')}</th>
                </tr>
              </thead>
              <tbody>
                {log?.entries.map(entry => (
                  <tr key={`${entry.day}/${entry.key}`}>
                    <td className={css.logDayCol}>{entry.day}</td>
                    <td className={css.logModelCol} title={entry.key}>{entry.key}</td>
                    <td className={css.logUsedCol}>{formatTokens(entry.used)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}