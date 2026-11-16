export type SpotifyContentKind = 'track' | 'playlist' | 'album' | 'artist'
export interface SpotifyLink { kind: SpotifyContentKind; id: string; uri: string; url: string }

/** Accept a content link, never an arbitrary navigation target or a share token. */
export function parseSpotifyLink(value: string): SpotifyLink | null {
  const input = value.trim()
  let parts: string[]
  if (input.startsWith('spotify:')) parts = input.slice('spotify:'.length).split(':')
  else {
    let url: URL
    try { url = new URL(input) } catch { return null }
    if (url.origin !== 'https://open.spotify.com' || url.username || url.password) return null
    parts = url.pathname.replace(/^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?|embed)\//i, '/').split('/').filter(Boolean)
  }
  const [kind, id] = parts
  if (parts.length !== 2 || !['track', 'playlist', 'album', 'artist'].includes(kind) || !/^[A-Za-z0-9]{22}$/.test(id)) return null
  return { kind: kind as SpotifyContentKind, id, uri: `spotify:${kind}:${id}`, url: `https://open.spotify.com/${kind}/${id}` }
}
