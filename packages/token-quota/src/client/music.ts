/**
 * Live-composed ambient soundtrack driven by host actions (turns, steps,
 * tool calls, etc.). Three layers:
 *
 *  - **Pad**: a sustained three-note chord (triangle waves) that fades in when
 *    a request starts and crossfades to the next chord on every step.
 *  - **Bass**: one long root note per beat (lower octave), keeps the pulse.
 *  - **Melody**: an eighth-note scale line that dances inside the current
 *    chord — always in key, never a wrong note.
 *
 * Outputs through Web Audio (built-in synthesis) by default, and also sends
 * MIDI NoteOn/NoteOff to the first available MIDI output when one is detected
 * (both play simultaneously when MIDI is present — use the panel volume for
 * overall level, the MIDI output has its own gain on the receiver).
 *
 * @module @jxgame2020/dsh-token-quota/music
 */

import type { TokenQuotaMusicAction, TokenQuotaMusicStyle } from '../types.ts'

/** Scale degrees in semitones from the root. */
const SCALES: Record<TokenQuotaMusicStyle, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
}

/**
 * Chord progression roots in semitones from the key centre. Loops — every
 * step advance moves one position forward.
 */
const CHORD_PROGRESSIONS: Record<TokenQuotaMusicStyle, number[]> = {
  major: [0, 9, 5, 7],        // I - vi - IV - V
  minor: [0, 9, 4, 11],       // i - VI - III - VII
  pentatonic: [0, 7, 2, 9],   // open fifths feel — root + 5th
}

/** Quality of each chord in the progression above. */
type ChordQuality = 'major' | 'minor' | 'dim'

const CHORD_QUALITIES: Record<TokenQuotaMusicStyle, ChordQuality[]> = {
  major: ['major', 'minor', 'major', 'major'],
  minor: ['minor', 'major', 'major', 'major'],
  pentatonic: ['major', 'major', 'major', 'major'],
}

/** Turn a MIDI note number into a frequency (equal temperament, A4 = 440). */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** Interval in semitones from the root for each chord-tone. */
function chordIntervals(quality: ChordQuality): [number, number, number] {
  const third = quality === 'major' ? 4 : quality === 'minor' ? 3 : 3
  const fifth = quality === 'dim' ? 6 : 7
  return [0, third, fifth]
}

/**
 * Live-composed music engine driven by host actions.
 *
 * The engine is idle until `ensureStarted()` is called from a user gesture
 * (the panel switch), and only produces sound while `enabled` is true AND a
 * request is in flight (pad + bass + melody are gated by `startPad` /
 * `stopPad`).
 */
export class TokenQuotaMusic {
  private audio: AudioContext | null = null
  private midiOutput: MIDIOutput | null = null
  private midiDetected = false

  private enabled = false
  private volume = 0.5
  private style: TokenQuotaMusicStyle = 'major'

  // Composition state
  private chordIndex = 0
  private stepCount = 0
  private toolCount = 0

  // Pad layer (sustained chord)
  private padOscs: OscillatorNode[] = []
  private padGain: GainNode | null = null
  private padTarget = 0
  private padActive = false

  // Bass + melody timing (shared beat clock)
  private beatTimer: ReturnType<typeof setInterval> | undefined
  private beatIndex = 0 // 0..3 inside a 4-beat bar
  private melodyDirection = 1
  private melodyDegree = 0

  // Current chord (root midi + quality) for the melody and bass.
  private currentRoot = 60 // C4
  private currentQuality: ChordQuality = 'major'

  /** Base MIDI note of the key. C4 = middle C. */
  private static readonly BASE_MIDI = 60

  /** Beat length in ms — eighth note = beat / 2. */
  private static readonly BEAT_MS = 640

  /** True once the audio context has been started (needs a user gesture). */
  get started(): boolean {
    return this.audio !== null
  }

