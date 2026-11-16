import { describe, expect, test } from 'vitest'
import type { LyricsLine } from '../vk/models'
import { BEAT_HZ } from './beats'
import { buildLineWords, buildLyricsWords, computeWordProgress, findActiveLineIndex, lineSeekSeconds } from './timing'

describe('lyrics timing', () => {
  test('uses real word timings when present and clamps valid end boundaries', () => {
    const line: LyricsLine = {
      text: 'Hello world',
      begin: 1000,
      end: 2400,
      words: [
        { text: 'Hello', begin: 1000, end: 1500 },
        { text: 'world', begin: 1500 },
      ],
    }

    expect(buildLineWords(line)).toEqual([
      { text: 'Hello', begin: 1000, end: 1500 },
      { text: 'world', begin: 1500, end: 2400 },
    ])
  })

  test('distributes line-level timestamps proportionally across words and caps long instrumental pauses', () => {
    const line: LyricsLine = {
      text: 'Hi everyone',
      begin: 1000,
      end: 16000,
    }

    const words = buildLineWords(line)
    expect(words.map((w) => w.text)).toEqual(['Hi', 'everyone'])
    expect(words[0].begin).toBe(1000)
    expect(words[0].end).toBe(words[1].begin)
    // Longer word gets more time than shorter word
    expect(words[1].end - words[1].begin).toBeGreaterThan(words[0].end - words[0].begin)
    // Speech window finishes crisply before the 15s instrumental tail ends
    expect(words[1].end).toBeLessThan(2600)
  })

  test('binary searches active line accurately across sorted synced lines', () => {
    const lines: LyricsLine[] = [
      { text: 'Line 1', begin: 1000, end: 2500 },
      { text: 'Line 2', begin: 2500, end: 5000 },
      { text: 'Line 3', begin: 5000 },
    ]

    expect(findActiveLineIndex(lines, 500)).toBe(-1)
    expect(findActiveLineIndex(lines, 1000)).toBe(0)
    expect(findActiveLineIndex(lines, 2499)).toBe(0)
    expect(findActiveLineIndex(lines, 2500)).toBe(1)
    expect(findActiveLineIndex(lines, 99999)).toBe(2)
    expect(findActiveLineIndex([{ text: 'Plain' }], 1000)).toBe(-1)
  })

  test('computes per-word progress in [0, 1]', () => {
    const words = [
      { text: 'Эти', begin: 1000, end: 1400 },
      { text: 'блики', begin: 1400, end: 2200 },
    ]

    expect(computeWordProgress(words, 900)).toEqual([0, 0])
    expect(computeWordProgress(words, 1200)).toEqual([0.5, 0])
    expect(computeWordProgress(words, 1800)).toEqual([1, 0.5])
    expect(computeWordProgress(words, 2600)).toEqual([1, 1])
  })

  test('nudges line click seek slightly past begin boundary so audio frame rounding stays on target line', () => {
    expect(lineSeekSeconds(0)).toBeCloseTo(0.085, 3)
    expect(lineSeekSeconds(140000)).toBeCloseTo(140.085, 3)
    expect(lineSeekSeconds(1000, 1200)).toBeCloseTo(1.05, 3)
  })

  test('calibrates pacing to slow ballads instead of finishing early while preserving comma breath pauses', () => {
    const slowLines: LyricsLine[] = [
      { text: 'Thought I found a way', begin: 1000, end: 4200 },
      { text: 'Hold on, my friend', begin: 4200, end: 8200 },
      { text: 'But you never go away', begin: 8200, end: 12200 },
      { text: 'Need some time alone', begin: 12200, end: 16200 },
    ]

    const allWords = buildLyricsWords(slowLines)
    const line2 = allWords[1]!
    // Slow ballad pacing expands across the real ~3s vocal window instead of rushing ahead in ~1s
    expect(line2[line2.length - 1].end).toBeGreaterThan(6900)
    expect(line2[line2.length - 1].end).toBeLessThan(8100)
    // Comma pause leaves clean release gap before the next phrase
    expect(line2[1].end).toBeLessThan(line2[2].begin)
  })

  test('aligns comma breath pauses and quiet pickup lead-ins against the vocal midrange envelope', () => {
    const durSec = 5
    const bins = durSec * BEAT_HZ
    const vocal = new Float32Array(bins)
    // Line [1.0s .. 4.0s]: quiet pickup until 1.18s, singing, breath pause around 2.65s..2.9s, then singing until 3.85s
    for (let i = 0; i < bins; i++) {
      const t = i / BEAT_HZ
      if (t >= 1.18 && t <= 2.55) vocal[i] = 0.85
      else if (t > 2.55 && t < 2.92) vocal[i] = 0.08
      else if (t >= 2.92 && t <= 3.85) vocal[i] = 0.85
      else vocal[i] = 0.05
    }
    const words = buildLyricsWords([{ text: 'Wait right here, then go', begin: 1000, end: 4000 }], vocal)[0]!
    // Onset shifts cleanly onto vocal entry past initial quiet 180ms buffer
    expect(words[0].begin).toBeGreaterThan(1060)
    // Next clause after comma pulls toward the 2.65..2.92s vocal breath pocket
    expect(words[3].begin).toBeGreaterThan(2500)
    expect(words[3].begin).toBeLessThan(3100)
  })
})
