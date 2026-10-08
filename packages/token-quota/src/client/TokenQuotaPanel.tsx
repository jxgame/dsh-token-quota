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
// Type-only: pulls the ui-session standard props merge (useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TokenQuotaBalance,
  TokenQuotaFullAction,
  TokenQuotaLog,
  TokenQuotaMusicStyle,
  TokenQuotaNote,
  TokenQuotaReset,
} from '@jxgame2020/dsh-token-quota/types'
import { TOKEN_QUOTA_BALANCE_PROVIDERS, TOKEN_QUOTA_MAX_NOTES } from '@jxgame2020/dsh-token-quota/types'
import type { createTokenQuotaPanelStore, ModelQuotaRow } from './store.ts'
import { mergeModelRows, reorderKeys } from './store.ts'
import type { TokenQuotaKey } from './locales.ts'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
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
  /** Persist the drag-to-reorder display order of model rows. */
  setModelOrder: (order: string[]) => void
  /** Persist the floating scratchpad notes (content, title, placement). */
  saveNotes: (notes: TokenQuotaNote[]) => void
  /** Persist the account-balance display settings. */
  setBalanceSettings: (enabled: boolean, pollMinutes: number) => void
  /** Ask the Host to refresh account balances (one provider, or all). */
  refreshBalance: (provider?: string) => void
  /** Toggle the live music output (requires a user gesture to start audio). */
  setMusicEnabled: (enabled: boolean) => void
  /** Change the live-music master volume 0..1. */
  setMusicVolume: (volume: number) => void
  /** Change the live-music harmonic style. */
  setMusicStyle: (style: TokenQuotaMusicStyle) => void
  /** Toggle whether the soundtrack follows only the current session. */
  setMusicOnlyCurrentSession: (only: boolean) => void
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

/**
 * Pointer-driven resize of a note window from its bottom-right grip. Sizes are
 * absolute pixels derived from the element's rect at grab time, so the window
 * keeps its top-left anchor while the pointer moves. A floor keeps a window
 * from collapsing to nothing.
 */
