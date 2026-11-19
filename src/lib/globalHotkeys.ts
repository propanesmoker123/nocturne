import { create } from 'zustand'
import type { HotkeyAction, HotkeyMap } from './hotkeys'
import { useSettings } from './settings'
import { isTauri } from './tauri'

interface HotkeyStatus {
  failed: HotkeyAction[]
}

/** Which accelerators could not be registered (usually taken by another program). */
export const useHotkeyStatus = create<HotkeyStatus>(() => ({ failed: [] }))

type Handlers = Record<HotkeyAction, () => void>

let applied = ''
let started = false
let draining = false
let latestReq: { map: HotkeyMap; enabled: boolean; handlers: Handlers } | null = null

async function apply(map: HotkeyMap, enabled: boolean, handlers: Handlers) {
  const key = JSON.stringify([map, enabled])
  if (key === applied) return
  applied = key
  const gs = await import('@tauri-apps/plugin-global-shortcut')
  await gs.unregisterAll().catch(() => {})
  if (!enabled) {
    useHotkeyStatus.setState({ failed: [] })
    return
  }
  const failed: HotkeyAction[] = []
  for (const [action, acc] of Object.entries(map) as [HotkeyAction, string][]) {
    if (!acc) continue
    try {
      await gs.register(acc, (e) => {
        if (e.state === 'Pressed') handlers[action]()
      })
    } catch {
      failed.push(action)
    }
  }
  useHotkeyStatus.setState({ failed })
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (latestReq) {
      const next = latestReq
      latestReq = null
      await apply(next.map, next.enabled, next.handlers).catch(() => {})
    }
  } finally {
    draining = false
  }
}

/** Registers the user's global hotkeys and re-registers whenever they change. */
export function startGlobalHotkeys(handlers: Handlers) {
  if (!isTauri() || started) return
  started = true
  const run = () => {
    const s = useSettings.getState()
    latestReq = { map: s.hotkeys, enabled: s.hotkeysEnabled, handlers }
    void drain()
  }
  run()
  useSettings.subscribe((s, prev) => {
    if (s.hotkeys !== prev.hotkeys || s.hotkeysEnabled !== prev.hotkeysEnabled) run()
  })
}
