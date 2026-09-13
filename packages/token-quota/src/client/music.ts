/**
 * Live-composed soundtrack driven by host actions (turns, steps, tool calls,
 * etc.). Outputs through Web Audio (built-in synthesis) by default, and also
 * sends MIDI NoteOn/NoteOff to the first available MIDI output when one is
 * detected (both play simultaneously when MIDI is present — use the panel
 * volume for overall level, the MIDI output has its own gain on the receiver).
 *
 * The composition is intentionally simple: a fixed chord progression under a
 * scale-constrained melody, with one short musical gesture per host action.
 * It is meant as gentle ambience while waiting for LLM responses, not as a
 * full piece — everything stays in key so you can never hit a wrong note.
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

/**
 * Turn a MIDI note number into a frequency (Hz) using equal temperament at
 * A4 = 440 Hz.
 */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** Live-composed music engine driven by host actions. */
export class TokenQuotaMusic {
  private audio: AudioContext | null = null
  private midiOutput: MIDIOutput | null = null
  private midiDetected = false

  private enabled = false
  private volume = 0.5
  private style: TokenQuotaMusicStyle = 'major'

  /** Current position in the chord progression (advances per step). */
  private chordIndex = 0
  /** Step counter — used for melody degree selection. */
  private stepCount = 0
  /** Tool counter — used for tool-note pitch. */
  private toolCount = 0

  /** Base MIDI note of the current key. C4 = middle C. */
  private static readonly BASE_MIDI = 60

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
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
  }

  setStyle(value: TokenQuotaMusicStyle): void {
    this.style = value
  }

  /** Handle one incoming host action and turn it into sound. */
  onAction(action: TokenQuotaMusicAction): void {
    if (!this.enabled || this.audio === null) return
    const base = TokenQuotaMusic.BASE_MIDI
    switch (action.type) {
      case 'turn/start':
        this.chordIndex = 0
        this.stepCount = 0
        this.toolCount = 0
        this.playChord(base, this.currentChordQuality(), 1.6, 0.55)
        break
      case 'step/start': {
        this.chordIndex = (this.chordIndex + 1) % CHORD_PROGRESSIONS[this.style].length
        this.stepCount += 1
        // bass note of the new chord
        this.playNote(this.currentChordRoot(base) - 12, 1.2, 0.35)
        // ascending arpeggio of the chord (3 notes)
        const root = this.currentChordRoot(base)
        const [d1, d2, d3] = this.arpeggioDegrees()
        setTimeout(() => this.playNote(root + d1, 0.2, 0.4), 0)
        setTimeout(() => this.playNote(root + d2, 0.2, 0.4), 80)
        setTimeout(() => this.playNote(root + d3, 0.35, 0.4), 160)
        break
      }
      case 'request/header': {
        // short melodic flicker — pitch follows step + tool positions
        const degree = (this.stepCount * 2 + this.toolCount) % SCALES[this.style].length
        const note = base + 12 + SCALES[this.style][degree]!
        this.playNote(note, 0.18, 0.35)
        break
      }
      case 'tool/call':
        this.toolCount += 1
        // high plink + a low percussive tap
        this.playNote(base + 24 + (this.toolCount % 3) * 2, 0.12, 0.45)
        this.playNote(base - 12, 0.08, 0.25)
        break
      case 'tool/result': {
        if (action.error) {
          // dissonant downward glint (two half-steps)
          this.playNote(base + 13, 0.18, 0.4)
          setTimeout(() => this.playNote(base + 12, 0.25, 0.4), 90)
        } else {
          // upward resolution
          this.playNote(base + 9, 0.14, 0.3)
          setTimeout(() => this.playNote(base + 11, 0.22, 0.3), 70)
        }
        break
      }
      case 'assistant/message':
        if (action.interrupted) {
          // interrupted turn: diminished tension chord
          this.playChord(base + 7, 'dim', 0.9, 0.5)
        } else {
          // full cadence chord of the current step
          this.playChord(this.currentChordRoot(base), this.currentChordQuality(), 1.1, 0.55)
        }
        break
      case 'turn/end':
        // final tonic chord, longer release
        this.playChord(base, this.style === 'minor' ? 'minor' : 'major', 2.2, 0.65)
        this.chordIndex = 0
        break
    }
  }

  // ── internal helpers ──────────────────────────────────────────────

  private currentChordRoot(base: number): number {
    const prog = CHORD_PROGRESSIONS[this.style]
    return base + prog[this.chordIndex % prog.length]!
  }

  private currentChordQuality(): ChordQuality {
    const q = CHORD_QUALITIES[this.style]
    return q[this.chordIndex % q.length] ?? 'major'
  }

  /** Intervals of an ascending arpeggio from the chord root. */
  private arpeggioDegrees(): [number, number, number] {
    return this.style === 'pentatonic'
      ? [0, 7, 12]
      : this.currentChordQuality() === 'major'
        ? [0, 4, 7]
        : [0, 3, 7]
  }

  /** Play one note: Web Audio + MIDI simultaneously when available. */
  private playNote(midi: number, durationSec: number, velocity: number): void {
    if (!this.audio) return
    const now = this.audio.currentTime
    const peak = this.volume * velocity * 0.5
    if (peak <= 0) return

    // Web Audio: sine oscillator with a quick attack and exponential release.
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

    // MIDI: same note on the first output, if any. Velocity 1..127.
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
    const third = quality === 'major' ? 4 : 3
    const fifth = quality === 'dim' ? 6 : 7
    this.playNote(rootMidi, durationSec, velocity * 0.45)
    this.playNote(rootMidi + third, durationSec, velocity * 0.35)
    this.playNote(rootMidi + fifth, durationSec, velocity * 0.35)
    // bass in the octave below — slightly longer for warmth
    this.playNote(rootMidi - 12, durationSec * 1.15, velocity * 0.45)
  }
}
