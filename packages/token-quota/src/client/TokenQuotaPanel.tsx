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
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
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

/** Inlined at build time (tsdown `define`) from package.json; undefined in the type-check-only host build. */
declare const __TOKEN_QUOTA_VERSION__: string | undefined

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
  /** Persist whether the Host may check npm for newer versions. */
  setCheckUpdates: (enabled: boolean) => void
  /** Persist whether the panel dims while the pointer is away / typing. */
  setDimWhenIdle: (enabled: boolean) => void
  /** Ask the Host to check the registry right now, then refresh the snapshot. */
  checkUpdatesNow: () => void
  /** Ask the Host to clear log entries before a date, then refresh the log. */
  clearLogBefore: (before: string) => void
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
]

/** One absolute screen position (left/top for a fixed-positioned element). */
type Pos = { x: number; y: number }

/**
 * Pointer-driven drag of a fixed-positioned element. Deltas are applied
 * relative to the element's current on-screen rect, so the first move is
 * seamless even when the element sits centered via transform (dialogs) or
 * relies on CSS defaults (panel). The panel/dialog can be dragged anywhere
 * on screen — no longer locked inside the overlay seat.
 */
function beginDrag(
  event: ReactPointerEvent,
  el: HTMLElement | null,
  apply: (pos: Pos) => void,
): void {
  if (el === null) return
  event.preventDefault()
  const startX = event.clientX
  const startY = event.clientY
  const rect = el.getBoundingClientRect()
  const baseX = rect.left
  const baseY = rect.top
  const onMove = (ev: PointerEvent): void => {
    apply({ x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) })
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

/** Persisted panel placement so a dragged position survives reloads. */
const PANEL_POS_KEY = 'dsh-token-quota:panel-pos'

function loadPanelPos(): Pos | null {
  try {
    const raw = window.localStorage.getItem(PANEL_POS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as Pos).x === 'number' && typeof (parsed as Pos).y === 'number') {
      return parsed as Pos
    }
  } catch {
    // Corrupted or unavailable storage: fall back to the default placement.
  }
  return null
}

/**
 * Render the floating panel (or its collapsed tab).
 * @param props - composed slot props.
 * @returns the panel element tree.
 */
