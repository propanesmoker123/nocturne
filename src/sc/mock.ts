import { albumRaw, commentsRaw, listenerRaw, meRaw, playlistRaw, selectionsRaw, streamRaw, systemPlaylistRaw, tracks, userRaw } from './fixtures'

const following = new Set<number>([userRaw.id])

/** The browser build's follow (the app's is not made yet: see `follow` in api.ts). */
export async function mockFollow(id: number, on: boolean): Promise<void> {
  await new Promise((r) => setTimeout(r, 300))
  if (on) following.add(id)
  else following.delete(id)
}

/** SoundCloud for the browser build (no Tauri): the made-up world from `fixtures.ts`. */
export async function mockScCall(method: string, path: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120))
  const [p, query = ''] = path.split('?')
  const q = new URLSearchParams(query)
  const unfollow = /^\/me\/followings\/(\d+)$/.exec(p)
  if (method === 'DELETE' && unfollow) return void (await mockFollow(Number(unfollow[1]), false))
  if (method !== 'GET') return null
  if (p === '/me') return meRaw
  if (p === '/mixed-selections') return { collection: selectionsRaw }
  if (p.startsWith('/system-playlists/')) return systemPlaylistRaw
  if (p.startsWith('/playlists/')) return Number(p.split('/')[2]) === albumRaw.id ? albumRaw : playlistRaw
  if (p === '/tracks') return (q.get('ids') ?? '').split(',').map((id) => tracks.find((t) => t.id === Number(id))).filter(Boolean)
  if (p === '/stream') return { collection: streamRaw }
  const listener = p.startsWith(`/users/${listenerRaw.id}`) || p.startsWith(`/stream/users/${listenerRaw.id}`)
  // the listener has nothing of their own
  if (listener && /^\/users\/\d+\/(toptracks|tracks|playlists_without_albums|albums)$/.test(p)) return { collection: [] }
  if (/^\/users\/\d+\/track_likes$/.test(p)) return { collection: tracks.slice(1, 4).map((track) => ({ track })) }
  if (/^\/users\/\d+\/(playlists_without_albums)$/.test(p)) return { collection: [playlistRaw] }
  if (/^\/users\/\d+\/albums$/.test(p)) return { collection: [albumRaw] }
  if (p === '/me/library/all') return { collection: [{ type: 'system-playlist-like', system_playlist: systemPlaylistRaw }] }
  if (/^\/users\/\d+\/followings\/ids$/.test(p)) return { collection: [...following] }
  if (/^\/stream\/users\/\d+\/reposts$/.test(p)) return { collection: listener ? streamRaw : streamRaw.slice(0, 2) }
  if (/^\/users\/\d+\/likes$/.test(p)) return { collection: [...tracks.slice(2, 5).map((track) => ({ kind: 'like', track })), { kind: 'like', playlist: playlistRaw }] }
  if (/^\/tracks\/\d+\/comments$/.test(p)) return { collection: commentsRaw(Number(p.split('/')[2])) }
  if (/^\/users\/\d+$/.test(p)) return listener ? listenerRaw : userRaw
  if (/^\/users\/\d+\/(toptracks|tracks)$/.test(p)) return { collection: tracks }
  if (p === '/search/tracks') return { collection: tracks.slice(0, 4) }
  if (p === '/search/users') return { collection: [userRaw, listenerRaw] }
  if (p === '/search/playlists') return { collection: [playlistRaw, albumRaw] }
  return { collection: [] }
}
