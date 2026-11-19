import { usePlayer } from '../player/store'
import { toggleLibrary } from './library'
import { useRouter } from './router'
import { useSheet } from './sheetStore'
import { useUi } from './ui'
import { runCommand } from '../player/commands'
import type { PlayerCommand } from '../lib/events'

const command = (cmd: PlayerCommand) => runCommand(cmd, { toggleLike: () => { void toggleLibrary(usePlayer.getState().current) }, showWindow() {} })

const isTyping = (t: EventTarget | null) => {
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null
  if (!el) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}

/** True when focus sits on an interactive widget (button, switch, tab, slider) or inside an open modal/menu. */
export const shouldIgnorePlaybackShortcut = (t: EventTarget | null) => {
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null
  if (!el) return false
  if (el.closest('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')) return true
  return Boolean(
    el.closest(
      'button, a[href], summary, [role="button"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [role="menuitem"]',
    ),
  )
}

/** Handle an in-window keydown event; returns true if a shortcut consumed it. */
export function handleShortcutKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  if (e.key === 'F11') {
    e.preventDefault()
    void useUi.getState().toggleFullscreen()
    return
  }
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && !e.altKey && e.code === 'KeyF') {
    if (useSheet.getState().sheet) return
    e.preventDefault()
    if (useUi.getState().nowPlaying) useUi.getState().closeNowPlaying?.()
    document.getElementById('global-search')?.focus()
    return
  }
  if (ctrl && e.code === 'Comma') {
    if (useSheet.getState().sheet) return
    e.preventDefault()
    if (useUi.getState().nowPlaying) useUi.getState().closeNowPlaying?.()
    useRouter.getState().push({ name: 'settings' })
    return
  }
  if (isTyping(e.target)) return
  const targetEl = e.target instanceof Element ? e.target : null
  const inModal = Boolean(targetEl?.closest('[role="dialog"], [aria-modal="true"]'))
  if (inModal) return
  if (e.altKey && e.key === 'ArrowLeft') return useRouter.getState().back()
  if (e.altKey && e.key === 'ArrowRight') return useRouter.getState().forward()
  const ignoreInteractive = shouldIgnorePlaybackShortcut(e.target)
  if (e.code === 'Space' && !ctrl && !e.altKey) {
    if (ignoreInteractive) return
    e.preventDefault()
    command({ type: 'toggle' })
    return
  }
  if (ctrl && e.code === 'KeyL') {
    e.preventDefault()
    command({ type: 'toggleLike' })
    return
  }
  switch (e.key) {
    case 'ArrowRight':
      if (!ctrl && ignoreInteractive) return
      e.preventDefault()
      return command(ctrl ? { type: 'next' } : { type: 'seekBy', value: 5 })
    case 'ArrowLeft':
      if (!ctrl && ignoreInteractive) return
      e.preventDefault()
      return command(ctrl ? { type: 'prev' } : { type: 'seekBy', value: -5 })
    case 'ArrowUp':
      if (ctrl) {
        e.preventDefault()
        command({ type: 'volumeBy', value: 0.05 })
      }
      return
    case 'ArrowDown':
      if (ctrl) {
        e.preventDefault()
        command({ type: 'volumeBy', value: -0.05 })
      }
      return
  }
}

/** In-window keyboard shortcuts (global ones are registered separately). */
export function installShortcuts() {
  window.addEventListener('keydown', handleShortcutKeydown)
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) useRouter.getState().back()
    if (e.button === 4) useRouter.getState().forward()
  })
}
