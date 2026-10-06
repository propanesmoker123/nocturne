import { useQuery } from '@tanstack/react-query'
import { ListMusic, Shuffle } from 'lucide-react'
import { useEffect } from 'react'
import { useChrome } from '../app/chrome'
import { showMenu } from '../app/menu'
import { playlistMenuItems } from '../app/trackActions'
import { Artwork } from '../components/Artwork'
import { Button, IconButton } from '../components/controls'
import { EmptyState, TrackListSkeleton } from '../components/cards'
import { IconMore, IconPlay } from '../components/Icons'
import { TrackList } from '../components/TrackList'
import { formatLongDuration, pluralRu } from '../lib/format'
import { useAllPages } from '../lib/hooks'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import s from './pages.module.css'

export function PlaylistPage({ ownerId, id, accessKey }: { ownerId: number; id: number; accessKey?: string }) {
  const meta = useQuery({ queryKey: ['playlist', ownerId, id], queryFn: () => vk.getPlaylist(ownerId, id, accessKey) })
  const tracks = useAllPages(['playlist-tracks', ownerId, id], (offset) => vk.getPlaylistTracks({ ownerId, id, accessKey }, offset, 500))
  const p = meta.data
  const setTitle = useChrome((c) => c.setTitle)
  useEffect(() => setTitle(p?.title ?? ''), [p?.title, setTitle])

  if (meta.isError) {
    return <EmptyState icon={<ListMusic size={26} />} title="Плейлист недоступен" text={describeError(meta.error)} />
  }

  const totalSec = tracks.items.reduce((n, t) => n + t.duration, 0)
  const count = tracks.total || p?.count || 0
  const playable = tracks.items.some((t) => t.playable)

  return (
    <>
      <div className={s.hero}>
        <Artwork className={s.heroArt} src={p?.cover} mosaic={p?.covers} size={232} radius={14} seed={p?.title ?? String(id)} />
        <div style={{ minWidth: 0 }}>
          <div className={s.heroKind}>{p?.type === 'album' ? 'Альбом' : 'Плейлист'}</div>
          <h1 className={s.heroTitle}>{p?.title ?? '…'}</h1>
          {p?.ownerName && <div className={s.heroOwner}>{p.ownerName}</div>}
          <div className={s.heroMeta}>
            {[count ? `${count} ${pluralRu(count, 'трек', 'трека', 'треков')}` : null, totalSec ? formatLongDuration(totalSec) : null, p?.year ? String(p.year) : null].filter(Boolean).join(' · ')}
          </div>
          {p?.description && <p className={s.heroDesc}>{p.description}</p>}
          <div className={s.heroActions}>
            <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks.items, 0, { shuffle: false })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks.items, 0, { shuffle: true })}>
              <Shuffle size={15} strokeWidth={2.2} /> Перемешать
            </Button>
            {p && (
              <IconButton label="Ещё" onClick={(e) => showMenu(e, playlistMenuItems(p, tracks.items))}>
                <IconMore size={20} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {tracks.isLoading && <TrackListSkeleton rows={10} />}
      {tracks.isError && <EmptyState title="Треки не загрузились" text={describeError(tracks.error)} />}
      {!tracks.isLoading && !tracks.isError && tracks.items.length === 0 && (
        <EmptyState
          icon={<ListMusic size={26} />}
          title="В плейлисте пока нет треков"
          text={p?.canEdit ? 'Добавляйте треки через меню «…» → «Добавить в плейлист».' : undefined}
        />
      )}
      {tracks.items.length > 0 && <TrackList tracks={tracks.items} playlist={p} showAlbum={p?.type !== 'album'} />}
    </>
  )
}
