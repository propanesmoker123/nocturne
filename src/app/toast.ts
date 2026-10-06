import { create } from 'zustand'

export type ToastIcon = 'added' | 'removed' | 'error' | 'info' | 'queue'

export interface Toast {
  id: number
  text: string
  icon: ToastIcon
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  push(t: Omit<Toast, 'id'>): void
  dismiss(id: number): void
}

let seq = 0

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = ++seq
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] })
    setTimeout(() => get().dismiss(id), t.action ? 5000 : 2600)
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) })
  },
}))

export const toast = (text: string, icon: ToastIcon = 'info', action?: Toast['action']) => useToasts.getState().push({ text, icon, action })
