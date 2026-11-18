import { create } from 'zustand'
import { EV } from '../lib/events'
import { invoke, isTauri, listen } from '../lib/tauri'
import { clearVkCache, hydrateVkSnapshots, markVkSnapshotsStale, readVkSessionSnapshot, writeVkSessionSnapshot } from '../lib/warmCache'
import * as vk from '../vk/api'
import type { User } from '../vk/models'
import { queryClient } from './queryClient'

type Phase = 'pending' | 'none' | 'ready'

interface SessionState {
  phase: Phase
  user: User | null
  loggingIn: boolean
  /** VK has not handed a token for a while (it asked to wait, or no network); still retrying. */
  busy: boolean
  login(): Promise<void>
  /** Forgets VK cookies left by a half-finished login and opens the login page again. */
  resetLogin(): Promise<void>
  logout(): Promise<void>
}

let liveReadyConfirmed = false

export const useSession = create<SessionState>((set) => ({
  phase: 'pending',
  user: null,
  loggingIn: false,
  busy: false,
  async login() {
    set({ loggingIn: true })
    try {
      await invoke('session_login')
    } catch {
      set({ loggingIn: false })
    }
  },
  async resetLogin() {
    set({ loggingIn: true })
    try {
      await invoke('session_logout')
      await invoke('session_login')
    } catch {
      set({ loggingIn: false })
    }
  },
  async logout() {
    liveReadyConfirmed = false
    if (isTauri()) {
      clearVkCache()
      await invoke('session_logout').catch(() => {})
    }
    queryClient.clear()
    set({ phase: 'none', user: null, loggingIn: false })
  },
}))

/** Synchronously restores last signed-in VK snapshot before first React paint so relaunches feel instant. */
export function hydrateVkWarmState(): void {
  if (!isTauri()) return
  const snap = readVkSessionSnapshot()
  if (!snap?.signedIn || snap.userId <= 0) return
  vk.setMeId(snap.userId)
  hydrateVkSnapshots(queryClient)
  if (useSession.getState().phase === 'pending') {
    useSession.setState({ phase: 'ready', user: snap.user })
  }
}

async function becomeReady(userId: number) {
  vk.setMeId(userId)
  useSession.setState({ phase: 'ready', loggingIn: false })
  if (isTauri()) {
    writeVkSessionSnapshot(true, userId, useSession.getState().user)
    if (!liveReadyConfirmed) {
      liveReadyConfirmed = true
      markVkSnapshotsStale(queryClient)
    }
  }
  try {
    const user = await vk.getMe()
    vk.setMeId(user.id)
    useSession.setState({ user })
    if (isTauri()) writeVkSessionSnapshot(true, user.id, user)
  } catch {
    // profile is cosmetic; playback works without it
  }
}

/** Resolves the initial session and follows later login/logout events. */
export async function initSession() {
  if (!isTauri()) {
    await becomeReady(1000)
    return
  }
  void listen<{ userId: number }>(EV.sessionReady, (e) => void becomeReady(e.payload.userId))
  void listen<boolean>(EV.sessionBusy, (e) => useSession.setState({ busy: !!e.payload }))
  void listen(EV.sessionLoggedOut, () => {
    liveReadyConfirmed = false
    clearVkCache()
    if (useSession.getState().phase === 'ready' && !useSession.getState().loggingIn) queryClient.clear()
    useSession.setState({ phase: 'none', user: null })
  })
  const status = await invoke<{ state: Phase; userId?: number }>('session_status')
  if (status.state === 'ready' && status.userId) await becomeReady(status.userId)
  else if (status.state === 'none') {
    liveReadyConfirmed = false
    clearVkCache()
    useSession.setState({ phase: 'none', user: null })
  } else if (useSession.getState().phase !== 'ready') {
    useSession.setState({ phase: status.state })
  }
}
