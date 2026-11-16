import { create } from 'zustand'

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

interface UiState {
  nowPlaying: boolean
  tab: NowPlayingTab
  setTab(tab: NowPlayingTab): void
  openNowPlaying(tab?: NowPlayingTab): void
  closeNowPlaying(): void
  toggleNowPlaying(tab?: NowPlayingTab): void
}

export const useUi = create<UiState>((set, get) => ({
  nowPlaying: false,
  tab: loadInitialTab(),
  setTab: (tab) => {
    persistTab(tab)
    set({ tab })
  },
  openNowPlaying: (tab) => {
    const nextTab = tab ?? get().tab
    if (tab) persistTab(nextTab)
    set({ nowPlaying: true, tab: nextTab })
  },
  closeNowPlaying: () => set({ nowPlaying: false }),
  toggleNowPlaying: (tab) => {
    const { nowPlaying, tab: cur } = get()
    if (nowPlaying && (!tab || tab === cur)) set({ nowPlaying: false })
    else {
      const nextTab = tab ?? cur
      if (tab) persistTab(nextTab)
      set({ nowPlaying: true, tab: nextTab })
    }
  },
}))
