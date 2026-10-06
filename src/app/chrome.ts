import { create } from 'zustand'

/** Navigation-bar state driven by the page scroller (iOS large title → inline title). */
interface ChromeState {
  title: string
  scrolled: boolean
  setTitle(t: string): void
  setScrolled(v: boolean): void
}

export const useChrome = create<ChromeState>((set) => ({
  title: '',
  scrolled: false,
  setTitle: (title) => set({ title }),
  setScrolled: (scrolled) => set({ scrolled }),
}))