  /**
   * Start the audio context and try to find a MIDI output.
   * Must be called inside a user gesture (the panel switch click) so the
   * AudioContext can resume. Safe to call multiple times.
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
    // MIDI: try once; we don't re-probe (browser asks for permission only once).
    if (!this.midiDetected && 'requestMIDIAccess' in navigator) {
      this.midiDetected = true
      try {
        const access = await (navigator as Navigator).requestMIDIAccess()
        for (const output of access.outputs.values()) {
          this.midiOutput = output
          break
        }
      } catch {
        // Permission denied or no MIDI hardware — stick to Web Audio.
        this.midiOutput = null
      }
    }
    return true
  }

  setEnabled(value: boolean): void {
    this.enabled = value
    if (!value) this.stopAll()
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
    if (this.padGain !== null && this.audio !== null) {
      this.padGain.gain.setValueAtTime(this.volume * this.padTarget, this.audio.currentTime)
    }
  }

  setStyle(value: TokenQuotaMusicStyle): void {
    this.style = value
    // Reset position so the new scale feels immediately.
    this.melodyDegree = 0
    this.melodyDirection = 1
  }

  /** Handle one incoming host action and turn it into sound. */
  onAction(action: TokenQuotaMusicAction): void {
    if (!this.enabled || this.audio === null) return
    const base = TokenQuotaMusic.BASE_MIDI
    switch (action.type) {
      case 'turn/start':
        this.stopAll()
        this.chordIndex = 0
        this.stepCount = 0
        this.toolCount = 0
        this.currentRoot = base
        this.currentQuality = CHORD_QUALITIES[this.style][0] ?? 'major'
        this.playChord(base, this.currentQuality, 1.6, 0.6)
        break
      case 'step/start': {
        this.chordIndex = (this.chordIndex + 1) % CHORD_PROGRESSIONS[this.style].length
        this.stepCount += 1
        const root = base + (CHORD_PROGRESSIONS[this.style][this.chordIndex] ?? 0)
        const quality = CHORD_QUALITIES[this.style][this.chordIndex] ?? 'major'
        this.currentRoot = root
        this.currentQuality = quality
        if (this.padActive) this.crossfadePad(root, quality)
        break
      }
      case 'request/header': {
        // Kick off the full three-layer ambient bed — the model is thinking
        // and the user is waiting; this is where the soundtrack lives.
        this.startPad(this.currentRoot, this.currentQuality)
        this.startBeatClock()
        // Small melodic flicker on top to mark the exact start.
        const degree = (this.stepCount * 2 + this.toolCount) % SCALES[this.style].length
        const note = base + 12 + (SCALES[this.style][degree] ?? 0)
        this.playNote(note, 0.25, 0.4)
        break
      }
      case 'tool/call':
        this.toolCount += 1
        // High plink + low percussive tap — stays distinguishable over the pad.
        this.playNote(base + 24 + (this.toolCount % 3) * 2, 0.12, 0.45)
        this.playNote(base - 12, 0.08, 0.3)
        break
      case 'tool/result': {
        if (action.error) {
          // Dissonant downward glint (two half-steps).
          this.playNote(base + 13, 0.18, 0.4)
          setTimeout(() => this.playNote(base + 12, 0.25, 0.4), 90)
        } else {
          // Upward resolution.
          this.playNote(base + 9, 0.14, 0.35)
          setTimeout(() => this.playNote(base + 11, 0.22, 0.35), 70)
        }
        break
      }
      case 'assistant/attempt':
        // Failed attempt: wind down a moment and play a falling tension figure.
        this.playNote(base + 8, 0.18, 0.4)
        setTimeout(() => this.playNote(base + 7, 0.2, 0.4), 100)
        setTimeout(() => this.playNote(base + 5, 0.3, 0.4), 200)
        break
      case 'assistant/message':
        this.stopBeatClock()
        this.stopPad()
        if (action.interrupted) {
          this.playChord(base + 7, 'dim', 0.9, 0.55)
        } else {
          this.playChord(this.currentRoot, this.currentQuality, 1.1, 0.6)
        }
        break
      case 'turn/end':
        this.stopAll()
        // Final tonic chord, longer release.
        this.playChord(base, this.style === 'minor' ? 'minor' : 'major', 2.4, 0.7)
        this.chordIndex = 0
        break
    }
  }

  // ── pad layer (sustained chord) ────────────────────────────────────────

  /** Start the pad from silence, fading in to the target level. */
  private startPad(rootMidi: number, quality: ChordQuality): void {
    if (!this.audio) return
    if (this.padActive) return
    const now = this.audio.currentTime
    const gain = this.audio.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.connect(this.audio.destination)
    const intervals = chordIntervals(quality)
    const oscs: OscillatorNode[] = []
    for (const interval of intervals) {
      const osc = this.audio.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = midiToFreq(rootMidi + interval)
      osc.connect(gain)
      osc.start(now)
      oscs.push(osc)
    }
    this.padOscs = oscs
    this.padGain = gain
    this.padTarget = 0.18
    gain.gain.linearRampToValueAtTime(this.volume * this.padTarget, now + 0.6)
    this.padActive = true
  }

