import { describe, expect, test } from 'vitest'
import { alignWhisperToLines, whisperWordsToLyrics, type WhisperWordChunk } from './align'

describe('whisper alignment & line builder', () => {
  test('aligns noisy Whisper word timings back onto canonical plain lyric lines monotonically', () => {
    const plain = [
      { text: 'Эти блики ослепляют' },
      { text: 'Танцы до утра' },
    ]
    const asr: WhisperWordChunk[] = [
      { text: 'Этим', beginMs: 1200, endMs: 1550 },
      { text: 'блике', beginMs: 1550, endMs: 2100 },
      // Missing 'ослепляют' (unheard by ASR) -> should interpolate cleanly before 'Танцы'
      { text: 'танцы', beginMs: 3600, endMs: 4100 },
      { text: 'до', beginMs: 4100, endMs: 4300 },
      { text: 'утра', beginMs: 4300, endMs: 5000 },
    ]

    const aligned = alignWhisperToLines(plain, asr)
    expect(aligned).toHaveLength(2)
    expect(aligned[0].text).toBe('Эти блики ослепляют')
    expect(aligned[0].begin).toBe(1200)
    expect(aligned[0].words?.map((w) => w.text)).toEqual(['Эти', 'блики', 'ослепляют'])
    expect(aligned[0].words?.[0]).toEqual({ text: 'Эти', begin: 1200, end: 1550 })
    expect(aligned[0].words?.[1]).toEqual({ text: 'блики', begin: 1550, end: 2100 })
    // Unmatched trailing word fills cleanly between 2100 and next line begin 3600
    expect(aligned[0].words?.[2].begin).toBe(2100)
    expect(aligned[0].words?.[2].end).toBeLessThanOrEqual(3600)

    expect(aligned[1].text).toBe('Танцы до утра')
    expect(aligned[1].begin).toBe(3600)
    expect(aligned[1].words).toEqual([
      { text: 'Танцы', begin: 3600, end: 4100 },
      { text: 'до', begin: 4100, end: 4300 },
      { text: 'утра', begin: 4300, end: 5000 },
    ])
  })

  test('groups raw Whisper word chunks into readable lines on pauses and punctuation', () => {
    const chunks: WhisperWordChunk[] = [
      { text: 'Hello', beginMs: 1000, endMs: 1400 },
      { text: 'darkness.', beginMs: 1400, endMs: 2100 },
      { text: 'I', beginMs: 2200, endMs: 2400 },
      { text: 'am', beginMs: 2400, endMs: 2650 },
      { text: 'here', beginMs: 2650, endMs: 3000 },
      { text: 'Still', beginMs: 4200, endMs: 4600 }, // >650ms gap forces new line
      { text: 'standing', beginMs: 4600, endMs: 5200 },
    ]

    const lyrics = whisperWordsToLyrics(chunks)
    expect(lyrics?.synced).toBe(true)
    expect(lyrics?.source).toBe('ai')
    expect(lyrics?.lines.map((l) => l.text)).toEqual([
      'Hello darkness.',
      'I am here',
      'Still standing',
    ])
    expect(lyrics?.lines[0].begin).toBe(1000)
    expect(lyrics?.lines[0].end).toBe(2200)
    expect(lyrics?.lines[2].begin).toBe(4200)
  })

  test('keeps interpolated unmatched words strictly monotonic when many words fit into a tight gap', () => {
    const plain = [
      { text: 'start one two three four five six seven eight end' },
    ]
    const asr: WhisperWordChunk[] = [
      { text: 'start', beginMs: 1000, endMs: 1100 },
      // Only 80ms gap before "end" for 8 unmatched words -> must never produce begin > end
      { text: 'end', beginMs: 1180, endMs: 1400 },
    ]

    const aligned = alignWhisperToLines(plain, asr)
    const words = aligned[0].words ?? []
    expect(words).toHaveLength(10)
    for (let i = 0; i < words.length; i++) {
      expect(words[i].begin).toBeLessThanOrEqual(words[i].end!)
      if (i > 0) {
        expect(words[i].begin).toBeGreaterThanOrEqual(words[i - 1].begin)
        expect(words[i].begin).toBeGreaterThanOrEqual(words[i - 1].end!)
      }
    }
    expect(words.at(-1)).toEqual({ text: 'end', begin: 1180, end: 1400 })
  })
})