function beginResize(
  event: ReactPointerEvent,
  el: HTMLElement | null,
  apply: (size: { width: number; height: number }) => void,
): void {
  if (el === null) return
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const rect = el.getBoundingClientRect()
  const onMove = (ev: PointerEvent): void => {
    apply({
      width: Math.max(NOTE_MIN_WIDTH, Math.round(rect.width + (ev.clientX - startX))),
      height: Math.max(NOTE_MIN_HEIGHT, Math.round(rect.height + (ev.clientY - startY))),
    })
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

/** First visible character of a note title, for its header chip. */
function noteInitial(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return '·'
  return Array.from(trimmed)[0] ?? '·'
}

/** Currency symbol for the balance bar; a raw code is appended for unknowns. */
function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  if (currency === 'EUR') return '€'
  if (currency === 'GBP') return '£'
  return `${currency} `
}

/** Short "Last: MM-dd HH:mm:ss" timestamp for the balance window footer. */
function formatBalanceTime(epochMs: number): string {
  const d = new Date(epochMs)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}:${ss}`
}

/** Default geometry of a new note; later notes cascade so they don't stack. */
const NOTE_DEFAULT_SIZE = 220
const NOTE_MIN_WIDTH = 150
const NOTE_MIN_HEIGHT = 70

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
  t, load, setLimit, selectModel, setMonitored, setOnFull, setReset, setCheckUpdates, checkUpdatesNow, clearLogBefore, setDimWhenIdle, setModelOrder, saveNotes, setBalanceSettings, refreshBalance,
  setMusicEnabled, setMusicVolume, setMusicStyle, setMusicOnlyCurrentSession,
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
  // Active settings-dialog tab: quota limits vs. live-music vs. misc.
  const [settingsTab, setSettingsTab] = useState<'quota' | 'music' | 'other'>('quota')
  // Drag-to-reorder state for the model rows: the key being dragged and
  // the key currently hovered as the drop target.
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)

  // ---- Floating scratchpad notes -------------------------------------------
  // The notes live in local state while the panel is mounted: every keystroke
  // updates this copy (so typing is never laggy) and a debounced write pushes
  // it to the Host. Seeding happens exactly once, when the Host's document
  // first arrives, so a background settings poll cannot clobber the text.
  const storedNotes = useStore(s => s.notes)
  const storedNotesLoaded = useStore(s => s.notesLoaded)
  const [notes, setNotes] = useState<TokenQuotaNote[]>([])
  const notesSeeded = useRef(false)
  const notesTimer = useRef<number | null>(null)
  // Latest value awaiting a debounced write, so an unmount can flush it.
  const notesPending = useRef<TokenQuotaNote[] | null>(null)
  // Context menu opened by right-clicking a note chip.
  const [noteMenu, setNoteMenu] = useState<{ id: string, x: number, y: number } | null>(null)
  // Note window that was touched last, painted above its siblings.
  const [activeNote, setActiveNote] = useState<string | null>(null)
  // Balance window: docked to the panel's left edge when open.
  const [balanceOpen, setBalanceOpen] = useState(false)
  const [balancePos, setBalancePos] = useState<{ x: number, y: number } | null>(null)
  const [balanceSort, setBalanceSort] = useState<{ key: 'provider' | 'total', dir: 1 | -1 } | null>(null)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null)
  /** Which model row is currently hovered (model key), for quota/balance flip. */
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null)
  /** Flip state in rowMeta: 0 = shows quota text, 1 = shows balance text. Cycles every 3s while hovering. */
  const [metaToggle, setMetaToggle] = useState(0)
  /** Last time we auto-refreshed a stale balance on row-hover (per-provider epoch ms),
   *  throttles refreshes to at most one per 60s per provider. */
  const lastRowStaleRefreshRef = useRef<Record<string, number>>({})
  // Note whose title is being edited (id) plus the in-progress draft. The
  // title is a plain label until the pencil is pressed, so the title bar
  // stays fully draggable the rest of the time.
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')

  useEffect(() => {
    if (!storedNotesLoaded || notesSeeded.current) return
    notesSeeded.current = true
    setNotes(storedNotes)
  }, [storedNotesLoaded, storedNotes])

  // Flush a pending debounced write when the panel goes away, so keystrokes
  // typed in the last fraction of a second are not lost.
  useEffect(() => () => {
    if (notesTimer.current !== null) window.clearTimeout(notesTimer.current)
    const pending = notesPending.current
    if (pending !== null) {
      notesPending.current = null
      saveNotes(pending)
    }
  }, [])

  /**
   * Apply a note change locally and persist it. Structural changes (create,
   * close, collapse, drop) write straight through; free-form edits (typing,
   * dragging, resizing) are debounced so a keystroke doesn't hit the Host.
   */
  const commitNotes = (next: TokenQuotaNote[], immediate = true): void => {
    setNotes(next)
    if (notesTimer.current !== null) window.clearTimeout(notesTimer.current)
    if (immediate) {
      notesPending.current = null
      saveNotes(next)
      return
    }
    notesPending.current = next
    notesTimer.current = window.setTimeout(() => {
      notesTimer.current = null
      const pending = notesPending.current
      notesPending.current = null
      if (pending !== null) saveNotes(pending)
    }, 400)
  }

  const patchNote = (id: string, patch: Partial<TokenQuotaNote>, immediate = true): void => {
    commitNotes(notes.map(note => (note.id === id ? { ...note, ...patch } : note)), immediate)
  }

  /** Create a note, auto-titled 新建N with the lowest unused number. */
  const createNote = (): void => {
    if (notes.length >= TOKEN_QUOTA_MAX_NOTES) return
    let index = 1
    const used = new Set(notes.map(note => /^新建(\d+)$/.exec(note.title.trim())?.[1]).filter(Boolean))
    while (used.has(String(index))) index += 1
    const step = notes.length * 28
    commitNotes([...notes, {
      id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title: `新建${index}`,
      text: '',
      x: 120 + step,
      y: 140 + step,
      width: NOTE_DEFAULT_SIZE,
      height: NOTE_DEFAULT_SIZE,
      collapsed: false,
      visible: true,
    }])
  }

  /** Commit the title draft and leave edit mode. */
  const commitTitle = (id: string): void => {
    patchNote(id, { title: titleDraft }, true)
    setEditingTitle(null)
  }

  const closeNote = (id: string): void => { patchNote(id, { visible: false }) }
  const removeNote = (id: string): void => {
    commitNotes(notes.filter(note => note.id !== id))
    setNoteMenu(null)
  }

  /**
   * Title-bar drag with a click/drag threshold: moving the pointer past a few
   * pixels drags the window, while a plain click focuses the title input for
   * editing. A title that is already being edited keeps native text behaviour
   * (selection, caret placement) instead of turning into a window drag.
   */
  const beginNoteBarDrag = (event: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    const win = event.currentTarget.parentElement
    if (win === null) return
    if ((event.target as HTMLElement).closest('button') !== null) return
    // While the title is being edited the input keeps native text behaviour.
    if ((event.target as HTMLElement).closest('input') !== null) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const rect = win.getBoundingClientRect()
    let dragging = false
    const onMove = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return
        dragging = true
        const active = document.activeElement
        if (active instanceof HTMLElement) active.blur()
      }
      patchNote(id, {
        x: Math.round(rect.left + (ev.clientX - startX)),
        y: Math.round(rect.top + (ev.clientY - startY)),
      }, false)
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
  const order = useStore(s => s.order)
  const balances = useStore(s => s.balances)
  const balanceEnabled = useStore(s => s.balanceEnabled)
  const balancePollMinutes = useStore(s => s.balancePollMinutes)
  const musicEnabled = useStore(s => s.musicEnabled)
  const musicVolume = useStore(s => s.musicVolume)
  const musicStyle = useStore(s => s.musicStyle)
  const musicOnlyCurrentSession = useStore(s => s.musicOnlyCurrentSession)
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
    () => mergeModelRows(groups, snapshot, current, order),
    [groups, snapshot, current, order],
  )

  // All directory models, flattened for the monitoring picker — same drag
  // order as the panel rows so both lists read identically.
  const allModels = useMemo(() => {
    const list = groups.flatMap(group => group.models.map((model: { id: string; name: string }) => ({
      key: `${group.id}/${model.id}`,
      name: model.name,
    })))
    const rank = new Map(order.map((key, index) => [key, index]))
    return list.sort((left, right) => {
      const leftRank = rank.get(left.key)
      const rightRank = rank.get(right.key)
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
      if (leftRank !== undefined) return -1
      if (rightRank !== undefined) return 1
      return left.key.localeCompare(right.key)
    })
  }, [groups, order])

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

  // Distinct providers from the current session's model directory — the rows
  // the balance window lists.
  const providers = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const group of groups) if (!seen.has(group.id)) { seen.add(group.id); list.push(group.id) }
    if (list.length === 0) list.push('deepseek')
    return list
  }, [groups])

  // Balance by provider key, built from the snapshot (status ok/error/unconfigured)
  // plus a client-side "unsupported" sentinel for providers the Host does not
  // yet know how to query, and "loading" for supported ones not yet returned.
  const balanceByProvider = useMemo(() => {
    const map = new Map<string, TokenQuotaBalance | 'unsupported' | 'loading'>()
    for (const provider of providers) {
      const bal = balances.find(b => b.provider === provider)
      if (bal !== undefined) {
        map.set(provider, bal)
      } else if (TOKEN_QUOTA_BALANCE_PROVIDERS.includes(provider)) {
        map.set(provider, 'loading')
      } else {
        map.set(provider, 'unsupported')
      }
    }
    return map
  }, [providers, balances])

  // Sorted list honoring the current header sort click. Errors / unsupported /
  // unconfigured cluster at the bottom regardless of sort.
  const sortedProviders = useMemo(() => {
    const toNum = (entry: TokenQuotaBalance | 'unsupported' | 'loading'): number => {
      if (typeof entry === 'string') return -1
      if (entry.status === 'ok') return entry.total
      return -1
    }
    const statusOrder = (entry: TokenQuotaBalance | 'unsupported' | 'loading'): number => {
      if (entry === 'loading') return 0
      if (entry === 'unsupported') return 3
      if (entry.status === 'ok' && entry.isAvailable && entry.total >= 5) return 0
      if (entry.status === 'ok' && entry.total < 5) return 1
      if (entry.status === 'unconfigured') return 3
      if (entry.status === 'error') return 2
      return 0
    }
    return [...providers].sort((left, right) => {
      const lEntry = balanceByProvider.get(left)
      const rEntry = balanceByProvider.get(right)
      if (lEntry === undefined || rEntry === undefined) return 0
      const ls = statusOrder(lEntry), rs = statusOrder(rEntry)
      if (ls !== rs) return ls - rs
      if (balanceSort === null) return left.localeCompare(right)
      if (balanceSort.key === 'provider') {
        return left.localeCompare(right) * balanceSort.dir
      }
      return (toNum(lEntry) - toNum(rEntry)) * balanceSort.dir
    })
  }, [providers, balanceByProvider, balanceSort])

  /** Most recent successful fetch time (epoch ms), for the "Last: ..." line. */
  const lastFetchedAt = useMemo(() => {
    let latest = 0
    for (const bal of balances) if (bal.status === 'ok') latest = Math.max(latest, bal.fetchedAt)
    return latest
  }, [balances])

  /** Format a balance value for display, or a state label. */
  const renderProviderCell = (provider: string): { text: string; cls?: string; title?: string } => {
    const entry = balanceByProvider.get(provider)
    if (entry === undefined) return { text: '' }
    if (entry === 'loading') {
      return { text: t('balanceLoading'), cls: css.balanceStateHint as string }
    }
    if (entry === 'unsupported') {
      return { text: t('balanceUnsupported'), cls: css.balanceStateHint as string }
    }
    switch (entry.status) {
      case 'unconfigured': {
        return {
          text: t('balanceUnconfiguredShort'),
          cls: css.balanceStateHint as string,
          title: t('balanceUnconfiguredHint'),
        }
      }
      case 'error': {
        if (entry.total > 0) {
          return entry.error !== undefined
            ? {
                text: `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`,
                cls: css.balanceValueError as string,
                title: entry.error,
              }
            : {
                text: `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`,
                cls: css.balanceValueError as string,
              }
        }
        return entry.error !== undefined
          ? { text: t('balanceError'), cls: css.balanceStateError as string, title: entry.error }
          : { text: t('balanceError'), cls: css.balanceStateError as string }
      }
      case 'ok': {
        if (entry.isAvailable) {
          return entry.total < 5
            ? { text: `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`, cls: css.balanceValueLow as string }
            : { text: `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`, cls: css.balanceValueOk as string }
        }
        return {
          text: `${currencySymbol(entry.currency)}${entry.total.toFixed(2)}`,
          cls: css.balanceValueError as string,
          title: t('balanceUnavailable'),
        }
      }
    }
  }

  const lastLabel = lastFetchedAt > 0
    ? t('balanceLastUpdated').replace('{v}', formatBalanceTime(lastFetchedAt))
    : ''

  /**
   * Flip quota/balance every 3s while any supported row is hovered. If nothing
   * is hovered (or the hovered row's provider has no balance data) we reset the
   * toggle so quota shows first next time.
   */
  useEffect(() => {
    if (hoveredRowKey === null) { setMetaToggle(0); return }
    // Decide whether the hovered row's provider is eligible for balance display.
    const [prov] = hoveredRowKey.split('/', 1)
    const bal = balances.find(b => b.provider === prov)
    if (bal === undefined || bal.status !== 'ok') { setMetaToggle(0); return }
    // Show the balance immediately on hover, then flip every 3s.
    setMetaToggle(1)
    const id = window.setInterval(() => { setMetaToggle(v => (v + 1) % 2) }, 3000)
    return () => { window.clearInterval(id) }
  }, [hoveredRowKey, balances])

  /** On row hover, if the provider balance is stale (>5min since last ok fetch), kick off a single-provider refresh (throttled to 1/min). */
  const triggerRowBalanceRefreshIfStale = (provider: string): void => {
    const bal = balances.find(b => b.provider === provider)
    if (bal === undefined || bal.status !== 'ok') return
    const age = Date.now() - bal.fetchedAt
    if (age < 5 * 60_000) return
    const last = lastRowStaleRefreshRef.current[provider] ?? 0
    if (Date.now() - last < 60_000) return
    lastRowStaleRefreshRef.current[provider] = Date.now()
    setRefreshingProvider(provider)
    refreshBalance(provider)
    window.setTimeout(() => { setRefreshingProvider(prev => prev === provider ? null : prev) }, 1500)
  }

  /** Quota text shown on the right of each model row (used/lot or used · unlimited). */
  const quotaText = (row: ModelQuotaRow): string => row.limit > 0
    ? `${formatTokens(row.used)} / ${formatTokens(row.limit)}`
    : `${formatTokens(row.used)} · ${t('unlimited')}`

  /** Balance text shown when hovering a supported-provider row, or '' when unavailable. */
  const balanceTextForRow = (row: ModelQuotaRow): { text: string; cls?: string } => {
    const bal = balances.find(b => b.provider === row.provider)
    if (bal === undefined) return { text: '' }
    if (bal.status === 'ok' && bal.isAvailable) {
      if (bal.total < 5) {
        return { text: `${currencySymbol(bal.currency)}${bal.total.toFixed(2)}`, cls: css.balanceValueLow as string }
      }
      return { text: `${currencySymbol(bal.currency)}${bal.total.toFixed(2)}`, cls: css.balanceValueOk as string }
    }
    return { text: '' }
  }

  // The panel dims when the pointer is away ONLY when the user opted in
  // (settings → 失焦窗口透明). While the upgrade banner flashes, the panel
  // is forced opaque regardless.
  const panelDimClass = dimWhenIdle
    ? (hovered || upgradeFlash ? '' : inputActive ? css.panelDimStrong : css.panelDim)
    : ''

  return (
    <>
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
        </div>
        <div className={css.headerActions} onPointerDown={(event) => { event.stopPropagation() }}>
          <button
            type="button"
            aria-pressed={musicEnabled}
            className={`${css.settingsBtn}${musicEnabled ? ` ${css.settingsBtnActive}` : ''}`}
            title={`${t('musicLabel')}：${musicEnabled ? t('musicOn') : t('musicOff')}`}
            onClick={() => { setMusicEnabled(!musicEnabled) }}
          >
            ♪
          </button>
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
        <div className={css.notesBar} onPointerDown={(event) => { event.stopPropagation() }}>
          {notes.map((note) => {
            const open = note.visible && !note.collapsed
            return (
              <button
                key={note.id}
                type="button"
                className={`${css.noteChip}${open ? ` ${css.noteChipOpen}` : ''}`}
                title={note.title.trim() === '' ? t('noteUntitled') : note.title}
                onClick={() => { patchNote(note.id, { visible: true, collapsed: false }) }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setNoteMenu({ id: note.id, x: event.clientX, y: event.clientY })
                }}
              >
                {noteInitial(note.title)}
              </button>
            )
          })}
          <button
            type="button"
            className={css.noteNew}
            disabled={notes.length >= TOKEN_QUOTA_MAX_NOTES}
            title={notes.length >= TOKEN_QUOTA_MAX_NOTES ? t('noteMaxHint') : t('noteNewHint')}
            onClick={createNote}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M4 1.6h4.6L12.4 5.4v9H4z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path d="M8.4 1.6v3.9h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className={css.noteNewPlus}>+</span>
          </button>
          {balanceEnabled && (
                <button
                  type="button"
                  className={`${css.noteNew} ${css.balanceToggle}${balanceOpen ? ` ${css.balanceToggleOpen}` : ''}`}
                  title={t('balanceTitle')}
                  onClick={() => {
                    if (balanceOpen) { setBalanceOpen(false); return }
                    const winW = 280
                    const rect = panelRef.current?.getBoundingClientRect()
                    if (rect !== undefined) {
                      setBalancePos({
                        x: Math.max(8, rect.left - winW - 8),
                        y: rect.top,
                      })
                    } else {
                      setBalancePos({ x: Math.max(8, (typeof window !== 'undefined' ? window.innerWidth : 800) - 12 - 320 - winW - 8), y: 56 })
                    }
                    setBalanceOpen(true)
                  }}
                  aria-pressed={balanceOpen}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
                    <text x="8" y="11" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">¥</text>
                  </svg>
                </button>
              )}
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
            <div
              key={row.key}
              className={`${css.row}${dragKey === row.key ? ` ${css.rowDragging}` : ''}${dropKey === row.key && dragKey !== row.key ? ` ${css.rowDropTarget}` : ''}`}
              onMouseEnter={() => {
                setHoveredRowKey(row.key)
                triggerRowBalanceRefreshIfStale(row.provider)
              }}
              onMouseLeave={() => {
                setHoveredRowKey(prev => prev === row.key ? null : prev)
              }}
              onDragOver={(event) => {
                if (dragKey === null || dragKey === row.key) return
                event.preventDefault()
                setDropKey(row.key)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragKey !== null && dragKey !== row.key) {
                  setModelOrder(reorderKeys(rows.map(r => r.key), dragKey, row.key))
                }
                setDragKey(null)
                setDropKey(null)
              }}
              onDragEnd={() => { setDragKey(null); setDropKey(null) }}
            >
              <div className={css.rowHeader}>
                <span
                  className={css.rowDrag}
                  draggable
                  title={t('reorderHint')}
                  onDragStart={(event) => {
                    setDragKey(row.key)
                    event.dataTransfer.effectAllowed = 'move'
                    // Firefox only starts a drag when some data is set.
                    event.dataTransfer.setData('text/plain', row.key)
                  }}
                >
                  ⠿
                </span>
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
                  {(() => {
                    const bt = balanceTextForRow(row)
                    const showBalance = hoveredRowKey === row.key && bt.text !== '' && metaToggle === 1
                    return showBalance
                      ? <span className={bt.cls}>{bt.text}</span>
                      : <>{quotaText(row)}</>
                  })()}
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
    </div>
      {dialogOpen && (
        <div
          ref={settingsRef}
          className={`${css.dialog} ${css.settingsDialog}`}
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
          <div className={css.dialogTabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={settingsTab === 'quota'}
              className={`${css.dialogTab}${settingsTab === 'quota' ? ` ${css.dialogTabActive}` : ''}`}
              onClick={() => { setSettingsTab('quota') }}
            >
              {t('settingsTabQuota')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsTab === 'music'}
              className={`${css.dialogTab}${settingsTab === 'music' ? ` ${css.dialogTabActive}` : ''}`}
              onClick={() => { setSettingsTab('music') }}
            >
              {t('settingsTabMusic')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={settingsTab === 'other'}
              className={`${css.dialogTab}${settingsTab === 'other' ? ` ${css.dialogTabActive}` : ''}`}
              onClick={() => { setSettingsTab('other') }}
            >
              {t('settingsTabOther')}
            </button>
          </div>
          {settingsTab === 'quota' && (
            <>
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
            </>
            )}
            {settingsTab === 'other' && (
            <>
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
            </>
            )}
            {settingsTab === 'music' && (
            <>
            <div className={css.dialogSection}>
              <label className={css.checkUpdatesLabel}>
                <input
                  type="checkbox"
                  checked={musicEnabled}
                  onChange={(event) => { setMusicEnabled(event.target.checked) }}
                />
                <span>{t('musicLabel')}</span>
              </label>
              <div className={css.dialogHint}>{t('musicHint')}</div>
            </div>
            {musicEnabled && (
            <div className={css.dialogSection}>
                  <label className={css.checkUpdatesLabel}>
                    <span>{t('musicVolume')}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={musicVolume}
                      onChange={(event) => { setMusicVolume(Number(event.target.value)) }}
                    />
                  </label>
                  <label className={css.checkUpdatesLabel}>
                    <span>{t('musicStyle')}</span>
                    <select
                      value={musicStyle}
                      onChange={(event) => { setMusicStyle(event.target.value as TokenQuotaMusicStyle) }}
                    >
                      <option value="major">{t('musicStyleMajor')}</option>
                      <option value="minor">{t('musicStyleMinor')}</option>
                      <option value="pentatonic">{t('musicStylePentatonic')}</option>
                    </select>
                  </label>
                  <label className={css.checkUpdatesLabel}>
                    <input
                      type="checkbox"
                      checked={musicOnlyCurrentSession}
                      onChange={(event) => { setMusicOnlyCurrentSession(event.target.checked) }}
                    />
                    <span>{t('musicOnlyCurrentSessionLabel')}</span>
                  </label>
                  <div className={css.dialogHint}>{t('musicOnlyCurrentSessionHint')}</div>
            </div>
            )}
            </>
            )}
            {settingsTab === 'other' && (
            <>
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
            <div className={css.dialogSection}>
              <div className={css.dialogLabel}>{t('balanceSectionLabel')}</div>
              <label className={css.checkUpdatesLabel}>
                <input
                  type="checkbox"
                  checked={balanceEnabled}
                  onChange={(event) => { setBalanceSettings(event.target.checked, balancePollMinutes) }}
                />
                <span>{t('balanceEnabledLabel')}</span>
              </label>
              <div className={css.dialogHint}>{t('balanceHint').replace('{v}', String(balancePollMinutes))}</div>
              {balanceEnabled && (
                <label className={css.checkUpdatesLabel}>
                  <span>{t('balancePollLabel')}</span>
                  <select
                    value={balancePollMinutes}
                    onChange={(event) => { setBalanceSettings(balanceEnabled, Number(event.target.value)) }}
                  >
                    {[1, 5, 15, 30, 60].map(minutes => (
                      <option key={minutes} value={minutes}>
                        {t('balancePollMinutes').replace('{v}', String(minutes))}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            </>
            )}
          </div>
      )}
      {balanceOpen && balancePos !== null && (
        <div className={css.balanceWin} style={{ left: balancePos.x, top: balancePos.y }}>
          <div className={css.balanceWinHeader}>
            <div className={css.balanceWinTitle}>{t('balanceTitle')}</div>
            <button
              type="button"
              className={css.dialogClose}
              title={t('close')}
              onClick={() => { setBalanceOpen(false) }}
            >
              ×
            </button>
          </div>
          <div className={css.balanceWinBody}>
            <div className={css.balanceRowHeader}>
              <button
                type="button"
                className={css.balanceSortBtn}
                onClick={() => {
                  setBalanceSort(prev => {
                    if (prev === null || prev.key !== 'provider') return { key: 'provider', dir: 1 }
                    if (prev.dir === 1) return { key: 'provider', dir: -1 }
                    return null
                  })
                }}
              >
                {t('balanceColProvider')}
                {balanceSort?.key === 'provider' ? (balanceSort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </button>
              <button
                type="button"
                className={css.balanceSortBtn}
                onClick={() => {
                  setBalanceSort(prev => {
                    if (prev === null || prev.key !== 'total') return { key: 'total', dir: -1 }
                    if (prev.dir === -1) return { key: 'total', dir: 1 }
                    return null
                  })
                }}
              >
                {t('balanceColBalance')}
                {balanceSort?.key === 'total' ? (balanceSort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </button>
              <button
                type="button"
                className={css.balanceRefreshAll}
                title={t('balanceRefreshAll')}
                disabled={refreshingAll}
                onClick={() => {
                  setRefreshingAll(true)
                  refreshBalance()
                  window.setTimeout(() => { setRefreshingAll(false) }, 1500)
                }}
              >
                {refreshingAll ? '…' : '↻'}
              </button>
            </div>
            {sortedProviders.map(provider => {
              const cell = renderProviderCell(provider)
              const busy = refreshingProvider === provider
                || (balanceByProvider.get(provider) === 'loading')
              return (
                <div key={provider} className={css.balanceRow}>
                  <span className={css.balanceRowName} title={provider}>{provider}</span>
                  <span
                    className={`${css.balanceRowValue}${cell.cls !== undefined ? ` ${cell.cls}` : ''}`}
                    title={cell.title}
                  >
                    {cell.text}
                  </span>
                  <button
                    type="button"
                    className={css.balanceRowRefresh}
                    title={t('balanceRefreshOne')}
                    disabled={busy || refreshingAll || cell.text === t('balanceUnsupported')}
                    onClick={() => {
                      setRefreshingProvider(provider)
                      refreshBalance(provider)
                      window.setTimeout(() => { setRefreshingProvider(null) }, 1500)
                    }}
                  >
                    {busy ? '…' : '↻'}
                  </button>
                </div>
              )
            })}
            {lastLabel !== '' && (
              <div className={css.balanceLastLine}>{lastLabel}</div>
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
      {notes.filter(note => note.visible).map((note) => (
        <div
          key={note.id}
          className={`${css.noteWin}${note.collapsed ? ` ${css.noteWinCollapsed}` : ''}`}
          style={{
            left: `${note.x}px`,
            top: `${note.y}px`,
            width: `${note.width}px`,
            zIndex: activeNote === note.id ? 62 : 60,
            ...(note.collapsed ? {} : { height: `${note.height}px` }),
          }}
          onPointerDown={() => { setActiveNote(note.id) }}
        >
          <div
            className={css.noteWinBar}
            onPointerDown={(event) => { beginNoteBarDrag(event, note.id) }}
            onDoubleClick={(event) => {
              // Toggle: collapsed strips expand, open windows fold away. The
              // title input (word selection) and the bar buttons handle their
              // own double-clicks, so they are left alone.
              if ((event.target as HTMLElement).closest('button, input') !== null) return
              patchNote(note.id, { collapsed: !note.collapsed })
            }}
          >
            <span className={css.noteWinGripBar} aria-hidden="true">⠿</span>
            {editingTitle === note.id
              ? (
                <>
                  <input
                    className={css.noteWinTitle}
                    value={titleDraft}
                    autoFocus
                    placeholder={t('noteUntitled')}
                    onChange={(event) => { setTitleDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitTitle(note.id)
                      if (event.key === 'Escape') setEditingTitle(null)
                    }}
                  />
                  <button
                    type="button"
                    className={css.noteWinBtn}
                    title={t('noteConfirmTitle')}
                    onClick={() => { commitTitle(note.id) }}
                  >
                    ✓
                  </button>
                </>
              )
              : (
                <>
                  <span
                    className={css.noteWinTitleText}
                    title={note.title.trim() === '' ? t('noteUntitled') : note.title}
                  >
                    {note.title.trim() === '' ? t('noteUntitled') : note.title}
                  </span>
                  <button
                    type="button"
                    className={css.noteWinBtn}
                    title={t('noteEditTitle')}
                    onClick={() => { setEditingTitle(note.id); setTitleDraft(note.title) }}
                  >
                    ✎
                  </button>
                </>
              )}
            <button
              type="button"
              className={css.noteWinBtn}
              title={note.collapsed ? t('noteExpand') : t('noteCollapse')}
              onClick={() => { patchNote(note.id, { collapsed: !note.collapsed }) }}
            >
              {note.collapsed ? '▸' : '▾'}
            </button>
            <button
              type="button"
              className={css.noteWinBtn}
              title={t('noteClose')}
              onClick={() => { closeNote(note.id) }}
            >
              ×
            </button>
          </div>
          {!note.collapsed && (
            <>
              <textarea
                className={css.noteWinText}
                value={note.text}
                placeholder={t('notePlaceholder')}
                spellCheck={false}
                onChange={(event) => { patchNote(note.id, { text: event.target.value }, false) }}
              />
              <span
                className={css.noteWinResize}
                title={t('noteResizeHint')}
                onPointerDown={(event) => {
                  beginResize(event, event.currentTarget.parentElement, size => { patchNote(note.id, size, false) })
                }}
              />
            </>
          )}
        </div>
      ))}
      {noteMenu !== null && (
        <>
          <div
            className={css.noteMenuBackdrop}
            onPointerDown={() => { setNoteMenu(null) }}
            onContextMenu={(event) => { event.preventDefault(); setNoteMenu(null) }}
          />
          <div className={css.noteMenu} style={{ left: `${noteMenu.x}px`, top: `${noteMenu.y}px` }}>
            <button
              type="button"
              className={css.noteMenuItem}
              onClick={() => { closeNote(noteMenu.id); setNoteMenu(null) }}
            >
              {t('noteClose')}
            </button>
            <button
              type="button"
              className={css.noteMenuItem}
              onClick={() => { removeNote(noteMenu.id) }}
            >
              {t('noteDelete')}
            </button>
          </div>
        </>
      )}
    </>
  )
}