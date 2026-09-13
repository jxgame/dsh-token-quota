/**
 * 古风 live-composed soundtrack driven by host actions.
 *
 * Design: when a request starts the engine composes a *piece* — a guzheng-like
 * plucked-string voice over a soft open-fifth drone (Web Audio synthesis; the
 * MIDI output is switched to the Koto program so hardware synths match). The
 * piece plays phrase after phrase so it never goes quiet while the model
 * thinks or streams. Incoming events steer the piece instead of interrupting
 * it: a step change glides the drone to the next mode centre and inserts a
 * fast 过门 (fill); tool calls get a high plink; the ending gets a flute-like
 * breath note and a descending glissando.
 *
 * Anti-runaway guards (the "endless drone" / hanging-MIDI-note problem):
 *  - the host sends an SSE heartbeat every 5s; if it stops arriving the whole
 *    engine fades out (a dead stream means no stop event will ever come),
 *  - every MIDI NoteOn is registered and swept; `stopAll` also sends
 *    All Notes Off (CC 123),
 *  - Web Audio ramps never target zero exponentially and every oscillator is
 *    explicitly stopped.
 *
 * @module @jxgame2020/dsh-token-quota/music
 */

import type { TokenQuotaMusicAction, TokenQuotaMusicStyle } from '../types.ts'

/** Scale degrees in semitones from the (current) tonic. */
const SCALES: Record<TokenQuotaMusicStyle, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9], // 宫商角徵羽
}

/**
 * Tonic offsets for the progression — the piece rotates its mode centre on
 * every step advance. For pentatonic this is 宫 → 羽 → 徵 → 商 (mode
 * rotation on one scale), which is the classic gufeng colour.
 */
const PROGRESSION: Record<TokenQuotaMusicStyle, number[]> = {
  major: [0, 9, 5, 7],
  minor: [0, 8, 3, 10],
  pentatonic: [0, 9, 7, 5],
}

/** One melodic step: scale degree (+ octave), held for `beats` beats. */
type PhraseStep = { deg: number; beats: number; oct?: number }
type Phrase = PhraseStep[]

/**
 * Phrase bank — pentatonic-degree melodies that also read fine on 7-note
 * scales. Degrees index the current scale (values ≥ scale length wrap up an
 * octave).
 */
const PHRASES: Phrase[] = [
  [{ deg: 0, beats: 2 }, { deg: 1, beats: 1 }, { deg: 2, beats: 1 }, { deg: 3, beats: 2 }, { deg: 2, beats: 1 }, { deg: 1, beats: 1 }, { deg: 0, beats: 3 }],
  [{ deg: 5, beats: 1 }, { deg: 4, beats: 1 }, { deg: 3, beats: 2 }, { deg: 2, beats: 1 }, { deg: 1, beats: 2 }, { deg: 0, beats: 3 }],
  [{ deg: 2, beats: 1 }, { deg: 3, beats: 1 }, { deg: 4, beats: 2 }, { deg: 5, beats: 1 }, { deg: 4, beats: 1 }, { deg: 3, beats: 2 }, { deg: 1, beats: 2 }, { deg: 0, beats: 2 }],
  [{ deg: 4, beats: 2 }, { deg: 3, beats: 1 }, { deg: 2, beats: 1 }, { deg: 3, beats: 2 }, { deg: 1, beats: 1 }, { deg: 2, beats: 1 }, { deg: 0, beats: 4 }],
]

/** 过门 — a fast run played when a step (new phase) starts. */
const FILL: Phrase = [
  { deg: 0, beats: 0.5 }, { deg: 1, beats: 0.5 }, { deg: 2, beats: 0.5 }, { deg: 3, beats: 0.5 },
  { deg: 4, beats: 0.5 }, { deg: 5, beats: 0.5 }, { deg: 4, beats: 0.5 }, { deg: 3, beats: 0.5 },
]

