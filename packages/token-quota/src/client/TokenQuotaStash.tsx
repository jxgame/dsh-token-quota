/**
 * Session-scoped stash UI, registered into `conversation.input.overlay` so it
 * sits inside the composer card beside the mic.
 *
 * Capture (two ways, as requested):
 *   1. select text — in a message OR in the composer draft — and use the small
 *      popup that offers 复制 / 临存;
 *   2. press Cmd/Ctrl+Shift+S on any selection.
 *
 * Retrieval: one numbered chip per snippet to the left of the mic. Hovering a
 * chip shows the whole text; clicking drops it into the composer at the caret
 * and retires the chip.
 *
 * The snippets themselves live in a per-session persisted store (see stash.ts),
 * so they follow their session across reloads and never reach another session.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the 'conversation.input.overlay' SlotMap declaration in.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TOKEN_QUOTA_NAMESPACE } from '@jxgame2020/dsh-token-quota/types'
import type { createTokenQuotaStashStore } from './stash.ts'
import css from './TokenQuotaStash.module.css'

/** Full component props: runtime + per-session stash store + locale. */
export type TokenQuotaStashComponentProps =
  PropsRuntime<'conversation.input.overlay'>
  & PropsStore<ReturnType<typeof createTokenQuotaStashStore>>
  & PropsLocale<typeof TOKEN_QUOTA_NAMESPACE>

/** The harness composer's editable surface. */
const COMPOSER_INPUT = '[data-composer-input]'
/** Anything matching this is "not capturable text": this plugin's own layers
    and form fields — selecting text inside an input is editing, not quoting.
    The composer is deliberately NOT excluded: stashing part of a draft is a
    supported flow. */
const IGNORED_SELECTION = '[data-token-quota-stash], [data-token-quota-panel], input, textarea, select'

/** The composer's contentEditable, when the composer is on screen. */
function composerEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COMPOSER_INPUT)
}

/** Copy text, falling back to a hidden textarea when the clipboard API is denied. */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    const scratch = document.createElement('textarea')
    scratch.value = text
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    try { document.execCommand('copy') } catch { /* give up quietly */ }
    document.body.removeChild(scratch)
  })
}

/**
 * Drop text into the composer at the caret the user last had there. Falls back
 * to the end of the editor when no caret was recorded, and to the clipboard
 * when the composer is not on screen at all.
 */
