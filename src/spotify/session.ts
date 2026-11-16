import { create } from 'zustand'
import { queryClient } from '../app/queryClient'
import { loadJSON, saveJSON } from '../lib/persist'
import { invoke, isTauri, listen } from '../lib/tauri'
import { getMe, type SpotifyUser } from './api'
import {
  clearSpotifyCache,
  hydrateSpotifySnapshots,
  readSpotifySessionSnapshot,
  writeSpotifySessionSnapshot,
} from './cache'
import { DEFAULT_SPOTIFY_RUNTIME, readSpotifyStatus, SPOTIFY_FILTER_KEY } from './runtime'

export type SpotifyPhase = 'checking' | 'signed-in' | 'signed-out'

interface SpotifySessionState {
  phase: SpotifyPhase
  user: SpotifyUser | null
  filterEnabled: boolean
  loginWaiting: boolean
  signingIn: boolean
  error: string | null
  regionBlocked: boolean
  drm: boolean | null
  patchedCount: number
  startLogin(): Promise<void>
  finishLogin(): Promise<void>
  cancelLogin(): Promise<void>
  toggleFilter(): Promise<void>
  refresh(init?: boolean): Promise<void>
  logout(): Promise<void>
}

const MOCK_USER: SpotifyUser = { id: 'spotify_listener', name: 'Spotify Listener' }

export const useSpotifySession = create<SpotifySessionState>((set, get) => ({
  phase: 'checking',
  user: null,
  filterEnabled: DEFAULT_SPOTIFY_RUNTIME.enabled,
  loginWaiting: false,
  signingIn: false,
  error: null,
  regionBlocked: false,
  drm: null,
  patchedCount: 0,

  async refresh(init = false) {
    if (!isTauri()) {
      set({ phase: 'signed-in', user: MOCK_USER })
      return
    }
    try {
      const raw = await invoke<unknown>('spotify_status', init ? { request: { kind: 'init' } } : undefined)
      const st = readSpotifyStatus(raw, get().filterEnabled)
      const regionBlocked = st.phase === 'region'
      let account = st.account
      let user = get().user
      const wasSignedIn = get().phase === 'signed-in'

      if (account === 'in') {
        set({
          phase: 'signed-in',
          user: user ?? { id: 'spotify_user', name: 'Spotify' },
          filterEnabled: st.enabled,
          loginWaiting: st.loginWaiting,
          regionBlocked: false,
          drm: st.drm,
          patchedCount: st.patchedCount,
          error: null,
        })
      }

      if ((st.phase === 'ready' || account === 'in') && account !== 'out') {
        try {
          const me = await getMe()
          if (me) {
            user = me
            account = 'in'
          }
        } catch {
          // Never force account='out' when sp_dc cookie or session is still warming up.
        }
      }

      if (account === 'in') {
        const finalUser = user ?? { id: 'spotify_user', name: 'Spotify' }
        writeSpotifySessionSnapshot(true, finalUser)
        set({
          phase: 'signed-in',
          user: finalUser,
          filterEnabled: st.enabled,
          loginWaiting: st.loginWaiting,
          regionBlocked: false,
          drm: st.drm,
          patchedCount: st.patchedCount,
          error: null,
        })
        if (!wasSignedIn) {
          void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('sp-') })
        }
        if (finalUser.id === 'spotify_user') {
          const retryProfile = () => {
            if (get().phase === 'signed-in' && get().user?.id === 'spotify_user') {
              void getMe().then((me) => {
                if (me && me.id !== 'spotify_user') {
                  writeSpotifySessionSnapshot(true, me)
                  set({ user: me })
                }
              }).catch(() => {})
            }
          }
          setTimeout(retryProfile, 1800)
          setTimeout(retryProfile, 4500)
        }
      } else if (account === 'out' || regionBlocked) {
        clearSpotifyCache()
        queryClient.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('sp-') })
        set({
          phase: 'signed-out',
          user: null,
          filterEnabled: st.enabled,
          loginWaiting: st.loginWaiting,
          regionBlocked,
          drm: st.drm,
          patchedCount: st.patchedCount,
        })
      } else {
        set({
          phase: get().phase === 'checking' ? 'signed-out' : get().phase,
          filterEnabled: st.enabled,
          loginWaiting: st.loginWaiting,
          regionBlocked,
          drm: st.drm,
          patchedCount: st.patchedCount,
        })
      }
    } catch (e) {
      set({
        phase: get().phase === 'checking' ? 'signed-out' : get().phase,
        error: typeof e === 'string' ? e : e instanceof Error ? e.message : null,
      })
    }
  },

  async startLogin() {
    if (!isTauri()) {
      set({ phase: 'signed-in', user: MOCK_USER })
      return
    }
    set({ signingIn: true, error: null })
    try {
      await invoke('spotify_login_start')
      set({ signingIn: false, loginWaiting: true })
    } catch (e) {
      set({ signingIn: false, error: typeof e === 'string' ? e : 'Не удалось запустить Chrome для входа в Spotify' })
    }
  },

  async finishLogin() {
    if (!isTauri()) return
    set({ signingIn: true, error: null })
    try {
      await invoke('spotify_login_finish')
      set({ signingIn: false, loginWaiting: false })
      await get().refresh(true)
    } catch (e) {
      set({ signingIn: false, error: typeof e === 'string' ? e : 'Вход пока не завершён в окне Chrome' })
    }
  },

  async cancelLogin() {
    if (!isTauri()) return
    await invoke('spotify_login_cancel').catch(() => {})
    set({ signingIn: false, loginWaiting: false, error: null })
  },

  async toggleFilter() {
    const next = !get().filterEnabled
    set({ filterEnabled: next })
    void saveJSON(SPOTIFY_FILTER_KEY, next)
    if (isTauri()) {
      await invoke('spotify_filter', { enabled: next }).catch(() => {})
    }
  },

  async logout() {
    if (isTauri()) {
      await invoke('spotify_status', { request: { kind: 'logout' } }).catch(() => {})
    }
    clearSpotifyCache()
    queryClient.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('sp-') })
    set({ phase: 'signed-out', user: null, loginWaiting: false, error: null })
  },
}))

/** Synchronously restores last signed-in Spotify snapshot before first React paint so relaunches feel instant. */
export function hydrateSpotifyWarmState(): void {
  if (!isTauri()) return
  const snap = readSpotifySessionSnapshot()
  if (!snap?.signedIn) return
  hydrateSpotifySnapshots(queryClient)
  const cur = useSpotifySession.getState()
  if (cur.phase === 'checking') {
    useSpotifySession.setState({
      phase: 'signed-in',
      user: snap.user ?? { id: 'spotify_user', name: 'Spotify' },
    })
  }
}

let initialized = false

export async function initSpotifySession() {
  if (initialized) return
  initialized = true
  if (!isTauri()) {
    useSpotifySession.setState({ phase: 'signed-in', user: MOCK_USER })
    return
  }
  hydrateSpotifyWarmState()
  const savedFilter = await loadJSON<boolean>(SPOTIFY_FILTER_KEY)
  const enabled = typeof savedFilter === 'boolean' ? savedFilter : true
  useSpotifySession.setState({ filterEnabled: enabled })
  await invoke('spotify_filter', { enabled }).catch(() => {})

  void listen('spotify:page', () => {
    void useSpotifySession.getState().refresh(false)
  })
  void listen('spotify:external-login', () => {
    void useSpotifySession.getState().startLogin()
  })

  await useSpotifySession.getState().refresh(true)
}