/** Turn a MIDI note number into a frequency (equal temperament, A4 = 440). */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** General-MIDI program closest to a guzheng: 108 Koto (0-indexed 106). */
const GM_PROGRAM_KOTO = 106

/**
 * Live-composed gufeng engine. Idle until `ensureStarted()` runs inside a
 * user gesture; silent while `enabled` is false; the piece runs only between
 * `request/header` (start) and `assistant/message` / `turn/end` (stop).
 */
export class TokenQuotaMusic {
  private audio: AudioContext | null = null
  private midiOutput: MIDIOutput | null = null
  private midiDetected = false

  private enabled = false
  private volume = 0.5
  private style: TokenQuotaMusicStyle = 'pentatonic'

  // Composition state
  private playing = false
  private tonicIndex = 0
  private phraseIndex = 0
  private phraseTimer: ReturnType<typeof setTimeout> | undefined

  // Drone layer (sustained open fifth under the plucks)
  private droneOscs: OscillatorNode[] = []
  private droneGain: GainNode | null = null
  private droneFilter: BiquadFilterNode | null = null
  private droneActive = false

  // Watchdog: host heartbeat freshness (ms timestamp)
  private lastStreamActivity = 0
  private watchdogTimer: ReturnType<typeof setInterval> | undefined

  // MIDI note registry (anti hanging-note)
  private readonly activeMidiNotes = new Set<number>()

  /** Base MIDI note of the tonic. C4 = middle C. */
  private static readonly BASE_MIDI = 60

  /** Beat length in ms — the phrase rhythm is measured in these. */
  private static readonly BEAT_MS = 480

  /** Stop everything if the SSE stream goes silent this long. */
  private static readonly STREAM_TIMEOUT_MS = 12_000

  /** True once the audio context has been started (needs a user gesture). */
  get started(): boolean {
    return this.audio !== null
  }

  /**
   * Start the audio context and probe for a MIDI output (once). Must be
   * called inside a user gesture so the AudioContext can resume.
   */
  async ensureStarted(): Promise<boolean> {
    if (this.audio !== null) return true
    if (typeof window === 'undefined') return false
    try {
      this.audio = new AudioContext()
      await this.audio.resume()
    } catch {
      this.audio = null
      return false
    }
    // MIDI: probe once; switch the receiver to a plucked-string program so
    // the timbre matches the gufeng idea (receivers that ignore program
    // change just keep their own patch).
    if (!this.midiDetected && 'requestMIDIAccess' in navigator) {
      this.midiDetected = true
      try {
        const access = await (navigator as Navigator).requestMIDIAccess()
        for (const output of access.outputs.values()) {
          this.midiOutput = output
          break
        }
        try { this.midiOutput?.send([0xC0, GM_PROGRAM_KOTO]) } catch { /* optional */ }
      } catch {
        this.midiOutput = null
      }
    }
    // Stream watchdog runs for the whole engine lifetime; it only acts while
    // a piece is playing.
    if (this.watchdogTimer === undefined) {
      this.lastStreamActivity = Date.now()
      this.watchdogTimer = setInterval(() => {
        if (this.playing && Date.now() - this.lastStreamActivity > TokenQuotaMusic.STREAM_TIMEOUT_MS) {
          // Dead stream: no stop event will ever arrive — fade out.
          this.stopPiece(false)
        }
      }, 4_000)
    }
    return true
  }

  setEnabled(value: boolean): void {
    this.enabled = value
    if (!value) this.stopAll()
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
  }

  setStyle(value: TokenQuotaMusicStyle): void {
    this.style = value
  }

  /** Feed the engine one SSE activity timestamp (action or heartbeat). */
  markStreamActivity(): void {
    this.lastStreamActivity = Date.now()
  }

