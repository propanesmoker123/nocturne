import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { showMenu } from '../app/menu'
import { useRouter } from '../app/router'
import { openTrackMenu, playlistMenuItems } from '../app/trackActions'
import { formatTime, pluralRu } from '../lib/format'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Playlist, RecommendedPlaylist } from '../vk/models'
import { toast } from '../app/toast'
import { Artwork } from './Artwork'
import { EqualizerBars, Spinner } from './controls'
import { IconMore, IconPause, IconPlay } from './Icons'
import s from './cards.module.css'

export function Section({ title, action, children }: { title: string; action?: { label: string; onClick(): void }; children: ReactNode }) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>{title}</h2>
        {action && (
          <button type="button" className={s.sectionAction} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

export function Carousel({ children, card = 176 }: { children: ReactNode; card?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: false })
  const update = () => {
    const el = ref.current
    if (!el) return
    setEdges({ start: el.scrollLeft < 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 })
  }
  useEffect(update, [children])
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' })
  return (
    <div className={s.carousel} style={{ ['--card' as string]: `${card}px` } as CSSProperties}>
      <button type="button" className={`${s.arrow} ${s.prev}`} aria-label="Назад" disabled={edges.start} onClick={() => scroll(-1)}>
        <ChevronLeft size={20} strokeWidth={2.4} />
      </button>
      <div ref={ref} className={s.track} onScroll={update}>
        {children}
      </div>
      <button type="button" className={`${s.arrow} ${s.next}`} aria-label="Вперёд" disabled={edges.end} onClick={() => scroll(1)}>
        <ChevronRight size={20} strokeWidth={2.4} />
      </button>
    </div>
  )
}

export function playlistSubtitle(p: Playlist): string {
  const parts = [p.ownerName, p.type === 'album' && p.year ? String(p.year) : null, p.count ? `${p.count} ${pluralRu(p.count, 'трек', 'трека', 'треков')}` : null]
  return parts.filter(Boolean).join(' · ')
}

async function playPlaylist(p: Playlist, shuffle = false) {
  try {
    const page = await vk.getPlaylistTracks(p, 0, 500)
    if (!page.items.length) {
      toast('В плейлисте пока нет треков', 'info')
      return
    }
    usePlayer.getState().playList(page.items, 0, { shuffle })
  } catch (e) {
    toast(describeError(e), 'error')
  }
}

export function PlaylistCard({ playlist: p }: { playlist: Playlist }) {
  const push = useRouter((r) => r.push)
  const [busy, setBusy] = useState(false)
  const open = () => push({ name: 'playlist', ownerId: p.ownerId, id: p.id, accessKey: p.accessKey })
  return (
    <div className={s.card}>
      <div
        className={s.cover}
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        onContextMenu={(e) => {
          e.preventDefault()
          showMenu(e, playlistMenuItems(p, undefined))
        }}
      >
        <Artwork src={p.cover} mosaic={p.covers} size="100%" radius={12} seed={p.title} style={{ aspectRatio: '1', height: 'auto' }} />
        <div className={s.coverActions}>
          <button
            type="button"
            className={s.coverBtn}
            aria-label={`Играть «${p.title}»`}
            onClick={async (e) => {
              e.stopPropagation()
              setBusy(true)
              await playPlaylist(p)
              setBusy(false)
            }}
          >
            {busy ? <Spinner size={16} /> : <IconPlay size={17} />}
          </button>
          <button
            type="button"
            className={s.coverBtn}
            aria-label="Ещё"
            onClick={(e) => {
              e.stopPropagation()
              showMenu(e, playlistMenuItems(p, undefined))
            }}
          >
            <IconMore size={17} />
          </button>
        </div>
      </div>
      <button type="button" className={s.cardTitle} onClick={open}>
        {p.title}
      </button>
      <div className={`${s.cardSub} truncate`}>{playlistSubtitle(p)}</div>
    </div>
  )
}

/** Another listener's playlist from "Слушайте друг друга": taste match, owner and a short preview. */
export function RecommendedCard({ item }: { item: RecommendedPlaylist }) {
  const { playlist: p, tracks } = item
  const push = useRouter((r) => r.push)
  const currentKey = usePlayer((x) => x.current?.key)
  const isPlaying = usePlayer((x) => x.isPlaying)
  const [busy, setBusy] = useState(false)
  const open = () => push({ name: 'playlist', ownerId: p.ownerId, id: p.id, accessKey: p.accessKey })
  const play = (i: number) => tracks[i]?.playable && usePlayer.getState().playList(tracks, i)
  return (
    <div className={s.rec} style={item.color ? ({ ['--rec' as string]: item.color } as CSSProperties) : undefined}>
      <div
        className={s.recHead}
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        onContextMenu={(e) => {
          e.preventDefault()
          showMenu(e, playlistMenuItems(p, undefined))
        }}
      >
        {item.background && <img className={s.recBg} src={item.background} alt="" loading="lazy" draggable={false} />}
        <div className={s.recMatch}>
          <b>{Math.round(item.match * 100)}%</b> · {item.matchTitle}
        </div>
        <div className={s.recTitle}>{p.title}</div>
        {p.ownerName && (
          <div className={s.recOwner}>
            <Artwork src={item.ownerPhoto} size={18} radius={9} seed={p.ownerName} />
            <span className="truncate">{p.ownerName}</span>
          </div>
        )}
        <button
          type="button"
          className={`${s.coverBtn} ${s.recPlay}`}
          aria-label={`Играть «${p.title}»`}
          onClick={async (e) => {
            e.stopPropagation()
            setBusy(true)
            await playPlaylist(p)
            setBusy(false)
          }}
        >
          {busy ? <Spinner size={16} /> : <IconPlay size={17} />}
        </button>
      </div>
      <div className={s.recTracks}>
        {tracks.map((t, i) => {
          const current = t.key === currentKey
          return (
            <div
              key={`${t.key}-${i}`}
              className={s.recRow}
              role="button"
              tabIndex={t.playable ? 0 : -1}
              aria-disabled={!t.playable || undefined}
              data-current={current || undefined}
              onClick={() => play(i)}
              onKeyDown={(e) => e.key === 'Enter' && play(i)}
              onContextMenu={(e) => openTrackMenu(e, t, { list: tracks, index: i })}
            >
              <div className={s.recArt}>
                <Artwork src={t.cover?.s} size={40} radius={6} seed={t.key} />
                {t.playable && (
                  <span className={s.recArtPlay} data-on={(current && isPlaying) || undefined} aria-hidden="true">
                    {current && isPlaying ? <EqualizerBars playing height={12} color="#fff" /> : <IconPlay size={15} />}
                  </span>
                )}
              </div>
              <div className={s.recText}>
                <div className={`${s.recTrack} truncate`}>{t.title}</div>
                <div className={`${s.recArtist} truncate`}>{t.artist}</div>
              </div>
              <span className={s.recTime}>{formatTime(t.duration)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function NewPlaylistCard({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className={s.card} onClick={onClick}>
      <div className={s.newCard}>
        <Plus size={40} strokeWidth={1.6} />
      </div>
      <div className={s.cardTitle}>Новый плейлист</div>
      <div className={s.cardSub}>Создать в VK</div>
    </button>
  )
}

export function PlaylistGrid({ children }: { children: ReactNode }) {
  return <div className={s.grid}>{children}</div>
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className={s.state}>
      {icon && <div className={s.stateIcon}>{icon}</div>}
      <h3 className={s.stateTitle}>{title}</h3>
      {text && <p className={s.stateText}>{text}</p>}
      {action}
    </div>
  )
}

export function TrackListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skRow} style={{ opacity: 1 - i * 0.09 }}>
          <span className={s.skeleton} style={{ width: 16, height: 12, justifySelf: 'center' }} />
          <span className={s.skeleton} style={{ width: 40, height: 40 }} />
          <span style={{ display: 'grid', gap: 6 }}>
            <span className={s.skeleton} style={{ width: `${40 + ((i * 17) % 35)}%`, height: 12 }} />
            <span className={s.skeleton} style={{ width: `${22 + ((i * 11) % 20)}%`, height: 10 }} />
          </span>
          <span className={s.skeleton} style={{ width: 36, height: 10, justifySelf: 'end' }} />
        </div>
      ))}
    </div>
  )
}

export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={s.track} style={{ ['--card' as string]: '176px', overflow: 'hidden' } as CSSProperties} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ display: 'grid', gap: 8 }}>
          <span className={s.skeleton} style={{ aspectRatio: '1', borderRadius: 12 }} />
          <span className={s.skeleton} style={{ width: '70%', height: 12 }} />
          <span className={s.skeleton} style={{ width: '45%', height: 10 }} />
        </div>
      ))}
    </div>
  )
}

export function MixHero({ title, description }: { title: string; description?: string }) {
  const source = usePlayer((p) => p.source)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const [busy, setBusy] = useState(false)
  const playingMix = source?.kind === 'mix'
  return (
    <section className={s.mix} aria-label="VK Микс">
      <div className={s.mixGlow} />
      <div>
        <div className={s.mixKicker}>Бесконечный поток</div>
        <h2 className={s.mixTitle}>{title.replace(/^Слушать\s+/i, '')}</h2>
        <p className={s.mixText}>{description ?? 'Подборка, которая подстраивается под то, что вы слушаете.'}</p>
        <button
          type="button"
          className={s.mixPlay}
          onClick={async () => {
            if (playingMix) {
              usePlayer.getState().toggle()
              return
            }
            setBusy(true)
            await usePlayer.getState().playMix()
            setBusy(false)
          }}
        >
          {busy ? <Spinner size={18} /> : playingMix && isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
          {playingMix && isPlaying ? 'Пауза' : playingMix ? 'Продолжить' : 'Слушать'}
        </button>
      </div>
      <div className={s.mixBars} data-playing={(playingMix && isPlaying) || undefined} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </section>
  )
}
