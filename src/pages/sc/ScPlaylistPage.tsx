import { useQuery } from '@tanstack/react-query'
import { ListMusic, Shuffle } from 'lucide-react'
import { useEffect } from 'react'
import { useChrome } from '../../app/chrome'
import { showMenu } from '../../app/menu'
import { playlistMenuItems } from '../../app/trackActions'
import { Artwork } from '../../components/Artwork'
import { Button, IconButton } from '../../components/controls'
import { EmptyState, TrackListSkeleton } from '../../components/cards'
import { IconMore, IconPlay } from '../../components/Icons'
import { TrackList } from '../../components/TrackList'
import { formatLongDuration, pluralRu } from '../../lib/format'
import { usePlayer } from '../../player/store'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import { PlaylistSaveButton } from '../../sc/PlaylistSaveButton'
import s from '../pages.module.css'
import { ScGate } from './ScGate'

export function ScPlaylistPage(props: { id: number; urn?: string; title?: string }) {
  return (
    <ScGate>
      <PlaylistBody {...props} />
    </ScGate>
  )
}

function PlaylistBody({ id, urn, title }: { id: number; urn?: string; title?: string }) {
  const q = useQuery({ queryKey: scKeys.playlist(urn ?? String(id)), queryFn: () => sc.getPlaylistWithTracks({ id, urn }) })
  const p = q.data?.playlist
  const tracks = q.data?.tracks ?? []
  const name = p?.title || title || ''
  const setTitle = useChrome((c) => c.setTitle)
  useEffect(() => setTitle(name), [name, setTitle])

  if (q.isError) {
    return <EmptyState icon={<ListMusic size={26} />} title="Плейлист недоступен" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />
  }
  const totalSec = tracks.reduce((n, t) => n + t.duration, 0)
  const count = tracks.length || p?.count || 0
  const playable = tracks.some((t) => t.playable)
  const source = { kind: 'list' as const, label: name }
  return (
    <>
      <div className={s.hero}>
        <Artwork className={s.heroArt} src={p?.cover ?? tracks[0]?.cover?.l} size={232} radius={14} seed={name || String(id)} />
        <div style={{ minWidth: 0 }}>
          <div className={s.heroKind}>{urn ? 'Подборка SoundCloud' : p?.type === 'album' ? 'Альбом' : 'Плейлист'}</div>
          <h1 className={s.heroTitle}>{name || '…'}</h1>
          {p?.ownerName && <div className={s.heroOwner}>{p.ownerName}</div>}
          <div className={s.heroMeta}>{[count ? `${count} ${pluralRu(count, 'трек', 'трека', 'треков')}` : null, totalSec ? formatLongDuration(totalSec) : null].filter(Boolean).join(' · ')}</div>
          {p?.description && <p className={s.heroDesc}>{p.description}</p>}
          <div className={s.heroActions}>
            <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: false, source })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: true, source })}>
              <Shuffle size={15} strokeWidth={2.2} /> Перемешать
            </Button>
            {p && <PlaylistSaveButton key={urn ?? String(id)} playlist={p} />}
            {p && (
              <IconButton label="Ещё" onClick={(e) => showMenu(e, playlistMenuItems(p, tracks))}>
                <IconMore size={20} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.data && tracks.length === 0 && <EmptyState icon={<ListMusic size={26} />} title="В плейлисте пока нет треков" />}
      {tracks.length > 0 && <TrackList tracks={tracks} showAlbum={false} />}
    </>
  )
}
