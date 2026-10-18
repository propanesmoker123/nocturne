import { create } from 'zustand'
import type { Playlist, Track } from '../vk/models'

export type SheetRequest =
  | { kind: 'playlist-create'; addTracks?: Track[] }
  | { kind: 'playlist-edit'; playlist: Playlist }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'captcha'; img: string; resolve: (key: string | null) => void }
  | { kind: 'send-track'; track: Track }
  | { kind: 'link-device' }
  | { kind: 'album-create'; addTracks?: Track[] }
  | { kind: 'album-rename'; id: string }
  | { kind: 'album-share'; id: string }
  | { kind: 'album-join' }
  /** «Что нового»: release notes as a short list, with an optional action (e.g. «Обновить»). */
  | { kind: 'notes'; title: string; notes: string; action?: { label: string; run: () => void } }

interface SheetState {
  sheet: SheetRequest | null
  open(s: SheetRequest): void
  close(): void
}

export const useSheet = create<SheetState>((set, get) => ({
  sheet: null,
  open: (sheet) => {
    // a captcha pushed aside is answered «no», or its VK request would wait for ever
    const cur = get().sheet
    if (cur?.kind === 'captcha' && cur !== sheet) cur.resolve(null)
    set({ sheet })
  },
  close: () => {
    const cur = get().sheet
    if (cur?.kind === 'captcha') cur.resolve(null)
    set({ sheet: null })
  },
}))

/** Shows the captcha sheet and resolves with what the user typed (or null). */
export function askCaptcha(img: string): Promise<string | null> {
  return new Promise((resolve) => {
    useSheet.getState().open({
      kind: 'captcha',
      img,
      resolve: (key) => {
        useSheet.setState({ sheet: null })
        resolve(key)
      },
    })
  })
}
