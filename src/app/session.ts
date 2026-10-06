import { create } from 'zustand'
import { EV } from '../lib/events'
import { invoke, isTauri, listen } from '../lib/tauri'
import * as vk from '../vk/api'
import type { User } from '../vk/models'
import { queryClient } from './queryClient'

type Phase = 'pending' | 'none' | 'ready'

interface SessionState {
  phase: Phase
  user: User | null
  loggingIn: boolean
  login(): Promise<void>
  /** Forgets VK cookies left by a half-finished login and opens the login page again. */
  resetLogin(): Promise<void>
  logout(): Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  phase: 'pending',
  user: null,
  loggingIn: false,
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
    if (isTauri()) await invoke('session_logout').catch(() => {})
    queryClient.clear()
    set({ phase: 'none', user: null, loggingIn: false })
  },
}))

async function becomeReady(userId: number) {
  vk.setMeId(userId)
  useSession.setState({ phase: 'ready', loggingIn: false })
  try {
    const user = await vk.getMe()
    vk.setMeId(user.id)
    useSession.setState({ user })
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
  void listen(EV.sessionLoggedOut, () => {
    if (useSession.getState().phase === 'ready' && !useSession.getState().loggingIn) queryClient.clear()
    useSession.setState({ phase: 'none', user: null })
  })
  const status = await invoke<{ state: Phase; userId?: number }>('session_status')
  if (status.state === 'ready' && status.userId) await becomeReady(status.userId)
  else useSession.setState({ phase: status.state })
}
