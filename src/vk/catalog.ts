import type { Block, CatalogSection, Playlist, Track } from './models'
import { normalizePlaylist, normalizeTrack, ownerNamesFrom } from './normalize'
import type { RawCatalogBlock, RawCatalogResponse, RawCatalogSection } from './types'

interface Lookup {
  tracks: Map<string, Track>
  playlists: Map<string, Playlist>
  mixes: Map<string, { title: string; description?: string }>
}

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
  return { tracks, playlists, mixes }
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
      const tracks = (b.audios_ids ?? []).map((id) => lookup.tracks.get(baseId(id))).filter((t): t is Track => !!t)
      if (tracks.length) out.push({ kind: 'tracks', id: b.id, title, tracks, nextFrom: b.next_from, layout })
    } else if (b.data_type === 'music_playlists') {
      const playlists = (b.playlists_ids ?? []).map((id) => lookup.playlists.get(baseId(id))).filter((p): p is Playlist => !!p)
      if (playlists.length) out.push({ kind: 'playlists', id: b.id, title, playlists, nextFrom: b.next_from, layout })
    } else if (b.data_type === 'audio_stream_mixes') {
      const mixId = b.audio_stream_mixes_ids?.[0]
      const mix = mixId ? lookup.mixes.get(mixId) : undefined
      if (mixId && mix) out.push({ kind: 'mix', id: b.id, title: mix.title, mixId, description: mix.description, layout })
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
