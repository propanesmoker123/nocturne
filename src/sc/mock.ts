import { albumRaw, meRaw, playlistRaw, selectionsRaw, streamRaw, systemPlaylistRaw, tracks, userRaw } from './fixtures'

/** SoundCloud for the browser build (no Tauri): the made-up world from `fixtures.ts`. */
export async function mockScCall(method: string, path: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120))
  const [p, query = ''] = path.split('?')
  const q = new URLSearchParams(query)
  if (method !== 'GET') return null
  if (p === '/me') return meRaw
  if (p === '/mixed-selections') return { collection: selectionsRaw }
  if (p.startsWith('/system-playlists/')) return systemPlaylistRaw
  if (p.startsWith('/playlists/')) return Number(p.split('/')[2]) === albumRaw.id ? albumRaw : playlistRaw
  if (p === '/tracks') return (q.get('ids') ?? '').split(',').map((id) => tracks.find((t) => t.id === Number(id))).filter(Boolean)
  if (p === '/stream') return { collection: streamRaw }
  if (/^\/users\/\d+\/track_likes$/.test(p)) return { collection: tracks.slice(1, 4).map((track) => ({ track })) }
  if (/^\/users\/\d+\/(playlists_without_albums)$/.test(p)) return { collection: [playlistRaw] }
  if (/^\/users\/\d+\/albums$/.test(p)) return { collection: [albumRaw] }
  if (p === '/me/library/all') return { collection: [{ type: 'system-playlist-like', system_playlist: systemPlaylistRaw }] }
  if (/^\/users\/\d+$/.test(p)) return userRaw
  if (/^\/users\/\d+\/(toptracks|tracks)$/.test(p)) return { collection: tracks }
  if (p === '/search/tracks') return { collection: tracks.slice(0, 4) }
  if (p === '/search/users') return { collection: [userRaw] }
  if (p === '/search/playlists') return { collection: [playlistRaw, albumRaw] }
  return { collection: [] }
}
