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

/** Registers the user's global hotkeys and re-registers whenever they change. */
export function startGlobalHotkeys(handlers: Handlers) {
  if (!isTauri()) return
  const run = () => {
    const s = useSettings.getState()
    void apply(s.hotkeys, s.hotkeysEnabled, handlers)
  }
  run()
  useSettings.subscribe((s, prev) => {
    if (s.hotkeys !== prev.hotkeys || s.hotkeysEnabled !== prev.hotkeysEnabled) run()
  })
}
