import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { isInLibrary, toggleLibrary } from '../app/library'
import { useRouter } from '../app/router'
import { useScroller } from '../app/scroller'
import { openTrackMenu } from '../app/trackActions'
import { formatTime } from '../lib/format'
import { usePlayer } from '../player/store'
import type { Playlist, Track } from '../vk/models'
import { Artwork } from './Artwork'
import { EqualizerBars, IconButton } from './controls'
import { IconCheck, IconMore, IconPlay, IconPlus } from './Icons'
import s from './TrackList.module.css'

const ROW = 56

export function ArtistLinks({ track }: { track: Track }) {
  const push = useRouter((r) => r.push)
  return (
    <span className="truncate" style={{ display: 'block' }}>
      {track.artists.map((a, i) => (
        <span key={`${a.name}-${i}`}>
          {i > 0 && ', '}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              push({ name: 'artist', id: a.id, artist: a.name })
            }}
          >
            {a.name}
          </button>
        </span>
      ))}
    </span>
  )
}

interface RowProps {
  track: Track
  index: number
  top: number
  isCurrent: boolean
  isPlaying: boolean
  showAlbum: boolean
  onPlay(index: number): void
  onMenu(e: MouseEvent, track: Track, index: number): void
}

const Row = memo(function Row({ track, index, top, isCurrent, isPlaying, showAlbum, onPlay, onMenu }: RowProps) {
  const push = useRouter((r) => r.push)
  const liked = isInLibrary(track)
  return (
    <div
      className={s.row}
      style={{ transform: `translateY(${top}px)` }}
      role="row"
      tabIndex={0}
      data-current={isCurrent || undefined}
      data-disabled={!track.playable || undefined}
      onDoubleClick={() => track.playable && onPlay(index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && track.playable) onPlay(index)
      }}
      onContextMenu={(e) => onMenu(e, track, index)}
    >
      <div className={s.index}>
        {isCurrent ? (
          <span className={s.indexEq}>
            <EqualizerBars playing={isPlaying} height={13} />
          </span>
        ) : (
          <span className={s.indexNum}>{index + 1}</span>
        )}
        {track.playable && (
          <button type="button" className={s.playHover} aria-label={`Играть «${track.title}»`} onClick={() => onPlay(index)}>
            <IconPlay size={15} />
          </button>
        )}
      </div>
      <div className={s.main}>
        <Artwork src={track.cover?.s} size={40} radius={6} seed={track.key} />
        <div className={s.text}>
          <div className={s.title}>
            <span className="truncate">{track.title}</span>
            {track.subtitle && <span className="truncate" style={{ color: 'var(--label-3)', flexShrink: 2 }}>{track.subtitle}</span>}
            {track.explicit && <span className={s.explicit} aria-label="Нецензурное">E</span>}
          </div>
          <div className={s.artists}>
            <ArtistLinks track={track} />
          </div>
        </div>
      </div>
      {showAlbum && (
        <div className={`${s.album} truncate`}>
          {track.album && (
            <button type="button" onClick={() => push({ name: 'playlist', ownerId: track.album!.ownerId, id: track.album!.id, accessKey: track.album!.accessKey })}>
              {track.album.title}
            </button>
          )}
        </div>
      )}
      <div className={s.trail}>
        <IconButton
          className={s.hoverOnly}
          data-active={liked || undefined}
          size={30}
          active={liked}
          label={liked ? 'Убрать из Моей музыки' : 'Добавить в Мою музыку'}
          onClick={() => void toggleLibrary(track)}
        >
          {liked ? <IconCheck size={17} /> : <IconPlus size={17} />}
        </IconButton>
      </div>
      <div className={s.duration}>{formatTime(track.duration)}</div>
      <IconButton className={s.hoverOnly} size={30} label="Ещё" onClick={(e) => onMenu(e, track, index)}>
        <IconMore size={17} />
      </IconButton>
    </div>
  )
})

