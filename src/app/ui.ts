import { create } from 'zustand'
import { journal } from '../lib/journal'
import { invoke, isTauri } from '../lib/tauri'

export type NowPlayingTab = 'queue' | 'lyrics'

const TAB_STORAGE_KEY = 'nocturne:np-tab'

function loadInitialTab(): NowPlayingTab {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TAB_STORAGE_KEY) === 'lyrics' ? 'lyrics' : 'queue'
  } catch {
    return 'queue'
  }
}

function persistTab(tab: NowPlayingTab): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    /* ignore storage errors */
  }
}

async function changeFullscreen(next: boolean | null): Promise<boolean | undefined> {
  if (isTauri()) {
    try {
      return await invoke<boolean>('window_fullscreen', { fullscreen: next })
    } catch (e) {
      journal('app', `window_fullscreen error: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }
  if (typeof document === 'undefined') return undefined
  const active = Boolean(document.fullscreenElement)
  try {
    const target = next ?? !active
    if (target && !active) await document.documentElement.requestFullscreen()
    else if (!target && active) await document.exitFullscreen()
  } catch {
    // Read the browser's state below even if the request was rejected.
  }
  return Boolean(document.fullscreenElement)
}

interface UiState {
  nowPlaying: boolean
  tab: NowPlayingTab
  sideOpen: boolean
  fullscreen: boolean
  setTab(tab: NowPlayingTab): void
  setSideOpen(open: boolean): void
  openNowPlaying(tab?: NowPlayingTab): void
  closeNowPlaying(): void
  toggleNowPlaying(tab?: NowPlayingTab): void
  setFullscreen(next: boolean): Promise<void>
  toggleFullscreen(): Promise<void>
}

export const useUi = create<UiState>((set, get) => ({
  nowPlaying: false,
  tab: loadInitialTab(),
  sideOpen: false,
  fullscreen: false,
  setTab: (tab) => {
    persistTab(tab)
    set({ tab })
  },
  setSideOpen: (sideOpen) => set({ sideOpen }),
  openNowPlaying: (tab) => {
    const nextTab = tab ?? get().tab
    if (tab) persistTab(nextTab)
    set({ nowPlaying: true, tab: nextTab, sideOpen: Boolean(tab) })
  },
  closeNowPlaying: () => set({ nowPlaying: false, sideOpen: false }),
  toggleNowPlaying: (tab) => {
    const { nowPlaying, tab: cur } = get()
    if (nowPlaying && (!tab || tab === cur)) set({ nowPlaying: false, sideOpen: false })
    else {
      const nextTab = tab ?? cur
      if (tab) persistTab(nextTab)
      set({ nowPlaying: true, tab: nextTab, sideOpen: Boolean(tab) })
    }
  },
  async setFullscreen(next) {
    const active = await changeFullscreen(next)
    if (active !== undefined) set({ fullscreen: active })
  },
  async toggleFullscreen() {
    const active = await changeFullscreen(null)
    if (active !== undefined) set({ fullscreen: active })
  },
}))
