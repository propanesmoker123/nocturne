import { useSettings } from '../lib/settings'
import { invoke, isTauri } from '../lib/tauri'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'

/** Keeps Rust-side preferences in sync and broadcasts the playing track to the VK status. */
export function startSystemSync() {
  if (!isTauri()) return
  const applyTray = () => void invoke('set_close_to_tray', { enabled: useSettings.getState().closeToTray }).catch(() => {})
  applyTray()

  let broadcastKey = ''
  useSettings.subscribe((s, prev) => {
    if (s.closeToTray !== prev.closeToTray) applyTray()
    if (prev.broadcastStatus && !s.broadcastStatus) {
      broadcastKey = ''
      void vk.setBroadcast(null).catch(() => {})
    }
  })

  usePlayer.subscribe((s) => {
    if (!useSettings.getState().broadcastStatus || !s.isPlaying || !s.current) return
    if (s.current.key === broadcastKey) return
    broadcastKey = s.current.key
    void vk.setBroadcast(s.current).catch(() => {})
  })
}
