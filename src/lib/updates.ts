import { create } from 'zustand'
import { journal } from './journal'
import { isTauri } from './tauri'

export const CHECK_EVERY_MS = 6 * 3600_000

export function shouldCheck(last: number | null, now: number): boolean {
  return last === null || now - last >= CHECK_EVERY_MS
}

type Phase = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'error'

interface UpdateState {
  phase: Phase
  version?: string
  notes?: string
  progress: number
  error?: string
  check(manual?: boolean): Promise<void>
  install(): Promise<void>
}

type Pending = { downloadAndInstall(cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void> }
let pending: Pending | null = null
let lastCheck: number | null = null

export const useUpdates = create<UpdateState>((set, get) => ({
  phase: 'idle',
  progress: 0,
  async check(manual = false) {
    if (!isTauri() || get().phase === 'downloading') return
    if (!manual && !shouldCheck(lastCheck, Date.now())) return
    lastCheck = Date.now()
    set({ phase: 'checking', error: undefined })
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
      set({ phase: manual ? 'error' : 'idle', error: String(e) })
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

/** Checks shortly after start and then every few hours. */
export function startUpdateChecks() {
  if (!isTauri()) return
  setTimeout(() => void useUpdates.getState().check(), 8000)
  setInterval(() => void useUpdates.getState().check(), 30 * 60_000)
}
