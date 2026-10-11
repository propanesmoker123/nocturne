import { isTauri } from '../lib/tauri'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { useRouter, type Route } from './router'
import { useUi } from './ui'

/** Browser demo only: `#/library`, `#/settings`, `#/playlists`, `#np` (now playing), `#playing` (home with a track on) open a screen directly (for docs screenshots). */
export async function applyDemoHash() {
  if (isTauri()) return
  const hash = location.hash.replace(/^#\/?/, '')
  if (!hash) return
  const routes: Record<string, Route> = {
    library: { name: 'library' },
    settings: { name: 'settings' },
    playlists: { name: 'playlists' },
    friends: { name: 'friends' },
    explore: { name: 'explore' },
  }
  if (routes[hash]) {
    useRouter.getState().push(routes[hash])
    return
  }
  if (hash === 'np' || hash === 'playing') {
    const page = await vk.getTracks(vk.getMeId(), 0, 30)
    if (hash === 'playing') usePlayer.setState({ history: page.items.slice(8, 26) })
    usePlayer.getState().playList(page.items, 4, { shuffle: false })
    if (hash === 'np') useUi.getState().openNowPlaying('queue')
  }
}
