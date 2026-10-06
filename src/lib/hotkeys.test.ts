import { describe, expect, test } from 'vitest'
import { DEFAULT_HOTKEYS, eventToAccelerator, findDuplicateHotkeys, prettyAccelerator } from './hotkeys'

const ev = (key: string, code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
})

describe('eventToAccelerator', () => {
  test('maps arrows with modifiers', () => {
    expect(eventToAccelerator(ev('ArrowRight', 'ArrowRight', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+Right')
  })

  test('ignores modifier-only presses', () => {
    expect(eventToAccelerator(ev('Control', 'ControlLeft', { ctrl: true }))).toBeNull()
    expect(eventToAccelerator(ev('Shift', 'ShiftRight', { shift: true }))).toBeNull()
  })

  test('uses the physical key code for letters and digits (layout independent)', () => {
    expect(eventToAccelerator(ev('l', 'KeyL', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+L')
    expect(eventToAccelerator(ev('д', 'KeyL', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+L')
    expect(eventToAccelerator(ev('5', 'Digit5', { ctrl: true }))).toBe('Ctrl+5')
  })

  test('orders modifiers canonically: Ctrl, Alt, Shift, Super', () => {
    expect(eventToAccelerator(ev('ArrowLeft', 'ArrowLeft', { shift: true, alt: true, ctrl: true }))).toBe('Ctrl+Alt+Shift+Left')
    expect(eventToAccelerator(ev('m', 'KeyM', { meta: true, alt: true }))).toBe('Alt+Super+M')
  })

  test('requires a modifier except for function and media keys', () => {
    expect(eventToAccelerator(ev('l', 'KeyL'))).toBeNull()
    expect(eventToAccelerator(ev('F9', 'F9'))).toBe('F9')
    expect(eventToAccelerator(ev('MediaPlayPause', 'MediaPlayPause'))).toBe('MediaPlayPause')
  })

  test('maps space and punctuation to accelerator names', () => {
    expect(eventToAccelerator(ev(' ', 'Space', { ctrl: true, alt: true }))).toBe('Ctrl+Alt+Space')
    expect(eventToAccelerator(ev('.', 'Period', { ctrl: true }))).toBe('Ctrl+Period')
    expect(eventToAccelerator(ev('=', 'Equal', { ctrl: true }))).toBe('Ctrl+Equal')
  })
})

describe('prettyAccelerator', () => {
  test('renders arrows as symbols and Super as Win', () => {
    expect(prettyAccelerator('Ctrl+Alt+Right')).toBe('Ctrl Alt →')
    expect(prettyAccelerator('Alt+Super+Up')).toBe('Alt Win ↑')
  })
})

describe('DEFAULT_HOTKEYS', () => {
  test('match the spec', () => {
    expect(DEFAULT_HOTKEYS).toEqual({
      playPause: 'Ctrl+Alt+Space',
      next: 'Ctrl+Alt+Right',
      prev: 'Ctrl+Alt+Left',
      volUp: 'Ctrl+Alt+Up',
      volDown: 'Ctrl+Alt+Down',
      toggleLike: 'Ctrl+Alt+L',
      seekFwd: 'Ctrl+Alt+Shift+Right',
      seekBack: 'Ctrl+Alt+Shift+Left',
      shuffle: 'Ctrl+Alt+S',
      repeat: 'Ctrl+Alt+R',
      toggleIsland: 'Ctrl+Alt+I',
      toggleWindow: 'Ctrl+Alt+M',
    })
  })

  test('have no duplicates', () => {
    expect(findDuplicateHotkeys(DEFAULT_HOTKEYS)).toEqual([])
  })

  test('duplicate detection reports every action sharing an accelerator', () => {
    expect(findDuplicateHotkeys({ ...DEFAULT_HOTKEYS, shuffle: 'Ctrl+Alt+R' }).sort()).toEqual(['repeat', 'shuffle'])
  })

  test('empty bindings are not duplicates', () => {
    expect(findDuplicateHotkeys({ ...DEFAULT_HOTKEYS, shuffle: '', repeat: '' })).toEqual([])
  })
})
