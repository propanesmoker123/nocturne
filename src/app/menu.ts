import type { ReactNode } from 'react'
import { create } from 'zustand'

export interface MenuItem {
  label?: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onSelect?: () => void
  /** Lazily loaded submenu (e.g. the user's playlists). */
  submenu?: () => Promise<MenuItem[]>
}

interface MenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  show(x: number, y: number, items: MenuItem[]): void
  close(): void
}

export const useMenu = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false }),
}))

/** Opens a context menu at the pointer (or under the clicked button). */
export function showMenu(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; type?: string }, items: MenuItem[]) {
  let x = e.clientX
  let y = e.clientY
  const el = e.currentTarget as HTMLElement | null
  if (e.type === 'click' && el?.getBoundingClientRect) {
    const r = el.getBoundingClientRect()
    x = r.left
    y = r.bottom + 6
  }
  useMenu.getState().show(x, y, items)
}