function insertIntoComposer(text: string, caret: Range | null): void {
  const editor = composerEditor()
  if (editor === null) {
    copyText(text)
    return
  }
  editor.focus()
  const selection = window.getSelection()
  if (selection !== null) {
    const restore = caret !== null && editor.contains(caret.startContainer)
    if (restore) {
      selection.removeAllRanges()
      selection.addRange(caret as Range)
    } else if (!editor.contains(selection.anchorNode)) {
      // No usable caret: land at the end so the insertion is always visible.
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch {
    // Some engines throw on execCommand; fall through to the manual path.
  }
  if (!inserted) editor.appendChild(document.createTextNode(text))
}

/**
 * Remove the live selection when it sits inside the composer: stashing part of
 * a draft means MOVING it out of the way ("cut"), so the user does not have to
 * delete it by hand and cannot accidentally send it. Selections anywhere else
 * (a message) are left untouched.
 */
function cutComposerSelection(): void {
  const editor = composerEditor()
  const selection = window.getSelection()
  if (editor === null || selection === null || selection.rangeCount === 0) return
  const anchor = selection.anchorNode
  if (anchor === null || !editor.contains(anchor) || selection.isCollapsed) return
  // execCommand keeps the contentEditable's own undo stack intact, so Cmd+Z
  // restores the cut text.
  try {
    document.execCommand('delete')
  } catch {
    // Some engines throw on execCommand; fall through to the range API.
  }
  // Verify rather than trust the return value: a successful delete collapses
  // the selection, and some editors report success without applying anything.
  const after = window.getSelection()
  if (after !== null && after.isCollapsed) return
  for (let index = selection.rangeCount - 1; index >= 0; index -= 1) {
    selection.getRangeAt(index).deleteContents()
  }
}

/** Keycap emoji for the chip badges; index 0 renders as 1️⃣. */
const STASH_BADGES = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'] as const

/** The badge for the n-th (0-based) chip, falling back to a plain digit. */
function stashBadge(index: number): string {
  return STASH_BADGES[index] ?? String(index + 1)
}

/**
 * Numbered stash chips plus the capture popup, rendered inside the composer.
 */
export function TokenQuotaStash({ t, useStore, actions }: TokenQuotaStashComponentProps): JSX.Element {
  const items = useStore(s => s.items)
  const [hovered, setHovered] = useState<{ id: string; left: number; top: number } | null>(null)
  const [pending, setPending] = useState<{ text: string; x: number; y: number } | null>(null)
  // The caret the user last had in the composer, restored on insertion so a
  // snippet lands where they were typing rather than at the very end.
  const caretRef = useRef<Range | null>(null)
  const pendingRef = useRef<{ text: string } | null>(null)
  pendingRef.current = pending

  // Capture: watch the document selection for the popup, and remember the
  // composer caret while the user types.
  useEffect(() => {
    const sync = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0) {
        setPending(null)
        return
      }
      const editor = composerEditor()
      const anchor = selection.anchorNode
      if (editor !== null && anchor !== null && editor.contains(anchor)) {
        // Selecting inside the composer is a first-class capture source too
        // (write several thoughts, send one, stash the rest). Record the
        // insertion point on the way through — but only for a collapsed caret,
        // since a live selection would be replaced when a snippet lands.
        if (selection.isCollapsed) caretRef.current = selection.getRangeAt(0).cloneRange()
      }
      if (selection.isCollapsed) {
        setPending(null)
        return
      }
      const text = selection.toString().trim()
      if (text === '') {
        setPending(null)
        return
      }
      const range = selection.getRangeAt(0)
      const container = range.commonAncestorContainer
      const element = container.nodeType === Node.ELEMENT_NODE
        ? container as Element
        : container.parentElement
      if (element !== null && element.closest(IGNORED_SELECTION) !== null) {
        setPending(null)
        return
      }
      const rects = range.getClientRects()
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect()
      if (rect === undefined) {
        setPending(null)
        return
      }
      const half = 70
      // The composer sits at the bottom of the window, so a popup below the
      // selection would fall off-screen: flip it above when there is no room.
      const POPUP_HEIGHT = 34
      const below = rect.bottom + 6
      const y = below + POPUP_HEIGHT > window.innerHeight
        ? Math.max(8, rect.top - POPUP_HEIGHT - 6)
        : below
      setPending({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8),
        y,
      })
    }
    document.addEventListener('selectionchange', sync)
    return () => { document.removeEventListener('selectionchange', sync) }
  }, [])

  // Capture by keyboard: Cmd/Ctrl+Shift+S on any selection — a message or the
  // draft being written in the composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== 's') return
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) return
      const text = selection.toString().trim()
      if (text === '') return
      event.preventDefault()
      actions.add(text)
      // Stashing a composer draft moves the text out of the way.
      cutComposerSelection()
      setPending(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions])

  const stash = (): void => {
    const text = pendingRef.current?.text
    if (text === undefined) return
    actions.add(text)
    // In the composer this is a cut; in a message the text stays put.
    cutComposerSelection()
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  const hoveredItem = hovered === null ? undefined : items.find(item => item.id === hovered.id)

  return (
    <>
      {items.length > 0 && (
        <div className={css.stashRow} data-token-quota-stash="">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={css.stashChip}
              // Keeping focus (and the caret) in the composer is the whole point:
              // the snippet must land where the user was typing.
              onMouseDown={(event) => { event.preventDefault() }}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setHovered({ id: item.id, left: rect.left, top: rect.top })
              }}
              onMouseLeave={() => { setHovered(null) }}
              onClick={() => {
                insertIntoComposer(item.text, caretRef.current)
                actions.remove(item.id)
                setHovered(null)
              }}
              aria-label={t('stashChipHint').replace('{n}', String(index + 1))}
            >
              {stashBadge(index)}
            </button>
          ))}
        </div>
      )}

      {hovered !== null && hoveredItem !== undefined && (
        <div
          className={css.stashTip}
          data-token-quota-stash=""
          style={{
            left: Math.min(hovered.left, Math.max(8, window.innerWidth - 368)),
            bottom: window.innerHeight - hovered.top + 6,
          }}
        >
          {hoveredItem.text}
        </div>
      )}

      {pending !== null && (
        <div
          className={css.selPopup}
          data-token-quota-stash=""
          style={{ left: pending.x, top: pending.y }}
          // Keep the selection alive so the click can act on it.
          onMouseDown={(event) => { event.preventDefault() }}
        >
          <button
            type="button"
            className={css.selBtn}
            onClick={() => {
              copyText(pending.text)
              setPending(null)
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M10.4 5.6V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5A1.4 1.4 0 0 0 4 10.4h1.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            {t('stashCopy')}
          </button>
          <span className={css.selDivider} aria-hidden="true" />
          <button type="button" className={css.selBtn} onClick={stash}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M9.3 1.5 3.8 8.7h3.4l-.9 5.8 5.5-7.3H8.4z" fill="currentColor" />
            </svg>
            {t('stashSave')}
          </button>
        </div>
      )}
    </>
  )
}
