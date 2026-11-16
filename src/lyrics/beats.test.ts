import { describe, expect, it } from 'vitest'
import {
  BEAT_HZ,
  accumulateBeatPcm,
  beatsFromSegments,
  createBeatAcc,
  finalizeBeatEnvelope,
  finalizeVocalEnvelope,
  sampleBeatAt,
  stepBeatEnvelope,
} from './beats'

describe('beats envelope & real-time sampling', () => {
  it('extracts sharp kick spikes from decoded PCM drum impulses', () => {
    const sampleRate = 8000
    const durationSec = 4
    const acc = createBeatAcc(durationSec)
    expect(acc.hz).toBe(BEAT_HZ)
    expect(acc.bins).toBe(durationSec * BEAT_HZ)

    // Quiet floor + loud kick bursts at 1.0s and 2.0s (120 Hz burst for 60ms)
    const pcm = new Float32Array(sampleRate * durationSec)
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.04 * Math.sin((2 * Math.PI * 100 * i) / sampleRate)
    }
    for (const beatTime of [1.0, 2.0]) {
      const start = Math.floor(beatTime * sampleRate)
      const len = Math.floor(0.06 * sampleRate)
      for (let i = 0; i < len; i++) {
        pcm[start + i] = 0.9 * Math.sin((2 * Math.PI * 120 * i) / sampleRate)
      }
    }

    accumulateBeatPcm(acc, [pcm], sampleRate, 0)
    const beats = finalizeBeatEnvelope(acc)
    expect(beats.length).toBe(durationSec * BEAT_HZ)

    const quiet = sampleBeatAt(beats, null, durationSec, 500)
    const hit1 = sampleBeatAt(beats, null, durationSec, 1020)
    const hit2 = sampleBeatAt(beats, null, durationSec, 2020)
    const between = sampleBeatAt(beats, null, durationSec, 1500)

    expect(hit1.energy).toBeGreaterThan(0.7)
    expect(hit1.kick).toBeGreaterThan(0.55)
    expect(hit2.kick).toBeGreaterThan(0.55)
    expect(quiet.kick).toBeLessThan(0.2)
    expect(between.kick).toBeLessThan(0.2)
  })

  it('builds a 12 Hz beat envelope from Spotify audio analysis segments', () => {
    const durationSec = 4
    // Spotify segments format: [startSec, durSec, loudnessDb (-45..0)]
    const segments: [number, number, number][] = [
      [0.0, 0.5, -24],
      [0.5, 0.4, -1.2], // loud drop onset at 500ms
      [0.9, 0.6, -22],
      [1.5, 0.5, -2.5], // second beat onset at 1500ms
      [2.0, 2.0, -28],
    ]
    const beats = beatsFromSegments(segments, durationSec)
    expect(beats).not.toBeNull()
    expect(beats!.length).toBe(durationSec * BEAT_HZ)

    const beforeDrop = sampleBeatAt(beats, null, durationSec, 250)
    const atDrop = sampleBeatAt(beats, null, durationSec, 520)
    const hit2 = sampleBeatAt(beats, null, durationSec, 1520)
    const tail = sampleBeatAt(beats, null, durationSec, 3000)

    expect(atDrop.energy).toBeGreaterThan(0.75)
    expect(atDrop.kick).toBeGreaterThan(0.55)
    expect(hit2.kick).toBeGreaterThan(0.5)
    expect(beforeDrop.kick).toBeLessThan(0.25)
    expect(tail.energy).toBeLessThan(0.3)
  })

  it('falls back gracefully to coarse waveform peaks when high-res beats are absent', () => {
    const peaks = new Float32Array([0.1, 0.12, 0.14, 0.9, 0.4, 0.15, 0.1, 0.85])
    const durationSec = 8
    const quiet = sampleBeatAt(null, peaks, durationSec, 1000)
    const peakJump = sampleBeatAt(null, peaks, durationSec, 3000)
    expect(peakJump.energy).toBeGreaterThan(quiet.energy)
    expect(peakJump.kick).toBeGreaterThan(quiet.kick)
  })

  it('returns zero safely for invalid durations or empty inputs', () => {
    expect(beatsFromSegments([], 0)).toBeNull()
    expect(sampleBeatAt(null, null, 0, 1000)).toEqual({ energy: 0, kick: 0 })
    expect(sampleBeatAt(new Float32Array(0), null, 10, -50)).toEqual({ energy: 0, kick: 0 })
  })

  it('locks beat sampling directly to audio seconds without drifting when metadata duration differs and isolates low-end kicks', () => {
    const sampleRate = 8000
    const actualAudioSec = 6
    const metadataDurationSec = 10
    const acc = createBeatAcc(actualAudioSec)

    const pcm = new Float32Array(sampleRate * actualAudioSec)
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = 0.28 * Math.sin((2 * Math.PI * 2600 * i) / sampleRate)
    }
    const kickStart = Math.floor(3.0 * sampleRate)
    const kickLen = Math.floor(0.08 * sampleRate)
    for (let i = 0; i < kickLen; i++) {
      pcm[kickStart + i] += 0.75 * Math.sin((2 * Math.PI * 85 * i) / sampleRate)
    }

    accumulateBeatPcm(acc, [pcm], sampleRate, 0)
    const beats = finalizeBeatEnvelope(acc)

    const atKick = sampleBeatAt(beats, null, metadataDurationSec, 3020)
    const between = sampleBeatAt(beats, null, metadataDurationSec, 2200)
    expect(atKick.kick).toBeGreaterThan(0.55)
    expect(between.kick).toBeLessThan(0.22)
  })

  it('noise-gates subtle ambient ripples so soft passages do not shake lyric text', () => {
    const gentleBeats = new Float32Array([0.32, 0.34, 0.37, 0.35, 0.38, 0.36, 0.39, 0.35])
    const s = sampleBeatAt(gentleBeats, null, gentleBeats.length / BEAT_HZ, 100)
    expect(s.energy).toBeGreaterThan(0.3)
    expect(s.kick).toBe(0)
  })

  it('extracts 300-3200Hz vocal midrange presence independently of sub-bass kicks', () => {
    const sampleRate = 8000
    const durationSec = 4
    const acc = createBeatAcc(durationSec)
    const pcm = new Float32Array(sampleRate * durationSec)
    // Pure sub-bass 65Hz kick around t=1s
    for (let i = sampleRate; i < Math.floor(1.5 * sampleRate); i++) {
      pcm[i] = 0.9 * Math.sin((2 * Math.PI * 65 * i) / sampleRate)
    }
    // Vocal midrange 1100Hz formant around t=2.5s..3.2s
    for (let i = Math.floor(2.5 * sampleRate); i < Math.floor(3.2 * sampleRate); i++) {
      pcm[i] = 0.7 * Math.sin((2 * Math.PI * 1100 * i) / sampleRate)
    }
    accumulateBeatPcm(acc, [pcm], sampleRate, 0)
    const vocal = finalizeVocalEnvelope(acc)
    const kickBin = Math.floor(1.25 * BEAT_HZ)
    const vocBin = Math.floor(2.85 * BEAT_HZ)
    expect(vocal[vocBin]!).toBeGreaterThan(0.75)
    expect(vocal[kickBin]!).toBeLessThan(0.25)
  })

  it('integrates beat envelope with fast attack and smooth release down to clean zero', () => {
    const env = { kick: 0, energy: 0 }
    stepBeatEnvelope(env, 1, 0.8, 16)
    expect(env.kick).toBeGreaterThan(0.5)
    expect(env.energy).toBeGreaterThan(0.1)

    for (let i = 0; i < 60; i++) stepBeatEnvelope(env, 0, 0, 32)
    expect(env.kick).toBe(0)
    expect(env.energy).toBe(0)
  })
})
