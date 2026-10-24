import { create } from 'zustand'
import { EV } from './events'
import { isTauri, listen } from './tauri'

export const useWindowVisibility = create(() => ({ visible: true }))
let nativeVisible = true
let revision = 0

const publish = () => useWindowVisibility.setState({ visible: nativeVisible && !document.hidden })

export function setMainWindowVisible(visible: boolean) {
  revision++
  nativeVisible = visible
  publish()
}

/** WebView2 does not reliably update document.hidden when its parent is hidden to the tray. */
export function startWindowVisibility(): () => void {
  let disposed = false
  let off: (() => void) | undefined
  document.addEventListener('visibilitychange', publish)
  publish()
  if (isTauri()) void listen<boolean>(EV.windowVisibility, ({ payload }) => setMainWindowVisible(payload)).then(async (unlisten) => {
    if (disposed) { unlisten(); return }
    off = unlisten
    const beforeRead = revision
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const window = getCurrentWindow()
    const [shown, minimized] = await Promise.all([window.isVisible(), window.isMinimized()])
    if (!disposed && beforeRead === revision) setMainWindowVisible(shown && !minimized)
  }).catch(() => {})
  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', publish)
    off?.()
  }
}
