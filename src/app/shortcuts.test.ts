import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runCommand: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  push: vi.fn(),
}))

vi.mock('../player/commands', () => ({ runCommand: h.runCommand }))
vi.mock('../player/store', () => ({ usePlayer: { getState: () => ({ current: null }) } }))
vi.mock('./library', () => ({ toggleLibrary: vi.fn() }))
vi.mock('./router', () => ({ useRouter: { getState: () => ({ back: h.back, forward: h.forward, push: h.push }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toggleFullscreen: vi.fn() }) } }))

class FakeElement {
  matchesSet: Set<string>
  isContentEditable = false
  constructor(selectors: string[] = []) {
    this.matchesSet = new Set(selectors)
  }
  closest(selector: string) {
    const parts = selector.split(',').map((s) => s.trim())
    return parts.some((p) => this.matchesSet.has(p)) ? this : null
  }
}

beforeEach(() => {
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('Node', FakeElement)
  h.runCommand.mockClear()
  h.back.mockClear()
  h.forward.mockClear()
  h.push.mockClear()
})

import { handleShortcutKeydown, shouldIgnorePlaybackShortcut } from './shortcuts'

function keyEvent(code: string, key: string, target: FakeElement | null, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code,
    key,
    target,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent
}

describe('in-window shortcuts target isolation', () => {
  test('ignores Space and unmodified arrows on interactive controls and inside modal dialogs', () => {
    const cancelBtnInModal = new FakeElement(['button', '[role="dialog"]'])
    const switchEl = new FakeElement(['[role="switch"]'])
    const sliderEl = new FakeElement(['[role="slider"]'])
    const bodyEl = new FakeElement([])

    expect(shouldIgnorePlaybackShortcut(cancelBtnInModal as unknown as EventTarget)).toBe(true)
    expect(shouldIgnorePlaybackShortcut(switchEl as unknown as EventTarget)).toBe(true)
    expect(shouldIgnorePlaybackShortcut(sliderEl as unknown as EventTarget)).toBe(true)
    expect(shouldIgnorePlaybackShortcut(bodyEl as unknown as EventTarget)).toBe(false)

    const modalSpace = keyEvent('Space', ' ', cancelBtnInModal)
    handleShortcutKeydown(modalSpace)
    expect(modalSpace.preventDefault).not.toHaveBeenCalled()
    expect(h.runCommand).not.toHaveBeenCalled()

    const switchSpace = keyEvent('Space', ' ', switchEl)
    handleShortcutKeydown(switchSpace)
    expect(switchSpace.preventDefault).not.toHaveBeenCalled()
    expect(h.runCommand).not.toHaveBeenCalled()

    const sliderArrow = keyEvent('ArrowRight', 'ArrowRight', sliderEl)
    handleShortcutKeydown(sliderArrow)
    expect(sliderArrow.preventDefault).not.toHaveBeenCalled()
    expect(h.runCommand).not.toHaveBeenCalled()

    const bodySpace = keyEvent('Space', ' ', bodyEl)
    handleShortcutKeydown(bodySpace)
    expect(bodySpace.preventDefault).toHaveBeenCalled()
    expect(h.runCommand).toHaveBeenCalledWith({ type: 'toggle' }, expect.any(Object))
  })
})