  /** Smoothly morph the pad to a new root + quality. */
  private crossfadePad(rootMidi: number, quality: ChordQuality): void {
    if (!this.audio || !this.padActive || this.padGain === null) return
    const now = this.audio.currentTime
    const intervals = chordIntervals(quality)
    this.padOscs.forEach((osc, i) => {
      const interval = intervals[i] ?? 0
      osc.frequency.setValueAtTime(osc.frequency.value, now)
      osc.frequency.exponentialRampToValueAtTime(midiToFreq(rootMidi + interval), now + 0.5)
    })
  }

  /** Fade the pad to silence, then stop the oscillators. */
  private stopPad(): void {
    if (!this.audio || !this.padActive || this.padGain === null) return
    const now = this.audio.currentTime
    const gain = this.padGain
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(gain.gain.value, now)
    gain.gain.linearRampToValueAtTime(0, now + 0.8)
    const oscs = this.padOscs
    setTimeout(() => {
      for (const osc of oscs) {
        try { osc.stop() } catch { /* ignore */ }
        try { osc.disconnect() } catch { /* ignore */ }
      }
      try { gain.disconnect() } catch { /* ignore */ }
    }, 850)
    this.padActive = false
    this.padOscs = []
    this.padGain = null
  }

  // ── beat clock (bass + melody) ────────────────────────────────────────

  /** Start the per-beat clock that drives bass and melody. */
  private startBeatClock(): void {
    if (this.beatTimer !== undefined) return
    this.beatIndex = 0
    this.melodyDegree = 0
    this.melodyDirection = 1
    const tick = (): void => {
      if (!this.audio || !this.enabled) return
      // Bass note on beats 1 and 3 — root of the current chord, low octave.
      if (this.beatIndex % 2 === 0) {
        this.playNote(this.currentRoot - 12, 0.45, 0.3)
      }
      // Melody: eighth-note scale line inside the current chord.
      const scale = SCALES[this.style]
      const chordTones = new Set(chordIntervals(this.currentQuality))
      // Walk up and down the scale, preferring chord tones on beats.
      let degree = this.melodyDegree
      // Pick the next scale degree in the current direction.
      let next = degree + this.melodyDirection
      if (next >= scale.length) {
        this.melodyDirection = -1
        next = scale.length - 2
      } else if (next < 0) {
        this.melodyDirection = 1
        next = 0
      }
      this.melodyDegree = next
      degree = next

      // Make sure we land on a chord tone on the downbeat.
      if (this.beatIndex % 2 === 0) {
        const rootRel = (scale[degree] ?? 0) % 12
        if (!chordTones.has(rootRel)) {
          // Shift one step toward the nearest chord tone.
          this.melodyDegree += this.melodyDirection
          degree = this.melodyDegree
        }
      }
      const note = this.currentRoot + 12 + (scale[degree] ?? 0)
      // Melody note — slightly shorter than a beat, staccato feel.
      this.playNote(note, 0.22, 0.28)
      this.beatIndex = (this.beatIndex + 1) % 4
    }
    // First tick right away so the melody starts with the request.
    tick()
    this.beatTimer = setInterval(tick, TokenQuotaMusic.BEAT_MS)
  }

  private stopBeatClock(): void {
    if (this.beatTimer !== undefined) {
      clearInterval(this.beatTimer)
      this.beatTimer = undefined
    }
  }

  // ── teardown ──────────────────────────────────────────────────────────

  private stopAll(): void {
    this.stopBeatClock()
    this.stopPad()
  }

  // ── primitive note / chord playback (shared by all layers) ────────────

  /** Play one note: Web Audio + MIDI simultaneously when available. */
  private playNote(midi: number, durationSec: number, velocity: number): void {
    if (!this.audio) return
    const peak = this.volume * velocity * 0.5
    if (peak <= 0) return
    const now = this.audio.currentTime
    const osc = this.audio.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = midiToFreq(midi)
    const gain = this.audio.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(peak, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec)
    osc.connect(gain)
    gain.connect(this.audio.destination)
    osc.start(now)
    osc.stop(now + durationSec + 0.05)

    if (this.midiOutput !== null) {
      const vel = Math.max(1, Math.floor(velocity * 127))
      this.midiOutput.send([0x90, midi & 0x7F, vel])
      setTimeout(() => {
        this.midiOutput?.send([0x80, midi & 0x7F, 0])
      }, durationSec * 1000)
    }
  }

  /** Play a three-note chord plus a bass octave below. */
  private playChord(rootMidi: number, quality: ChordQuality, durationSec: number, velocity: number): void {
    const intervals = chordIntervals(quality)
    for (const interval of intervals) {
      this.playNote(rootMidi + interval, durationSec, velocity * 0.45)
    }
    this.playNote(rootMidi - 12, durationSec * 1.1, velocity * 0.5)
  }
}
