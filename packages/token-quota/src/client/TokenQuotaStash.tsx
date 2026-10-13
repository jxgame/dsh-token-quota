/**
 * Session-scoped stash UI, registered into `conversation.input.overlay` so it
 * sits inside the composer card beside the mic.
 *
 * Capture (two ways, as requested):
 *   1. select text in the conversation -> a small popup offers 复制 / 临存;
 *   2. select text anywhere -> press Cmd/Ctrl+Shift+S.
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
/** Anything matching this is "not conversation text" for capture purposes: the
    composer itself, this plugin's own layers, and form fields — selecting text
    inside an input is editing, not quoting. */
const IGNORED_SELECTION = '[data-composer-card], [data-token-quota-stash], [data-token-quota-panel], input, textarea, select'

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
        // Caret inside the composer: remember it, and never offer to stash the
        // draft the user is writing.
        caretRef.current = selection.getRangeAt(0).cloneRange()
        setPending(null)
        return
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
      setPending({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8),
        y: rect.bottom + 6,
      })
    }
    document.addEventListener('selectionchange', sync)
    return () => { document.removeEventListener('selectionchange', sync) }
  }, [])

  // Capture by keyboard: Cmd/Ctrl+Shift+S on any conversation selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== 's') return
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) return
      const anchor = selection.anchorNode
      const editor = composerEditor()
      if (editor !== null && anchor !== null && editor.contains(anchor)) return
      const text = selection.toString().trim()
      if (text === '') return
      event.preventDefault()
      actions.add(text)
      setPending(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions])

  const stash = (): void => {
    const text = pendingRef.current?.text
    if (text === undefined) return
    actions.add(text)
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
              {index + 1}
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
            {t('stashCopy')}
          </button>
          <span className={css.selDivider} aria-hidden="true" />
          <button type="button" className={css.selBtn} onClick={stash}>
            {t('stashSave')}
          </button>
        </div>
      )}
    </>
  )
}