interface TrackListProps {
  tracks: Track[]
  /** Queue that playback starts from; defaults to `tracks`. */
  queueSource?: Track[]
  playlist?: Playlist
  showAlbum?: boolean
  showHeader?: boolean
}

/** Apple Music-style song table, virtualized against the page scroller. */
export function TrackList({ tracks, queueSource, playlist, showAlbum = true, showHeader = true }: TrackListProps) {
  const scroller = useScroller()
  const listRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  const currentKey = usePlayer((p) => p.current?.key)
  const isPlaying = usePlayer((p) => p.isPlaying)

  useLayoutEffect(() => {
    const el = listRef.current
    const sc = scroller.current
    if (!el || !sc) return
    const update = () => setMargin(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(sc.firstElementChild ?? sc)
    return () => ro.disconnect()
  }, [scroller])

  const v = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
    scrollMargin: margin,
  })

  const source = queueSource ?? tracks
  const onPlay = (index: number) => {
    const t = tracks[index]
    const at = source === tracks ? index : source.findIndex((x) => x.key === t.key)
    usePlayer.getState().playList(source, Math.max(0, at))
  }
  const onMenu = (e: MouseEvent, track: Track, index: number) => openTrackMenu(e, track, { list: source, index, playlist })
  const cols = showAlbum ? '28px minmax(0, 1.6fr) minmax(0, 1fr) 34px 52px 30px' : '28px minmax(0, 1fr) 34px 52px 30px'

  return (
    <div style={{ ['--cols' as string]: cols }}>
      {showHeader && (
        <div className={s.head} role="row">
          <span style={{ textAlign: 'center' }}>#</span>
          <span>Название</span>
          {showAlbum && <span>Альбом</span>}
          <span />
          <span style={{ textAlign: 'right' }}>Время</span>
          <span />
        </div>
      )}
      <div ref={listRef} className={s.list} role="table" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((item) => {
          const t = tracks[item.index]
          return (
            <Row
              key={`${t.key}-${item.index}`}
              track={t}
              index={item.index}
              top={item.start - margin}
              isCurrent={t.key === currentKey}
              isPlaying={isPlaying}
              showAlbum={showAlbum}
              onPlay={onPlay}
              onMenu={onMenu}
            />
          )
        })}
      </div>
    </div>
  )
}

/** Three-row horizontal grid used for catalog "stacked slider" blocks. */
export function TrackGrid({ tracks }: { tracks: Track[] }) {
  const currentKey = usePlayer((p) => p.current?.key)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const play = (i: number) => usePlayer.getState().playList(tracks, i)
  return (
    <div className={s.gridScroller}>
      {tracks.map((t, i) => (
        <div
          key={`${t.key}-${i}`}
          className={s.cell}
          data-current={t.key === currentKey || undefined}
          data-disabled={!t.playable || undefined}
          onDoubleClick={() => t.playable && play(i)}
          onContextMenu={(e) => openTrackMenu(e, t, { list: tracks, index: i })}
        >
          <div className={s.cellArt}>
            <Artwork src={t.cover?.s} size={48} radius={8} seed={t.key} />
            {t.playable && (
              <button type="button" className={s.playHover} aria-label={`Играть «${t.title}»`} onClick={() => play(i)}>
                {t.key === currentKey && isPlaying ? <EqualizerBars playing height={14} color="#fff" /> : <IconPlay size={18} />}
              </button>
            )}
          </div>
          <div className={s.text}>
            <div className={s.title}>
              <span className="truncate">{t.title}</span>
              {t.explicit && <span className={s.explicit}>E</span>}
            </div>
            <div className={`${s.artists} truncate`}>{t.artist}</div>
          </div>
          <IconButton className={s.hoverOnly} size={28} label="Ещё" onClick={(e) => openTrackMenu(e, t, { list: tracks, index: i })}>
            <IconMore size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
