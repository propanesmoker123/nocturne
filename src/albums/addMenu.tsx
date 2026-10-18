import { Plus } from 'lucide-react'
import type { MenuItem } from '../app/menu'
import { useSheet } from '../app/sheetStore'
import { toast } from '../app/toast'
import type { Track } from '../vk/models'
import { liveEntries, MAX_TRACKS } from './model'
import { useAlbums } from './store'

/** What the plus offers: a new album with these tracks, then the albums by name. */
export function albumMenuItems(tracks: Track[]): MenuItem[] {
  const { list, docs } = useAlbums.getState()
  const albums = list
    .filter((e) => !e.removedAt && docs[e.id] && !docs[e.id].meta.deletedAt)
    .map((e) => ({ id: e.id, name: docs[e.id].meta.name || e.name, full: liveEntries(docs[e.id]).length >= MAX_TRACKS }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const items: MenuItem[] = [{ label: 'Новый альбом…', icon: <Plus size={16} strokeWidth={1.9} />, onSelect: () => useSheet.getState().open({ kind: 'album-create', addTracks: tracks }) }]
  if (albums.length) items.push({ separator: true })
  for (const a of albums) items.push({ label: a.full ? `${a.name} — полный` : a.name, onSelect: () => addToAlbum(a.id, a.name, tracks) })
  return items
}

function addToAlbum(id: string, name: string, tracks: Track[]) {
  const { added, skipped } = useAlbums.getState().add(id, tracks)
  if (skipped === 'full') toast(added ? `В «${name}» добавлено не всё: больше ${MAX_TRACKS} треков не поместится` : `В «${name}» уже ${MAX_TRACKS} треков — больше не поместится`, 'error')
  else if (added) toast(`Добавлено в «${name}»`, 'added')
  else toast(`Уже в «${name}»`, 'info')
}
