/**
 * Composer mic button: registered into `conversation.input.overlay` so it sits
 * inside the chat composer card (top-right corner). A press starts recording
 * from the microphone; a second press stops it and sends the audio blob to the
 * Host, which forwards it to the configured OpenAI-compatible transcription
 * endpoint. The returned text is appended to the composer. The button only
 * renders while transcription is enabled in the token-quota settings.
 *
 * This entry is mounted in a session-scoped slot, so it cannot share the
 * panel's root-scoped store handle (which would fork a per-session instance
 * with stale state). Instead it subscribes to a tiny transcribe-only
 * observable passed through injection and reads the locale-bound `t` from
 * injection as well.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TokenQuotaTranscribeSettings } from '@jxgame2020/dsh-token-quota/types'
import css from './mic.module.css'

/** Injected business face: transcription send + settings subscription. */
export interface TokenQuotaMicInjected {
  /** Send a recorded audio blob to the Host for transcription. */
  transcribe: (blob: Blob) => Promise<string>
  /** Persist the transcription settings (the panel owns the settings UI). */
  setTranscribeSettings: (settings: TokenQuotaTranscribeSettings) => void
  /** Subscribe to transcribe settings changes (returns an unsubscribe). */
  subscribeTranscribe: (cb: () => void) => () => void
  /** Read the current transcribe settings snapshot. */
  getTranscribe: () => TokenQuotaTranscribeSettings
  /** Locale-bound translate function. */
  t: (key: string) => string
}

/** Full mic component props: runtime + injected face (no store/locale shares). */
export type TokenQuotaMicComponentProps =
  PropsRuntime<'conversation.input.overlay'>
  & TokenQuotaMicInjected

/**
 * Append recognised text to the contentEditable composer. Focuses the editor,
 * moves the caret to the end, and uses `insertText` so the host editor's own
 * input handling (undo, lexical binding) sees it as a typed insertion.
 */
function appendToComposer(text: string): void {
  const editor = document.querySelector<HTMLElement>('[data-composer-input]')
  if (editor === null) {
    void navigator.clipboard?.writeText(text).catch(() => {})
    return
  }
  editor.focus()
  const selection = window.getSelection()
  if (selection !== null) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch {
    // Some engines throw on execCommand; fall through to the manual path.
  }
  if (!inserted) {
    editor.appendChild(document.createTextNode(text))
  }
}

/**
 * Mic button rendered inside the composer card. Manages its own MediaRecorder
 * lifecycle; only the button is shown — no floating panel UI.
 */
export function TokenQuotaMic({
  t, transcribe, subscribeTranscribe, getTranscribe,
}: TokenQuotaMicComponentProps): JSX.Element | null {
  const settings = useSyncExternalStore(subscribeTranscribe, getTranscribe, getTranscribe)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current)
      cleanupRecording()
    }
  }, [])

  const cleanupRecording = (): void => {
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    mediaRecorderRef.current = null
    chunksRef.current = []
  }

  const showError = (message: string): void => {
    setError(message)
    if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => {
      setError(null)
      errorTimerRef.current = undefined
    }, 4000)
  }

  const startRecording = async (): Promise<void> => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      showError(t('transcribeMicDenied'))
      return
    }
    streamRef.current = stream
    chunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''
    const recorder = mimeType !== ''
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)
    mediaRecorderRef.current = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      const type = mimeType !== '' ? mimeType : 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      cleanupRecording()
      if (blob.size === 0) {
        showError(t('transcribeEmpty'))
        return
      }
      setTranscribing(true)
      void transcribe(blob).then(
        (text) => {
          setTranscribing(false)
          if (text.trim() !== '') appendToComposer(text)
        },
        (err) => {
          setTranscribing(false)
          showError(err instanceof Error ? err.message : String(err))
        },
      )
    }
    recorder.start()
    setRecording(true)
  }

  const stopAndTranscribe = (): void => {
    const recorder = mediaRecorderRef.current
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.stop()
    } else {
      cleanupRecording()
    }
    setRecording(false)
  }

  const onToggle = (): void => {
    if (transcribing) return
    if (recording) {
      stopAndTranscribe()
    } else {
      void startRecording()
    }
  }

  if (!settings.enabled) return null

  const state = transcribing ? 'busy' : recording ? 'rec' : 'idle'
  return (
    <div className={css.micWrap} title={error ?? t('transcribeHint')}>
      <button
        type="button"
        className={`${css.micBtn}${state === 'rec' ? ` ${css.micRec}` : ''}${state === 'busy' ? ` ${css.micBusy}` : ''}${error !== null ? ` ${css.micErr}` : ''}`}
        disabled={transcribing}
        onClick={(event) => { event.stopPropagation(); onToggle() }}
        onPointerDown={(event) => { event.stopPropagation() }}
        aria-pressed={recording}
        aria-label={error ?? t('transcribeTitle')}
      >
        {transcribing ? '…' : '🎤'}
      </button>
      {error !== null && <span className={css.micErrTip}>{error}</span>}
    </div>
  )
}
