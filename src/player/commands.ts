import type { PlayerCommand } from '../lib/events'
import { handleSpotifyCommand } from '../spotify/runtime'
import { usePlayer } from './store'

export interface BridgeActions {
  toggleLike(): void
  showWindow(): void
}

/** One dispatch path for tray, media keys, global shortcuts and the island. */
export function runCommand(cmd: PlayerCommand, actions: BridgeActions) {
  if (handleSpotifyCommand(cmd)) return
  const p = usePlayer.getState()
  switch (cmd.type) {
    case 'toggle': return p.toggle()
    case 'play': return p.play()
    case 'pause': return p.pause()
    case 'next': return p.next(true)
    case 'prev': return p.prev()
    case 'toggleShuffle': return p.toggleShuffle()
    case 'cycleRepeat': return p.cycleRepeat()
    case 'toggleMute': return p.toggleMute()
    case 'toggleLike': return actions.toggleLike()
    case 'showWindow': return actions.showWindow()
    case 'seek': return p.seek(cmd.value)
    case 'seekBy': return p.seekBy(cmd.value)
    case 'volume': return p.setVolume(cmd.value)
    case 'volumeBy': return p.nudgeVolume(cmd.value)
  }
}
