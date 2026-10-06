import { create } from 'zustand'

export type NowPlayingTab = 'queue' | 'lyrics'

interface UiState {
  nowPlaying: boolean
  tab: NowPlayingTab
  openNowPlaying(tab?: NowPlayingTab): void
  closeNowPlaying(): void
  toggleNowPlaying(tab?: NowPlayingTab): void
}

export const useUi = create<UiState>((set, get) => ({
  nowPlaying: false,
  tab: 'queue',
  openNowPlaying: (tab) => set({ nowPlaying: true, tab: tab ?? get().tab }),
  closeNowPlaying: () => set({ nowPlaying: false }),
  toggleNowPlaying: (tab) => {
    const { nowPlaying, tab: cur } = get()
    if (nowPlaying && (!tab || tab === cur)) set({ nowPlaying: false })
    else set({ nowPlaying: true, tab: tab ?? cur })
  },
}))
