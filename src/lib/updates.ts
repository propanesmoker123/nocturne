import { create } from 'zustand'
import { journal } from './journal'
import { isTauri } from './tauri'

/** A new version shows up within half an hour while the app runs (latest.json is a tiny static file). */
export const CHECK_EVERY_MS = 30 * 60_000
/** Bringing the window back checks too, unless a check just ran. */
export const ON_RETURN_MS = 5 * 60_000

export function shouldCheck(last: number | null, now: number, gap = CHECK_EVERY_MS): boolean {
  return last === null || now - last >= gap
}

type Phase = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'error'

interface UpdateState {
  phase: Phase
  version?: string
  notes?: string
  progress: number
  error?: string
  /** `gap`: how long since the last check before an automatic one runs again. */
  check(manual?: boolean, gap?: number): Promise<void>
  install(): Promise<void>
}

type Pending = { downloadAndInstall(cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void> }
let pending: Pending | null = null
let lastCheck: number | null = null

export const useUpdates = create<UpdateState>((set, get) => ({
  phase: 'idle',
  progress: 0,
  async check(manual = false, gap = CHECK_EVERY_MS) {
    if (!isTauri() || get().phase === 'downloading') return
    // a found update stays on screen; background checks never flash «checking»
    if (!manual && (get().phase === 'available' || !shouldCheck(lastCheck, Date.now(), gap))) return
    lastCheck = Date.now()
    if (manual) set({ phase: 'checking', error: undefined })
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        journal('update', `available: ${update.version}`)
        pending = update as unknown as Pending
        set({ phase: 'available', version: update.version, notes: update.body })
      } else {
        set({ phase: 'none' })
      }
    } catch (e) {
      journal('update', `check failed: ${String(e)}`)
      // No release published yet / offline: stay quiet unless the user asked.
      if (manual) set({ phase: 'error', error: String(e) })
    }
  },
  async install() {
    if (!pending) return
    set({ phase: 'downloading', progress: 0 })
    let total = 0
    let done = 0
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data?.contentLength ?? 0
        if (e.event === 'Progress') {
          done += e.data?.chunkLength ?? 0
          if (total) set({ progress: Math.min(1, done / total) })
        }
      })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e) {
      journal('update', `install failed: ${String(e)}`)
      set({ phase: 'error', error: String(e) })
    }
  },
}))

/** Checks shortly after start, every half hour, and when the window comes back from the tray. */
export function startUpdateChecks() {
  if (!isTauri()) return
  const check = (gap?: number) => void useUpdates.getState().check(false, gap)
  setTimeout(() => check(), 8000)
  setInterval(() => check(), 5 * 60_000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check(ON_RETURN_MS))
  window.addEventListener('focus', () => check(ON_RETURN_MS))
}
