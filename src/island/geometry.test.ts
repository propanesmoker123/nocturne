import { afterEach, describe, expect, test, vi } from 'vitest'
import { COLLAPSE_DELAY, FLASH_MS, PEEK_MS, SHAPES, VOLUME_HUD_MS, WINDOW, hitRect, isInteractive, moment, pickShape, volumeChanged } from './geometry'

describe('island moments', () => {
  afterEach(() => void vi.useRealTimers())

  test('a like and then a quick switch of tracks: neither the badge nor the peek stays up', () => {
    vi.useFakeTimers()
    const shown: { peek: true | null; flash: 'added' | 'removed' | null } = { peek: null, flash: null }
    const peek = moment<true>((v) => (shown.peek = v))
    const flash = moment<'added' | 'removed'>((v) => (shown.flash = v))
    flash.show('added', FLASH_MS)
    // two tracks back right away: the badge was about the old track, the new one peeks
    flash.hide()
    peek.show(true, PEEK_MS)
    vi.advanceTimersByTime(PEEK_MS)
    expect(shown).toEqual({ peek: null, flash: null })
    // and the other way round: a like while the new track still peeks
    peek.show(true, PEEK_MS)
    flash.show('added', FLASH_MS)
    vi.advanceTimersByTime(FLASH_MS)
    expect(shown).toEqual({ peek: true, flash: null })
    vi.advanceTimersByTime(PEEK_MS)
    expect(shown).toEqual({ peek: null, flash: null })
  })
})

describe('island geometry', () => {
  test('every shape fits inside the fixed island window', () => {
    for (const shape of Object.values(SHAPES)) {
      expect(shape.w).toBeLessThanOrEqual(WINDOW.w)
      expect(shape.h + 8).toBeLessThanOrEqual(WINDOW.h)
    }
  })

  test('hit rect is centred horizontally with a small comfort margin', () => {
    expect(hitRect('compact')).toEqual({ x: 136, y: 4, w: 208, h: 44 })
    expect(hitRect('expanded')).toEqual({ x: 26, y: 4, w: 428, h: SHAPES.expanded.h + 8 })
  })

  test('compact and peek pass clicks through in hover mode but not in click mode', () => {
    expect(isInteractive('compact', 'hover')).toBe(false)
    expect(isInteractive('peek', 'hover')).toBe(false)
    expect(isInteractive('compact', 'click')).toBe(true)
    expect(isInteractive('expanded', 'hover')).toBe(true)
  })
})

describe('volume HUD', () => {
  test('a slightly wider pill that passes clicks through like the compact one', () => {
    expect(SHAPES.volume.w).toBeGreaterThan(SHAPES.compact.w)
    expect(SHAPES.volume.h).toBe(SHAPES.compact.h)
    expect(isInteractive('volume', 'hover')).toBe(false)
    expect(VOLUME_HUD_MS).toBe(1500)
  })

  test('shows when the volume or mute changes, not on the first snapshot', () => {
    expect(volumeChanged(null, { volume: 0.5, muted: false })).toBe(false)
    expect(volumeChanged({ volume: 0.5, muted: false }, { volume: 0.5, muted: false })).toBe(false)
    expect(volumeChanged({ volume: 0.5, muted: false }, { volume: 0.55, muted: false })).toBe(true)
    expect(volumeChanged({ volume: 0.5, muted: false }, { volume: 0.5, muted: true })).toBe(true)
  })

  test('expanded beats peek beats volume beats compact; nothing to show without a track', () => {
    expect(pickShape({ hasTrack: true, expanded: true, peek: true, volume: true })).toBe('expanded')
    expect(pickShape({ hasTrack: true, expanded: false, peek: true, volume: true })).toBe('peek')
    expect(pickShape({ hasTrack: true, expanded: false, peek: false, volume: true })).toBe('volume')
    expect(pickShape({ hasTrack: true, expanded: false, peek: false, volume: false })).toBe('compact')
    expect(pickShape({ hasTrack: false, expanded: true, peek: true, volume: true })).toBe('compact')
  })
})

describe('COLLAPSE_DELAY', () => {
  test('collapses a tenth of a second after the cursor leaves', () => {
    expect(COLLAPSE_DELAY).toBe(100)
  })
})
