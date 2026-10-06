import { describe, expect, test } from 'vitest'
import { DEFAULT_HOTKEYS } from './hotkeys'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'

describe('mergeSettings', () => {
  test('returns defaults for missing or broken input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings('garbage')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })

  test('keeps valid saved values', () => {
    const s = mergeSettings({ wallpaperDim: 0.3, closeToTray: false, accent: '#30d158' })
    expect(s.wallpaperDim).toBe(0.3)
    expect(s.closeToTray).toBe(false)
    expect(s.accent).toBe('#30d158')
  })

  test('clamps out-of-range numbers and rejects wrong types', () => {
    const s = mergeSettings({ wallpaperDim: 5, wallpaperBlur: -3, closeToTray: 'yes', accent: 'url(evil)' })
    expect(s.wallpaperDim).toBe(0.9)
    expect(s.wallpaperBlur).toBe(0)
    expect(s.closeToTray).toBe(DEFAULT_SETTINGS.closeToTray)
    expect(s.accent).toBe('auto')
  })

  test('merges hotkeys action by action and ignores unknown actions', () => {
    const s = mergeSettings({ hotkeys: { next: 'Ctrl+Shift+N', bogus: 'Ctrl+B', prev: 42 } })
    expect(s.hotkeys.next).toBe('Ctrl+Shift+N')
    expect(s.hotkeys.prev).toBe(DEFAULT_HOTKEYS.prev)
    expect('bogus' in s.hotkeys).toBe(false)
  })

  test('validates the wallpaper config', () => {
    expect(mergeSettings({ wallpaper: { kind: 'preset', preset: 'ocean' } }).wallpaper).toEqual({ kind: 'preset', preset: 'ocean' })
    expect(mergeSettings({ wallpaper: { kind: 'preset', preset: 'nope' } }).wallpaper).toEqual(DEFAULT_SETTINGS.wallpaper)
    expect(mergeSettings({ wallpaper: { kind: 'video', src: 'C:/x.mp4' } }).wallpaper).toEqual({ kind: 'video', src: 'C:/x.mp4' })
    expect(mergeSettings({ wallpaper: { kind: 'video' } }).wallpaper).toEqual(DEFAULT_SETTINGS.wallpaper)
  })

  test('keeps a saved island position and lock, rejects junk', () => {
    const s = mergeSettings({ island: { position: { x: -1500, y: 40 }, locked: true } })
    expect(s.island.position).toEqual({ x: -1500, y: 40 })
    expect(s.island.locked).toBe(true)
    expect(mergeSettings({ island: { position: { x: 'a', y: 2 } } }).island.position).toBeNull()
    expect(mergeSettings({ island: { position: 7 } }).island.position).toBeNull()
    expect(mergeSettings({}).island.locked).toBe(false)
  })

  test('merges island options', () => {
    const s = mergeSettings({ island: { expandOn: 'click', monitor: 'DISPLAY2', enabled: 'no' } })
    expect(s.island.expandOn).toBe('click')
    expect(s.island.monitor).toBe('DISPLAY2')
    expect(s.island.enabled).toBe(DEFAULT_SETTINGS.island.enabled)
  })
})
