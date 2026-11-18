import { create } from 'zustand'
import { queryClient } from '../app/queryClient'
import { EV } from '../lib/events'
import { invoke, isTauri, listen } from '../lib/tauri'
import { clearScCache, hydrateScSnapshots, markScSnapshotsStale, readScSessionSnapshot, writeScSessionSnapshot } from '../lib/warmCache'
import { serviceOf, type Track } from '../vk/models'
import { setScMeId } from './api'
import type { ScUser } from './normalize'

/** `checking`: a key from the last run is being tried. The key itself never reaches the UI. */
export type ScPhase = 'checking' | 'signed-in' | 'signed-out'

/** What an unplayable SoundCloud row says: its account is wanted, or the track plays only on its site. */
export function unplayableHint(t: Track, phase: ScPhase): string | undefined {
  if (t.playable || serviceOf(t) !== 'sc') return undefined
  return phase === 'signed-out' ? 'Войдите в SoundCloud, чтобы слушать' : 'Доступно только в SoundCloud'
}

interface ScSessionState {
  phase: ScPhase
  user: ScUser | null
  signingIn: boolean
  error: string | null
  login(): Promise<void>
  logout(): Promise<void>
}

/** A browser build without Tauri pretends to be signed in to the mock. */
const MOCK_USER: ScUser = { id: 7, name: 'listener', avatar: null, permalink: 'https://soundcloud.com/listener' }

let liveScReadyConfirmed = false

export const useScSession = create<ScSessionState>((set) => ({
  phase: 'checking',
  user: null,
  signingIn: false,
  error: null,
  async login() {
    set({ signingIn: true, error: null })
    if (!isTauri()) return applyStatus({ state: 'signed-in', user: MOCK_USER })
    try {
      await invoke('sc_login')
    } catch {
      set({ signingIn: false })
    }
  },
  async logout() {
    liveScReadyConfirmed = false
    if (isTauri()) {
      clearScCache()
      await invoke('sc_logout').catch(() => {})
    }
    applyStatus({ state: 'signed-out' })
  },
}))

/** Synchronously restores last signed-in SoundCloud snapshot before first React paint so relaunches feel instant. */
export function hydrateScWarmState(): void {
  if (!isTauri()) return
  const snap = readScSessionSnapshot()
  if (!snap?.signedIn) return
  if (snap.user?.id) setScMeId(snap.user.id)
  hydrateScSnapshots(queryClient)
  if (useScSession.getState().phase === 'checking') {
    useScSession.setState({ phase: 'signed-in', user: snap.user })
  }
}

export function applyStatus(s: { state: ScPhase; user?: ScUser | null }) {
  const prev = useScSession.getState()
  if (s.state === 'signed-in') {
    const finalUser = s.user ?? prev.user
    if (finalUser) setScMeId(finalUser.id)
    if (isTauri()) {
      writeScSessionSnapshot(true, finalUser ?? null)
      if (!liveScReadyConfirmed) {
        liveScReadyConfirmed = true
        markScSnapshotsStale(queryClient)
      }
    }
  }
  // what was read from the account goes with it; VK's data stays
  if (s.state === 'signed-out') {
    liveScReadyConfirmed = false
    if (isTauri()) clearScCache()
    setScMeId(0)
    queryClient.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('sc-') })
  }
  const nextPhase = s.state === 'checking' && isTauri() && prev.phase === 'signed-in' ? 'signed-in' : s.state
  useScSession.setState({
    phase: nextPhase,
    user: s.state === 'signed-out' ? null : (s.user ?? prev.user),
    signingIn: s.state === 'checking' ? prev.signingIn : false,
  })
}

export function applyLoginFailed(p: { message: string; cancelled: boolean }) {
  useScSession.setState({ signingIn: false, error: p.cancelled ? null : p.message || 'Не получилось войти в SoundCloud' })
}

/** Follows the SoundCloud status Rust reports. Never waited for: VK does not wait for SoundCloud. */
export async function initScSession() {
  if (!isTauri()) return applyStatus({ state: 'signed-in', user: MOCK_USER })
  void listen<{ state: ScPhase; user?: ScUser | null }>(EV.scStatus, (e) => applyStatus(e.payload))
  void listen<{ message: string; cancelled: boolean }>(EV.scLoginFailed, (e) => applyLoginFailed(e.payload))
  try {
    applyStatus(await invoke<{ state: ScPhase; user?: ScUser | null }>('sc_status'))
  } catch {
    applyStatus({ state: 'signed-out' })
  }
}
