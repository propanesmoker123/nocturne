import { usePlayer } from '../player/store'
import { toggleLibrary } from './library'
import { useRouter } from './router'

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/** In-window keyboard shortcuts (global ones are registered separately). */
export function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return
    const p = usePlayer.getState()
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.code === 'KeyF') {
      e.preventDefault()
      document.getElementById('global-search')?.focus()
      return
    }
    if (ctrl && e.code === 'Comma') {
      e.preventDefault()
      useRouter.getState().push({ name: 'settings' })
      return
    }
    if (isTyping(e.target)) return
    if (e.altKey && e.key === 'ArrowLeft') return useRouter.getState().back()
    if (e.altKey && e.key === 'ArrowRight') return useRouter.getState().forward()
    if (e.code === 'Space' && !ctrl && !e.altKey) {
      e.preventDefault()
      p.toggle()
      return
    }
    if (ctrl && e.code === 'KeyL') {
      e.preventDefault()
      void toggleLibrary(p.current)
      return
    }
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        return ctrl ? p.next(true) : p.seekBy(5)
      case 'ArrowLeft':
        e.preventDefault()
        return ctrl ? p.prev() : p.seekBy(-5)
      case 'ArrowUp':
        if (ctrl) {
          e.preventDefault()
          p.nudgeVolume(0.05)
        }
        return
      case 'ArrowDown':
        if (ctrl) {
          e.preventDefault()
          p.nudgeVolume(-0.05)
        }
        return
    }
  })
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) useRouter.getState().back()
    if (e.button === 4) useRouter.getState().forward()
  })
}