  /** Handle one incoming host action and steer the piece. */
  onAction(action: TokenQuotaMusicAction): void {
    if (!this.enabled || this.audio === null) return
    const base = TokenQuotaMusic.BASE_MIDI
    switch (action.type) {
      case 'turn/start':
        this.stopPiece(false)
        this.tonicIndex = 0
        this.phraseIndex = 0
        break
      case 'request/header': {
        if (!this.playing) this.startPiece()
        else this.pluck(base + 24, 0.3) // light accent on a subsequent request
        break
      }
      case 'step/start': {
        // New phase: rotate the tonic, glide the drone, insert a 过门 fill.
        const prog = PROGRESSION[this.style]
        this.tonicIndex = (this.tonicIndex + 1) % prog.length
        const newRoot = base + (prog[this.tonicIndex] ?? 0)
        this.glideDrone(newRoot)
        if (this.playing) this.insertFill(newRoot)
        break
      }
      case 'tool/call':
        // High plink + low tap — distinct from the plucked melody.
        this.pluck(base + 26, 0.45, 0.5)
        this.pluck(base - 12, 0.3, 0.35)
        break
      case 'tool/result': {
        if (action.error) {
          this.pluck(base + 13, 0.4, 0.6)
          setTimeout(() => this.pluck(base + 12, 0.4, 0.9), 90)
        } else {
          this.pluck(base + 9, 0.35, 0.6)
          setTimeout(() => this.pluck(base + 11, 0.35, 0.9), 70)
        }
        break
      }
      case 'assistant/attempt':
        // Failed attempt: falling tension figure.
        this.pluck(base + 8, 0.4, 0.8)
        setTimeout(() => this.pluck(base + 7, 0.4, 0.8), 110)
        setTimeout(() => this.pluck(base + 5, 0.4, 0.8), 220)
        break
      case 'assistant/message':
        // Phrase ends; the turn may continue (more steps) — keep the drone
        // breathing but stop the melody, ending with a breath note.
        this.stopMelody()
        this.breath(action.interrupted ? base + 6 : base + 12, 1.6)
        break
      case 'turn/end':
        this.stopPiece(true)
        break
    }
  }

  // ── piece lifecycle ───────────────────────────────────────────────────

  /** Start a new piece: drone + ascending glissando + phrase chain. */
  private startPiece(): void {
    if (!this.audio || this.playing) return
    this.playing = true
    this.tonicIndex = 0
    this.phraseIndex = 0
    const root = TokenQuotaMusic.BASE_MIDI + (PROGRESSION[this.style][0] ?? 0)
    this.startDrone(root)
    // Intro glissando — the guzheng sweep that announces the piece.
    const scale = SCALES[this.style]
    let t = 0
    for (let i = 0; i < 8; i++) {
      const deg = i % scale.length
      const oct = Math.floor(i / scale.length)
      const note = root + 12 * oct + (scale[deg] ?? 0)
      setTimeout(() => this.pluck(note, 0.3), t)
      t += 150
    }
    // First phrase starts right after the glissando.
    this.phraseTimer = setTimeout(() => this.playPhrase(), t + 100)
  }

  /** Play one phrase, then chain into the next after a one-beat rest. */
  private playPhrase(): void {
    if (!this.playing || !this.audio) return
    const root = TokenQuotaMusic.BASE_MIDI + (PROGRESSION[this.style][this.tonicIndex] ?? 0)
    const scale = SCALES[this.style]
    const phrase = PHRASES[this.phraseIndex % PHRASES.length]!
    this.phraseIndex += 1
    let t = 0
    for (const step of phrase) {
      const note = root + (scale[step.deg % scale.length] ?? 0) + 12 * Math.floor(step.deg / scale.length)
      const delay = t
      setTimeout(() => {
        if (this.playing) this.pluck(note, 0.34)
      }, delay)
      t += step.beats * TokenQuotaMusic.BEAT_MS
    }
    this.phraseTimer = setTimeout(() => this.playPhrase(), t + TokenQuotaMusic.BEAT_MS)
  }