export function TokenQuotaPanel({
  t, load, setLimit, selectModel, setMonitored, setOnFull, setReset, setCheckUpdates, checkUpdatesNow, clearLogBefore, setDimWhenIdle,
  useStore, actions, useSessions,
}: TokenQuotaPanelComponentProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  // Hover / focus state for the translucent-while-idle behaviour: the panel
  // dims when the mouse is away (and especially while typing in the composer)
  // so the chat content behind it stays readable; hovering restores it.
  const [hovered, setHovered] = useState(false)
  const [inputActive, setInputActive] = useState(false)
  // Copy-button feedback: which command was just copied (label flips to
  // 「已复制」for a moment so the click is perceivable).
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  // Flash state for the upgrade banner: armed when a NEW latest version shows
  // up (either from a manual check or a periodic poll).
  const [upgradeFlash, setUpgradeFlash] = useState(false)
  const flashTimerRef = useRef<number | null>(null)
  const prevUpgradeRef = useRef<string | null>(null)
  // Draggable placements: the panel persists across reloads; the dialogs
  // start centered (null) and remember where they were dragged to.
  const [panelPos, setPanelPos] = useState<Pos | null>(loadPanelPos)
  const [settingsPos, setSettingsPos] = useState<Pos | null>(null)
  const [logPos, setLogPos] = useState<Pos | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const applyPanelPos = (pos: Pos): void => {
    setPanelPos(pos)
    try {
      window.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos))
    } catch {
      // Storage unavailable: the position still applies for this session.
    }
  }
  const sessionId = useSessions(s => s.current)
  const snapshot = useStore(s => s.snapshot)
  const groups = useStore(s => s.groups)
  const current = useStore(s => s.current)
  const monitored = useStore(s => s.monitored)
  const onFull = useStore(s => s.onFull)
  const checkUpdates = useStore(s => s.checkUpdates)
  const dimWhenIdle = useStore(s => s.dimWhenIdle)
  const upgrade = useStore(s => s.upgrade)
  const upgradeDismissed = useStore(s => s.upgradeDismissed)
  const checkingUpdates = useStore(s => s.checkingUpdates)
  const lastCheckResult = useStore(s => s.lastCheckResult)
  const upgradeError = useStore(s => s.upgradeError)
  const reset = useStore(s => s.reset)
  const dialogOpen = useStore(s => s.dialogOpen)
  const logOpen = useStore(s => s.logOpen)
  const log = useStore(s => s.log)
  const logSearch = useStore(s => s.logSearch)
  const logPage = useStore(s => s.logPage)
  const logPageSize = useStore(s => s.logPageSize)
  const logClearOpen = useStore(s => s.logClearOpen)
  const logClearBefore = useStore(s => s.logClearBefore)
  const logClearing = useStore(s => s.logClearing)
  const fullNotice = useStore(s => s.fullNotice)
  const loading = useStore(s => s.loading)
  const error = useStore(s => s.error)

  // Refresh the advisory model directory whenever the current session changes.
  useEffect(() => {
    if (sessionId !== undefined) load(sessionId)
  }, [sessionId, load])

  // Track whether any text input (composer, search, dialogs) currently has
  // focus, so the panel can dim while the user types elsewhere.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null
      const isInput = target !== null && (
        target.matches('input, textarea, [contenteditable="true"]')
        || target.closest('input, textarea, [contenteditable="true"]') !== null
      )
      setInputActive(isInput)
    }
    window.addEventListener('focusin', onFocusIn)
    return () => { window.removeEventListener('focusin', onFocusIn) }
  }, [])

  // When a NEW latest version appears (manual check or periodic poll):
  // expand the panel (it may be collapsed), force it opaque, and flash the
  // upgrade banner a few times so the discovery is unmissable.
  useEffect(() => {
    const latest = upgrade?.latestVersion ?? null
    if (latest !== null && prevUpgradeRef.current !== latest) {
      setCollapsed(false)
      setUpgradeFlash(true)
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => {
        setUpgradeFlash(false)
        flashTimerRef.current = null
      }, 2500)
    }
    prevUpgradeRef.current = latest
    return () => {
      // Keep the timer across re-renders; cleared only on unmount.
    }
  }, [upgrade])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

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

  // Log dialog: filter by search, then paginate.
  const filteredLogEntries = useMemo(() => {
    if (log === null) return []
    const q = logSearch.trim().toLowerCase()
    if (q === '') return log.entries
    return log.entries.filter(e =>
      e.key.toLowerCase().includes(q)
      || e.provider.toLowerCase().includes(q)
      || e.model.toLowerCase().includes(q),
    )
  }, [log, logSearch])
  const logTotalPages = Math.max(1, Math.ceil(filteredLogEntries.length / logPageSize))
  const logCurrentPage = Math.min(logPage, logTotalPages - 1)
  const logPageEntries = useMemo(() => {
    const start = logCurrentPage * logPageSize
    return filteredLogEntries.slice(start, start + logPageSize)
  }, [filteredLogEntries, logCurrentPage, logPageSize])

  /** Copy text to the clipboard (clipboard API with execCommand fallback). */
  const copyToClipboard = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(el)
    }
  }

  /** Copy an upgrade command and show per-button success feedback. */
  const copyUpgradeCommand = (cmd: string): void => {
    void copyToClipboard(cmd)
    setCopiedCmd(cmd)
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedCmd(null)
      copyTimerRef.current = null
    }, 1600)
  }

  // Fetch the usage log whenever the log dialog opens. Kept ABOVE the
  // collapsed early-return: every hook must run on every render, otherwise
  // React unmounts the component the moment the panel collapses (the old
  // placement made the collapsed tab crash instead of showing).
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

  if (collapsed) {
    return (
      <div
        className={css.tab}
        role="button"
        tabIndex={0}
        title={t('expandHint')}
        aria-label={t('expandHint')}
        onClick={() => { setCollapsed(false) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setCollapsed(false)
          }
        }}
      >
        <span className={css.tabIcon} aria-hidden="true">▸</span>
        <span className={css.tabLabel}>{t('expand')}</span>
      </div>
    )
  }

  const openSettings = (): void => {
    actions.setDialogOpen(true)
  }

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
  // The panel dims when the pointer is away ONLY when the user opted in
  // (settings → 失焦窗口透明). While the upgrade banner flashes, the panel
  // is forced opaque regardless.
  const panelDimClass = dimWhenIdle
    ? (hovered || upgradeFlash ? '' : inputActive ? css.panelDimStrong : css.panelDim)
    : ''

  return (
    <div
      ref={panelRef}
      className={`${css.panel}${panelDimClass !== '' ? ` ${panelDimClass}` : ''}`}
      style={panelPos !== null ? { left: panelPos.x, top: panelPos.y, right: 'auto' } : undefined}
      onPointerEnter={() => { setHovered(true) }}
      onPointerLeave={() => { setHovered(false) }}
    >
      <div
        className={css.header}
        onPointerDown={(event) => { beginDrag(event, panelRef.current, applyPanelPos) }}
      >
        <div className={css.headerText}>
          <div className={css.title}>
            {t('title')}
            {__TOKEN_QUOTA_VERSION__ !== undefined && __TOKEN_QUOTA_VERSION__ !== '' && (
              upgrade !== null
                ? (
                  <span className={`${css.version} ${css.versionNew}`} title={t('upgradeAvailableHint')}>
                    v{__TOKEN_QUOTA_VERSION__} → v{upgrade.latestVersion}
                  </span>
                )
                : (
                  <span className={css.version}>v{__TOKEN_QUOTA_VERSION__}</span>
                )
            )}
          </div>
          <div className={css.subtitle}>{t('subtitle')}</div>
        </div>
        <div className={css.headerActions} onPointerDown={(event) => { event.stopPropagation() }}>
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
        {upgrade !== null && !upgradeDismissed && (
          <div className={`${css.upgradeBanner}${upgradeFlash ? ` ${css.upgradeBannerFlash}` : ''}`} role="alert">
            <div className={css.upgradeBannerText}>
              {t('upgradeAvailable').replace('{version}', upgrade.latestVersion)}
            </div>
            <div className={css.upgradeCommands}>
              {upgrade.commands.map(cmd => (
                <div key={cmd} className={css.upgradeCommandRow}>
                  <code className={css.upgradeCommand}>{cmd}</code>
                  <button
                    type="button"
                    className={`${css.copyBtn}${copiedCmd === cmd ? ` ${css.copyBtnDone}` : ''}`}
                    onClick={() => { copyUpgradeCommand(cmd) }}
                  >
                    {copiedCmd === cmd ? t('copied') : t('copy')}
                  </button>
                </div>
              ))}
            </div>
            <div className={css.upgradeHint}>{t('upgradeHint')}</div>
            <button
              type="button"
              className={css.upgradeClose}
              onClick={() => { actions.setUpgradeDismissed(true) }}
              aria-label={t('close')}
            >×</button>
          </div>
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
        <div
          ref={settingsRef}
          className={css.dialog}
          style={settingsPos !== null ? { left: settingsPos.x, top: settingsPos.y, transform: 'none' } : undefined}
        >
          <div
            className={css.dialogHeader}
            onPointerDown={(event) => { beginDrag(event, settingsRef.current, setSettingsPos) }}
          >
            <div className={css.dialogTitle}>{t('settingsTitle')}</div>
            <button
              type="button"
              className={css.dialogClose}
              title={t('close')}
              onClick={() => { actions.setDialogOpen(false) }}
              onPointerDown={(event) => { event.stopPropagation() }}
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
            <div className={css.dialogSection}>
              <label className={css.checkUpdatesLabel}>
                <input
                  type="checkbox"
                  checked={dimWhenIdle}
                  onChange={(event) => { setDimWhenIdle(event.target.checked) }}
                />
                <span>{t('dimWhenIdleLabel')}</span>
              </label>
              <div className={css.dialogHint}>{t('dimWhenIdleHint')}</div>
            </div>
            <div className={css.dialogSection}>
              <div className={css.checkUpdatesRow}>
                <label className={css.checkUpdatesLabel}>
                  <input
                    type="checkbox"
                    checked={checkUpdates}
                    onChange={(event) => { setCheckUpdates(event.target.checked) }}
                  />
                  <span>{t('checkUpdatesLabel')}</span>
                </label>
                <button
                  type="button"
                  className={css.checkBtn}
                  disabled={checkingUpdates}
                  onClick={checkUpdatesNow}
                >
                  {checkingUpdates
                    ? t('checkingUpdates')
                    : lastCheckResult === 'up-to-date'
                      ? t('checkUpToDate')
                      : lastCheckResult === 'error'
                        ? t('checkFailed')
                        : t('checkUpdatesNow')}
                </button>
              </div>
              {lastCheckResult === 'error' && upgradeError !== null && (
                <div className={css.checkErrorHint} role="alert">{upgradeError}</div>
              )}
            </div>
          </div>
      )}
      {logOpen && (
        <div
          ref={logRef}
          className={`${css.dialog} ${css.logDialog}`}
          style={logPos !== null ? { left: logPos.x, top: logPos.y, transform: 'none' } : undefined}
        >
          <div
            className={css.logHeader}
            onPointerDown={(event) => { beginDrag(event, logRef.current, setLogPos) }}
          >
            <div className={css.dialogTitle}>{t('logsTitle')}</div>
            <div className={css.logToolbar} onPointerDown={(event) => { event.stopPropagation() }}>
              <input
                type="search"
                className={css.logSearch}
                placeholder={t('logSearchPlaceholder')}
                value={logSearch}
                onChange={(event) => { actions.setLogSearch(event.target.value) }}
              />
              <button
                type="button"
                className={css.logClearBtn}
                onClick={() => { actions.setLogClearOpen(true) }}
              >
                {t('logClear')}
              </button>
            </div>
            <button
              type="button"
              className={css.dialogClose}
              title={t('close')}
              onClick={() => { actions.setLogOpen(false) }}
            >
              ×
            </button>
          </div>
          {log !== null && filteredLogEntries.length === 0 && (
            <div className={css.notice}>{logSearch.trim() !== '' ? t('logNoMatch') : t('logEmpty')}</div>
          )}
          <div className={css.logScroll}>
            <table className={css.logTable}>
              <thead>
                <tr>
                  <th>{t('logDay')}</th>
                  <th>{t('logModel')}</th>
                  <th className={css.logUsedCol}>{t('logUsed')}</th>
                </tr>
              </thead>
              <tbody>
                {logPageEntries.map(entry => (
                  <tr key={`${entry.day}/${entry.key}`}>
                    <td className={css.logDayCol}>{entry.day}</td>
                    <td className={css.logModelCol} title={entry.key}>{entry.key}</td>
                    <td className={css.logUsedCol}>{formatTokens(entry.used)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={css.logPager}>
            <span className={css.logPagerInfo}>
              {t('logPagerInfo')
                .replace('{from}', String(logCurrentPage * logPageSize + 1))
                .replace('{to}', String(Math.min((logCurrentPage + 1) * logPageSize, filteredLogEntries.length)))
                .replace('{total}', String(filteredLogEntries.length))}
            </span>
            <div className={css.logPagerControls}>
              <button
                type="button"
                className={css.logPagerBtn}
                disabled={logCurrentPage <= 0}
                onClick={() => { actions.setLogPage(logCurrentPage - 1) }}
              >‹</button>
              <span className={css.logPagerPages}>{logCurrentPage + 1} / {logTotalPages}</span>
              <button
                type="button"
                className={css.logPagerBtn}
                disabled={logCurrentPage >= logTotalPages - 1}
                onClick={() => { actions.setLogPage(logCurrentPage + 1) }}
              >›</button>
              <select
                className={css.logPageSizeSelect}
                value={logPageSize}
                onChange={(event) => { actions.setLogPageSize(Number(event.target.value)) }}
              >
                {[10, 15, 20, 50, 100].map(size => (
                  <option key={size} value={size}>{size}{t('logPerPage')}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
      {logClearOpen && (
        <div className={css.dialogOverlay}>
          <div className={`${css.dialog} ${css.logClearDialog}`}>
            <div className={css.dialogTitle}>{t('logClearTitle')}</div>
            <div className={css.dialogBody}>{t('logClearHint')}</div>
            <input
              type="date"
              className={css.logClearDate}
              value={logClearBefore}
              onChange={(event) => { actions.setLogClearBefore(event.target.value) }}
            />
            <div className={css.dialogActions}>
              <button
                type="button"
                className={css.checkBtn}
                disabled={logClearBefore === '' || logClearing}
                onClick={() => { clearLogBefore(logClearBefore) }}
              >
                {logClearing ? t('logClearing') : t('logClearConfirm')}
              </button>
              <button
                type="button"
                className={css.checkBtn}
                onClick={() => { actions.setLogClearOpen(false) }}
              >
                {t('logClearCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}