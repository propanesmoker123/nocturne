import { describe, expect, test } from 'vitest'
import { parseSpotifyLink } from './links'

describe('Spotify content links', () => {
  test('accepts Spotify URI, share, locale and embed links without carrying query credentials', () => {
    const id = '37i9dQZF1DXcBWIGoYBM5M'
    const expected = { kind: 'playlist', id, uri: `spotify:playlist:${id}`, url: `https://open.spotify.com/playlist/${id}` }
    for (const link of [`spotify:playlist:${id}`, `https://open.spotify.com/playlist/${id}?si=private-share`, `https://open.spotify.com/intl-ru/playlist/${id}`, `https://open.spotify.com/embed/playlist/${id}`]) {
      expect(parseSpotifyLink(link)).toEqual(expected)
    }
    expect(parseSpotifyLink('spotify:track:4uLU6hMCjMI75M1A2tKUQC')?.kind).toBe('track')
    expect(parseSpotifyLink('https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX')?.kind).toBe('album')
  })
  test('rejects lookalikes, credentials, unexpanded short links and unrelated content', () => {
    for (const value of ['https://open.spotify.com.evil.test/playlist/37i9dQZF1DXcBWIGoYBM5M', 'https://evil@open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'javascript:alert(1)', 'https://spotify.link/short', 'spotify:playlist:../private', 'https://open.spotify.com/user/someone', 'https://open.spotify.com:444/playlist/37i9dQZF1DXcBWIGoYBM5M']) {
      expect(parseSpotifyLink(value)).toBeNull()
    }
  })
})