  /** Insert a 过门 fill: pause the chain, play the run, resume after. */
  private insertFill(root: number): void {
    if (!this.audio) return
    this.stopMelody()
    const scale = SCALES[this.style]
    let t = 0
    for (const step of FILL) {
      const note = root + (scale[step.deg % scale.length] ?? 0) + 12 * Math.floor(step.deg / scale.length)
      const delay = t
      setTimeout(() => {
        if (this.playing) this.pluck(note, 0.32, 0.7)
      }, delay)
      t += step.beats * TokenQuotaMusic.BEAT_MS
    }
    this.phraseTimer = setTimeout(() => this.playPhrase(), t + 60)
  }

  /** Stop the melody chain (drone keeps fading naturally). */
  private stopMelody(): void {
    if (this.phraseTimer !== undefined) {
      clearTimeout(this.phraseTimer)
      this.phraseTimer = undefined
    }
  }

  /** Stop the whole piece; `final` adds the closing cadence gestures. */
  private stopPiece(final: boolean): void {
    this.stopMelody()
    this.playing = false
    if (final && this.audio) {
      const base = TokenQuotaMusic.BASE_MIDI
      // Descending pentatonic glissando + tonic open-fifth pluck chord.
      const scale = SCALES[this.style]
      let t = 0
      for (let i = 7; i >= 0; i--) {
        const deg = i % scale.length
        const oct = Math.floor(i / scale.length)
        const note = base + 12 * oct + (scale[deg] ?? 0)
        setTimeout(() => this.pluck(note, 0.3), t)
        t += 120
      }
      setTimeout(() => {
        this.pluck(base, 0.5)
        this.pluck(base + 7, 0.45)
        this.pluck(base + 12, 0.4)
        this.pluck(base - 12, 0.5)
      }, t + 150)
    }
    this.fadeDrone(final ? 1.2 : 0.8)
    this.allMidiOff()
  }

  /** Hard stop everything (master switch off / teardown). */
  private stopAll(): void {
    this.stopPiece(false)
  }

  // ── drone layer ───────────────────────────────────────────────────────

  /** Start the sustained open fifth (root + fifth below octave root). */
  private startDrone(root: number): void {
    if (!this.audio || this.droneActive) return
    const now = this.audio.currentTime
    const gain = this.audio.createGain()
    gain.gain.setValueAtTime(0, now)
    const filter = this.audio.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 620
    filter.Q.value = 0.4
    gain.connect(filter)
    filter.connect(this.audio.destination)
    const oscs: OscillatorNode[] = []
    for (const interval of [-12, -5]) {
      const osc = this.audio.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = midiToFreq(root + interval)
      osc.connect(gain)
      osc.start(now)
      oscs.push(osc)
    }
    this.droneOscs = oscs
    this.droneGain = gain
    this.droneFilter = filter
    this.droneActive = true
    gain.gain.linearRampToValueAtTime(this.volume * 0.07, now + 1.4)
  }

  /** Glide the drone to a new tonic (mode rotation). */
  private glideDrone(root: number): void {
    if (!this.audio || !this.droneActive) return
    const now = this.audio.currentTime
    const targets = [root - 12, root - 5]
    this.droneOscs.forEach((osc, i) => {
      const target = targets[i] ?? root
      osc.frequency.setValueAtTime(osc.frequency.value, now)
      osc.frequency.exponentialRampToValueAtTime(midiToFreq(target), now + 0.9)
    })
  }

