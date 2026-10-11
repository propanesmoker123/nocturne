import { describe, expect, test } from 'vitest'
import type { QuickTrack } from '../lib/events'
import { buildRows, firstTrack, indexOfKey, keyIntent, step } from './model'

const t = (key: string, playable = true): QuickTrack => ({ key, title: key, artist: 'A', duration: 100, explicit: false, playable })

describe('quick search rows', () => {
  test('a section gets its header only when it has tracks', () => {
    expect(buildRows([], []).length).toBe(0)
    expect(buildRows([t('a')], []).map((r) => (r.kind === 'header' ? r.label : r.track.key))).toEqual(['В моей музыке', 'a'])
    expect(buildRows([t('a')], [t('b'), t('c')]).map((r) => (r.kind === 'header' ? r.label : r.track.key))).toEqual([
      'В моей музыке',
      'a',
      'VK Музыка',
      'b',
      'c',
    ])
    expect(buildRows([], [t('b')])[0]).toMatchObject({ kind: 'header', label: 'VK Музыка' })
  })

  test('arrows walk over tracks, skipping headers and tracks that cannot play, and stop at the ends', () => {
    const rows = buildRows([t('a'), t('x', false)], [t('b')])
    // 0 header, 1 a, 2 x (unplayable), 3 header, 4 b
    expect(firstTrack(rows)).toBe(1)
    expect(step(rows, 1, 1)).toBe(4)
    expect(step(rows, 4, 1)).toBe(4)
    expect(step(rows, 4, -1)).toBe(1)
    expect(step(rows, 1, -1)).toBe(1)
    expect(step(rows, -1, 1)).toBe(1)
    expect(firstTrack(buildRows([t('x', false)], []))).toBe(-1)
  })

  test('the selection survives new results when its track is still there', () => {
    const rows = buildRows([t('a')], [t('b'), t('c')])
    expect(indexOfKey(rows, 'c')).toBe(4)
    expect(indexOfKey(rows, 'gone')).toBe(-1)
    expect(indexOfKey(rows, null)).toBe(-1)
  })
})

describe('quick search keys', () => {
  const k = (key: string, shiftKey = false) => keyIntent({ key, shiftKey })
  test('maps the keyboard to actions', () => {
    expect(k('ArrowDown')).toBe('down')
    expect(k('Tab')).toBe('down')
    expect(k('ArrowUp')).toBe('up')
    expect(k('Tab', true)).toBe('up')
    expect(k('Enter')).toBe('play')
    expect(k('Enter', true)).toBe('next')
    expect(k('Escape')).toBe('close')
    expect(k('a')).toBe(null)
    expect(k('ArrowLeft')).toBe(null)
  })
})
