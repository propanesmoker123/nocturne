import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setMainWindowVisible, startWindowVisibility, useWindowVisibility } from './windowVisibility'

const native = vi.hoisted(() => ({
  enabled: true,
  callbacks: new Set<(event: { payload: boolean }) => void>(),
  shown: async () => true,
  minimized: async () => false,
  didRead: false,
}))

vi.mock('./tauri', () => ({
  isTauri: () => native.enabled,
  listen: async (_event: string, callback: (event: { payload: boolean }) => void) => {
    native.callbacks.add(callback)
    return () => native.callbacks.delete(callback)
  },
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isVisible: () => { native.didRead = true; return native.shown() },
    isMinimized: () => native.minimized(),
  }),
}))

let page: EventTarget & { hidden: boolean }
let stop: (() => void) | undefined
const visible = () => useWindowVisibility.getState().visible
const nativeVisibility = (shown: boolean) => native.callbacks.forEach((callback) => callback({ payload: shown }))
const documentVisibility = (hidden: boolean) => { page.hidden = hidden; page.dispatchEvent(new Event('visibilitychange')) }
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false })
  vi.stubGlobal('document', page)
  native.enabled = true
  native.callbacks.clear()
  native.shown = async () => true
  native.minimized = async () => false
  native.didRead = false
  setMainWindowVisible(true)
})

afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals() })

describe('wallpaper window visibility', () => {
  test('starts suspended in a hidden document and resumes in a browser', () => {
    native.enabled = false
    page.hidden = true
    stop = startWindowVisibility()
    expect(visible()).toBe(false)
    documentVisibility(false)
    expect(visible()).toBe(true)
    documentVisibility(true)
    expect(visible()).toBe(false)
  })

  test.each(['hidden', 'minimized'])('reads a natively %s window before any visibility event', async (mode) => {
    native.shown = async () => mode !== 'hidden'
    native.minimized = async () => mode === 'minimized'
    stop = startWindowVisibility()
    await vi.waitFor(() => expect(visible()).toBe(false))
    nativeVisibility(true)
    expect(visible()).toBe(true)
  })

  test('a document becoming visible cannot resume a natively hidden window', async () => {
    stop = startWindowVisibility()
    await vi.waitFor(() => expect(native.didRead).toBe(true))
    await nextTurn()
    nativeVisibility(false)
    documentVisibility(true)
    documentVisibility(false)
    expect(visible()).toBe(false)
    nativeVisibility(true)
    expect(visible()).toBe(true)
    documentVisibility(true)
    nativeVisibility(true)
    expect(visible()).toBe(false)
  })

  test('an older startup read cannot overwrite a newer hide event', async () => {
    let resolveShown!: (shown: boolean) => void
    native.shown = () => new Promise<boolean>((resolve) => { resolveShown = resolve })
    stop = startWindowVisibility()
    await vi.waitFor(() => expect(native.didRead).toBe(true))
    nativeVisibility(false)
    resolveShown(true)
    await nextTurn()
    expect(visible()).toBe(false)
  })

  test('disposing removes both listeners and ignores a pending startup read', async () => {
    let resolveShown!: (shown: boolean) => void
    native.shown = () => new Promise<boolean>((resolve) => { resolveShown = resolve })
    stop = startWindowVisibility()
    await vi.waitFor(() => expect(native.didRead).toBe(true))
    stop()
    setMainWindowVisible(false)
    nativeVisibility(true)
    documentVisibility(true)
    documentVisibility(false)
    resolveShown(true)
    await nextTurn()
    expect(visible()).toBe(false)
    expect(native.callbacks.size).toBe(0)
  })
})