  /** Fade the drone out and stop its oscillators. */
  private fadeDrone(seconds: number): void {
    if (!this.audio || !this.droneActive || this.droneGain === null) return
    const now = this.audio.currentTime
    const gain = this.droneGain
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds)
    const oscs = this.droneOscs
    const filter = this.droneFilter
    setTimeout(() => {
      for (const osc of oscs) {
        try { osc.stop() } catch { /* ignore */ }
        try { osc.disconnect() } catch { /* ignore */ }
      }
      try { filter?.disconnect() } catch { /* ignore */ }
      try { gain.disconnect() } catch { /* ignore */ }
    }, seconds * 1000 + 120)
    this.droneActive = false
    this.droneOscs = []
    this.droneGain = null
    this.droneFilter = null
  }

  // ── voices ────────────────────────────────────────────────────────────

  /**
   * Guzheng-like pluck: two slightly detuned oscillators through a sweeping
   * lowpass, fast attack and a long exponential decay (notes overlap, which
   * keeps the piece continuous instead of choppy).
   */
  private pluck(midi: number, velocity: number, decaySec = 1.3): void {
    if (!this.audio) return
    const peak = this.volume * velocity * 0.4
    if (peak <= 0) return
    const now = this.audio.currentTime
    const freq = midiToFreq(midi)
    const gain = this.audio.createGain()
    const filter = this.audio.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2400, now)
    filter.frequency.exponentialRampToValueAtTime(420, now + decaySec)
    filter.Q.value = 0.6
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decaySec)
    filter.connect(gain)
    gain.connect(this.audio.destination)
    const osc1 = this.audio.createOscillator()
    osc1.type = 'triangle'
    osc1.frequency.value = freq
    const osc2 = this.audio.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.value = freq * 2.001 // shimmering octave partial
    const octGain = this.audio.createGain()
    octGain.gain.value = 0.35
    osc1.connect(filter)
    osc2.connect(octGain)
    octGain.connect(filter)
    osc1.start(now)
    osc1.stop(now + decaySec + 0.1)
    osc2.start(now)
    osc2.stop(now + decaySec + 0.1)
    this.midiNote(midi, decaySec, velocity)
  }

  /** Dizi-like breath note: sine with vibrato and a soft envelope. */
  private breath(midi: number, durationSec: number): void {
    if (!this.audio) return
    const peak = this.volume * 0.22
    if (peak <= 0) return
    const now = this.audio.currentTime
    const osc = this.audio.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = midiToFreq(midi)
    const lfo = this.audio.createOscillator()
    lfo.frequency.value = 5.2
    const lfoGain = this.audio.createGain()
    lfoGain.gain.value = 4.5 // Hz of vibrato depth
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)
    const gain = this.audio.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(peak, now + 0.18)
    gain.gain.setValueAtTime(peak, now + durationSec * 0.6)
    gain.gain.linearRampToValueAtTime(0.0001, now + durationSec)
    osc.connect(gain)
    gain.connect(this.audio.destination)
    osc.start(now)
    lfo.start(now)
    osc.stop(now + durationSec + 0.1)
    lfo.stop(now + durationSec + 0.1)
    this.midiNote(midi, durationSec, 0.5)
  }

  // ── MIDI plumbing ─────────────────────────────────────────────────────

  /** Send one MIDI note with a registered NoteOff (anti hanging note). */
  private midiNote(midi: number, durationSec: number, velocity: number): void {
    if (this.midiOutput === null) return
    const note = midi & 0x7F
    const vel = Math.max(1, Math.min(127, Math.floor(velocity * 127)))
    try { this.midiOutput.send([0x90, note, vel]) } catch { return }
    this.activeMidiNotes.add(note)
    setTimeout(() => {
      try { this.midiOutput?.send([0x80, note, 0]) } catch { /* ignore */ }
      this.activeMidiNotes.delete(note)
    }, Math.max(80, durationSec * 1000))
  }

  /** Silence every registered note and send All Notes Off. */
  private allMidiOff(): void {
    if (this.midiOutput === null) return
    for (const note of this.activeMidiNotes) {
      try { this.midiOutput.send([0x80, note, 0]) } catch { /* ignore */ }
    }
    this.activeMidiNotes.clear()
    try { this.midiOutput.send([0xB0, 123, 0]) } catch { /* ignore */ }
  }
}
