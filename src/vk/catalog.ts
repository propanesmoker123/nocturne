import type { Block, CatalogSection, Playlist, RecommendedPlaylist, Track } from './models'
import { normalizePlaylist, normalizeTrack, ownerNamesFrom } from './normalize'
import type { RawCatalogBlock, RawCatalogResponse, RawCatalogSection, RawRecommendedPlaylist } from './types'

interface Lookup {
  tracks: Map<string, Track>
  playlists: Map<string, Playlist>
  mixes: Map<string, { title: string; description?: string }>
  recommended: Map<string, RawRecommendedPlaylist>
  photos: Map<number, string>
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i

/** "owner_id" or "owner_id_accesskey" → "owner_id" */
function baseId(id: string): string {
  const [owner, item] = id.split('_')
  return `${owner}_${item}`
}

function buildLookup(raw: RawCatalogResponse, meId: number): Lookup {
  const now = Date.now()
  const names = ownerNamesFrom(raw.profiles, raw.groups)
  const tracks = new Map<string, Track>()
  for (const a of raw.audios ?? []) tracks.set(`${a.owner_id}_${a.id}`, normalizeTrack(a, now))
  const playlists = new Map<string, Playlist>()
  for (const p of raw.playlists ?? []) playlists.set(`${p.owner_id}_${p.id}`, normalizePlaylist(p, meId, names))
  const mixes = new Map<string, { title: string; description?: string }>()
  for (const m of raw.audio_stream_mixes ?? []) mixes.set(m.id, { title: m.stream_mix?.title ?? 'VK Микс', description: m.description })
  const recommended = new Map<string, RawRecommendedPlaylist>()
  for (const r of raw.recommended_playlists ?? []) recommended.set(`${r.owner_id}_${r.id}`, r)
  const photos = new Map<number, string>()
  for (const p of raw.profiles ?? []) if (p.photo_100) photos.set(p.id, p.photo_100)
  for (const g of raw.groups ?? []) if (g.photo_100) photos.set(-g.id, g.photo_100)
  return { tracks, playlists, mixes, recommended, photos }
}

function resolveTracks(ids: string[] | undefined, lookup: Lookup): Track[] {
  return (ids ?? []).map((id) => lookup.tracks.get(baseId(id))).filter((t): t is Track => !!t)
}

function recommendedItem(id: string, lookup: Lookup): RecommendedPlaylist | null {
  const playlist = lookup.playlists.get(baseId(id))
  const rec = lookup.recommended.get(baseId(id))
  if (!playlist || !rec) return null
  const match = Number(rec.percentage)
  return {
    playlist,
    match: Number.isFinite(match) ? Math.min(Math.max(match, 0), 1) : 0,
    matchTitle: rec.percentage_title || 'совпадение с вашим вкусом',
    color: rec.color && HEX_COLOR.test(rec.color) ? rec.color : undefined,
    background: rec.cover,
    ownerPhoto: lookup.photos.get(playlist.ownerId),
    tracks: resolveTracks(rec.audios, lookup),
  }
}

function parseBlocks(blocks: RawCatalogBlock[], lookup: Lookup): Block[] {
  const out: Block[] = []
  let header = ''
  for (const b of blocks) {
    const layout = b.layout?.name
    if (b.data_type === 'none') {
      if (layout === 'header' || layout === 'header_extended') header = b.layout?.title ?? b.title ?? ''
      else if (layout === 'separator') header = ''
      continue
    }
    const title = header || b.layout?.title || b.title || ''
    if (b.data_type === 'music_audios') {
      const tracks = resolveTracks(b.audios_ids, lookup)
      if (tracks.length) out.push({ kind: 'tracks', id: b.id, title, tracks, nextFrom: b.next_from, layout })
    } else if (b.data_type === 'music_playlists') {
      const playlists = (b.playlists_ids ?? []).map((id) => lookup.playlists.get(baseId(id))).filter((p): p is Playlist => !!p)
      if (playlists.length) out.push({ kind: 'playlists', id: b.id, title, playlists, nextFrom: b.next_from, layout })
    } else if (b.data_type === 'audio_stream_mixes') {
      const mixId = b.audio_stream_mixes_ids?.[0]
      const mix = mixId ? lookup.mixes.get(mixId) : undefined
      if (mixId && mix) out.push({ kind: 'mix', id: b.id, title: mix.title, mixId, description: mix.description, layout })
    } else if (b.data_type === 'music_recommended_playlists') {
      const items = (b.playlists_ids ?? []).map((id) => recommendedItem(id, lookup)).filter((r): r is RecommendedPlaylist => !!r)
      if (items.length) out.push({ kind: 'recommended', id: b.id, title, items, nextFrom: b.next_from, layout })
    }
    header = ''
  }
  return out
}

function toSection(s: RawCatalogSection, lookup: Lookup): CatalogSection {
  return { id: s.id, title: s.title, url: s.url, blocks: parseBlocks(s.blocks ?? [], lookup), nextFrom: s.next_from }
}

/** Parses catalog.getAudio; the default section comes first. */
export function parseCatalog(raw: RawCatalogResponse, meId: number): CatalogSection[] {
  const lookup = buildLookup(raw, meId)
  const sections = (raw.catalog?.sections ?? []).map((s) => toSection(s, lookup))
  const def = raw.catalog?.default_section
  return [...sections.filter((s) => s.id === def), ...sections.filter((s) => s.id !== def)]
}

/** Parses catalog.getSection. */
export function parseSection(raw: RawCatalogResponse, meId: number): CatalogSection {
  const lookup = buildLookup(raw, meId)
  return raw.section ? toSection(raw.section, lookup) : { id: '', title: '', blocks: [] }
}
