import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Headphones, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { showMenu } from '../app/menu'
import { useRouter } from '../app/router'
import { openTrackMenu, playlistMenuItems } from '../app/trackActions'
import { useUi } from '../app/ui'
import { isAlgorithmicVkPlaylist, needsDerivedPlaylistCovers, pickRealTrackCovers } from '../lib/covers'
import { formatPlays, formatPlaysShort, formatTime, pluralRu } from '../lib/format'
import { useSettings, type WallpaperConfig } from '../lib/settings'
import { useWindowVisibility } from '../lib/windowVisibility'
import { upcoming } from '../player/queue'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
import * as spotify from '../spotify/api'
import { spotifyError } from '../spotify/runtime'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Playlist, RecommendedPlaylist, Track } from '../vk/models'
import { toast } from '../app/toast'
import { Artwork } from './Artwork'
import { EqualizerBars, Spinner } from './controls'
import { EdgeArrows, useHorizontalScroll } from './HScroll'
import { IconForward, IconMore, IconPause, IconPlay } from './Icons'
import s from './cards.module.css'
import { PRESETS } from './Wallpaper'

/** `onOpen` turns the title into a link to the full list, marked with a chevron. */
export function Section({
  title,
  subtitle,
  action,
  onOpen,
  children,
}: {
  title: string
  subtitle?: string
  action?: { label: string; onClick(): void }
  onOpen?: () => void
  children: ReactNode
}) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <div className={s.sectionHeadText}>
          {subtitle && <div className={s.sectionSubtitle}>{subtitle}</div>}
          <h2 className={s.sectionTitle}>
            {onOpen ? (
              <button type="button" className={s.sectionLink} onClick={onOpen} title="Показать все">
                {title}
                <ChevronRight size={22} strokeWidth={2.6} aria-hidden="true" />
              </button>
            ) : (
              title
            )}
          </h2>
        </div>
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
  const scroll = useHorizontalScroll(ref)
  const { refresh } = scroll
  useEffect(refresh, [children, refresh])
  return (
    <div className={s.carousel} style={{ ['--card' as string]: `${card}px` } as CSSProperties}>
      <div ref={ref} className={s.track}>
        {children}
      </div>
      <EdgeArrows scroll={scroll} />
    </div>
  )
}

export function playlistSubtitle(p: Playlist): string {
  if (p.service === 'spotify' && p.type === 'playlist' && p.description && (!p.ownerName || p.ownerName.toLowerCase() === 'spotify')) {
    return p.description
  }
  const parts = [p.ownerName, p.type === 'album' && p.year ? String(p.year) : null, p.count ? `${p.count} ${pluralRu(p.count, 'трек', 'трека', 'треков')}` : null]
  return parts.filter(Boolean).join(' · ')
}

export async function playPlaylist(p: Playlist, shuffle = false) {
  const isSc = p.service === 'sc'
  const isSp = p.service === 'spotify'
  try {
    let items
    if (isSp) {
      const first = await spotify.getPlaylistOrAlbum(p.spotifyId!, p.type)
      items = [...first.tracks]
      const target = Math.min(first.playlist.count || items.length, 500)
      while (items.length < target) {
        const page = await spotify.getPlaylistTracksPage(p.spotifyId!, p.type, items.length, 100)
        if (!page.tracks.length) break
        const seen = new Set(items.map((t) => t.key))
        const fresh = page.tracks.filter((t) => !seen.has(t.key))
        if (!fresh.length) break
        items.push(...fresh)
      }
    } else if (isSc) {
      items = (await sc.getPlaylistWithTracks(p)).tracks
    } else {
      items = (await vk.getPlaylistTracks(p, 0, 500)).items
    }
    if (!items.length) {
      toast('В плейлисте пока нет треков', 'info')
      return
    }
    usePlayer.getState().playList(items, 0, {
      shuffle,
      source: {
        kind: 'list',
        ...(isSp
          ? {
              service: 'spotify' as const,
              ...(p.spotifyId ? { contextUri: `spotify:${p.type}:${p.spotifyId}` } : {}),
            }
          : {}),
        label: p.title,
      },
    })
  } catch (e) {
    toast(isSp ? spotifyError(e) : isSc ? describeScError(e) : describeError(e), 'error')
  }
}

export function usePlaylistCovers(p: Playlist | undefined, knownTracks?: Track[]): { src?: string; mosaic?: string[] } {
  const shouldDerive = !!p && needsDerivedPlaylistCovers(p)
  const knownCovers = shouldDerive && knownTracks?.length ? pickRealTrackCovers(knownTracks, 4, p.cover) : null
  const q = useQuery({
    queryKey: ['playlist-cover-tracks', p?.service ?? 'vk', p?.ownerId ?? 0, p?.id ?? 0],
    enabled: shouldDerive && knownCovers === null,
    staleTime: 30 * 60_000,
    retry: false,
    queryFn: async () => {
      if (!p) return [] as string[]
      try {
        if (p.service === 'sc') {
          const { tracks } = await sc.getPlaylistWithTracks(p)
          return pickRealTrackCovers(tracks, 4, p.cover)
        }
        if (p.service === 'spotify') return [] as string[]
        const { items } = await vk.getPlaylistTracks(p, 0, 30)
        return pickRealTrackCovers(items, 4, p.cover)
      } catch {
        return [] as string[]
      }
    },
  })
  const derived = knownCovers ?? q.data
  if (derived && derived.length > 0) {
    return derived.length >= 4 ? { mosaic: derived.slice(0, 4) } : { src: derived[0], mosaic: derived }
  }
  if (p && isAlgorithmicVkPlaylist(p)) {
    return { src: p.cover, mosaic: p.covers }
  }
  return { src: p?.cover, mosaic: p?.covers }
}

export function PlaylistCard({ playlist: p, note }: { playlist: Playlist; note?: ReactNode }) {
  const push = useRouter((r) => r.push)
  const [busy, setBusy] = useState(false)
  const art = usePlaylistCovers(p)
  const open = () =>
    push(
      p.service === 'spotify'
        ? { name: 'spotify-playlist', id: p.spotifyId!, kind: p.type, title: p.title }
        : p.service === 'sc'
          ? { name: 'sc-playlist', id: p.id, urn: p.urn, title: p.title }
          : { name: 'playlist', ownerId: p.ownerId, id: p.id, accessKey: p.accessKey },
    )
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
        <Artwork src={art.src} mosaic={art.mosaic} size="100%" radius={12} seed={p.title} style={{ aspectRatio: '1', height: 'auto' }} />
        <div className={s.coverActions}>
          <button
            type="button"
            className={s.coverBtn}
            aria-label={`Играть «${p.title}»`}
            onClick={async (e) => {
              e.stopPropagation()
              if (busy) return
              setBusy(true)
              try {
                await playPlaylist(p)
              } finally {
                setBusy(false)
              }
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
      <button type="button" className={s.cardTitle} title={p.title} onClick={open}>
        {p.title}
      </button>
      {(() => {
        const sub = playlistSubtitle(p)
        return (
          <div className={s.cardSub} title={sub || undefined}>
            {sub}
          </div>
        )
      })()}
      {note}
      {p.plays && (
        <div className={s.cardPlays} title={formatPlays(p.plays)}>
          <Headphones size={12} strokeWidth={2.2} aria-hidden="true" />
          <span className="truncate">{formatPlaysShort(p.plays)}</span>
        </div>
      )}
    </div>
  )
}

/** Another listener's playlist from "Слушайте друг друга": taste match, owner and a short preview. */
export function RecommendedCard({ item }: { item: RecommendedPlaylist }) {
  const { playlist: p, tracks } = item
  // VK's catalog.getAudio often omits `photo` on recommended playlists even when the playlist has a custom cover.
  const needMeta = (p.service ?? 'vk') === 'vk' && !p.cover && !isAlgorithmicVkPlaylist(p)
  const meta = useQuery({
    queryKey: ['playlist', p.ownerId, p.id],
    queryFn: () => vk.getPlaylist(p.ownerId, p.id, p.accessKey),
    enabled: needMeta,
    staleTime: 30 * 60_000,
    retry: false,
  })
  const resolved: Playlist = meta.data
    ? {
        ...p,
        cover: meta.data.cover ?? p.cover,
        covers: meta.data.covers.length ? meta.data.covers : p.covers,
        count: meta.data.count || p.count,
      }
    : p
  const art = usePlaylistCovers(resolved, tracks)
  const waitingMetaCover = needMeta && meta.isPending && meta.fetchStatus === 'fetching' && !resolved.cover && resolved.covers.length === 0
  const backdrop = resolved.cover || (!waitingMetaCover ? (art.src || art.mosaic?.[0]) : undefined) || item.background
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
          showMenu(e, playlistMenuItems(resolved, undefined))
        }}
      >
        {backdrop && <img className={s.recBg} src={backdrop} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />}
        <div className={s.recTop}>
          <div className={s.recMatch}>
            <b>{Math.round(item.match * 100)}%</b>
            <span className="truncate">{item.matchTitle}</span>
          </div>
          <button
            type="button"
            className={`${s.coverBtn} ${s.recPlay}`}
            aria-label={`Играть «${p.title}»`}
            onClick={async (e) => {
              e.stopPropagation()
              if (busy) return
              setBusy(true)
              try {
                await playPlaylist(resolved)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner size={15} /> : <IconPlay size={15} />}
          </button>
        </div>
        <div className={s.recMain}>
          <div className={s.recCover}>
            <Artwork
              src={waitingMetaCover ? undefined : art.src}
              mosaic={waitingMetaCover ? undefined : art.mosaic}
              size={64}
              radius={10}
              seed={p.title}
            />
          </div>
          <div className={s.recMeta}>
            <div className={s.recTitle} title={p.title}>{p.title}</div>
            {p.ownerName && (
              <div className={s.recOwner} title={p.ownerName}>
                <Artwork src={item.ownerPhoto} size={16} radius={8} seed={p.ownerName} />
                <span className="truncate">{p.ownerName}</span>
              </div>
            )}
          </div>
        </div>
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
                <Artwork src={t.cover?.s} size={38} radius={6} seed={t.key} />
                {t.playable && (
                  <span className={s.recArtPlay} data-on={(current && isPlaying) || undefined} aria-hidden="true">
                    {current && isPlaying ? <EqualizerBars playing height={12} color="#fff" /> : <IconPlay size={14} />}
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

/** The mix card glows in the wallpaper's colours: the playing cover under a dynamic wallpaper,
 *  a preset's own colours, or plain glass over a picture or video of your own. */
function mixAura(w: WallpaperConfig, cover: string | undefined): { kind: 'cover'; src: string } | { kind: 'colors'; colors: [string, string, string] } | { kind: 'glass' } {
  if (w.kind === 'dynamic') return cover ? { kind: 'cover', src: cover } : { kind: 'colors', colors: PRESETS.dusk.colors }
  if (w.kind === 'preset') return { kind: 'colors', colors: PRESETS[w.preset].colors }
  return { kind: 'glass' }
}

export function MixHero({
  title,
  covers = [],
  service = 'vk',
}: {
  title: string
  covers?: string[]
  service?: 'vk' | 'spotify'
}) {
  const source = usePlayer((p) => p.source)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const current = usePlayer((p) => p.current)
  const queue = usePlayer((p) => p.queue)
  const [busy, setBusy] = useState(false)
  const wallpaper = useSettings((x) => x.wallpaper)
  const visible = useWindowVisibility((x) => x.visible)
  const nowPlaying = useUi((u) => u.nowPlaying)
  const playingMix = source?.kind === 'mix' && (source.service ?? 'vk') === service
  const live = playingMix && current ? current : null
  // Front card first: only real track covers from what plays now / comes next, topped up from the catalog.
  const stack: string[] = []
  if (live) {
    const fromQueue = pickRealTrackCovers([live, ...(queue ? upcoming(queue) : []), ...(queue ? queue.items : [])], 3)
    for (const c of fromQueue) if (!stack.includes(c)) stack.push(c)
  }
  for (const c of covers) {
    if (stack.length >= 3) break
    if (typeof c === 'string' && c.length > 0 && !stack.includes(c)) stack.push(c)
  }
  const aura = mixAura(wallpaper, stack[0] ?? current?.cover?.m)
  return (
    <section
      className={s.mix}
      aria-label={title.replace(/^Слушать\s+/i, '')}
      data-service={service}
      data-live={(playingMix && isPlaying) || undefined}
      data-paused={!visible || nowPlaying || undefined}
      data-aura={aura.kind}
      style={aura.kind === 'colors' ? ({ ['--aura-1' as string]: aura.colors[0], ['--aura-2' as string]: aura.colors[1], ['--aura-3' as string]: aura.colors[2] } as CSSProperties) : undefined}
    >
      <div className={s.mixAura} aria-hidden="true">
        {aura.kind === 'cover' ? (
          <img className={s.mixAuraCover} src={aura.src} alt="" referrerPolicy="no-referrer" />
        ) : (
          <>
            <i />
            <i />
            <i />
          </>
        )}
      </div>
      <div className={s.mixBody}>
        <h2 className={s.mixTitle}>{title.replace(/^Слушать\s+/i, '')}</h2>
        <div className={s.mixActions}>
          <button
            type="button"
            className={s.mixPlay}
            onClick={async () => {
              if (playingMix) {
                usePlayer.getState().toggle()
                return
              }
              if (busy) return
              setBusy(true)
              try {
                await usePlayer.getState().playMix(service)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner size={18} /> : playingMix && isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
            {playingMix && isPlaying ? 'Пауза' : playingMix ? 'Продолжить' : 'Слушать'}
          </button>
          {playingMix && (
            <button type="button" className={s.mixNext} onClick={() => usePlayer.getState().next(true)}>
              <IconForward size={16} /> Дальше
            </button>
          )}
        </div>
      </div>
      <div className={s.mixStack} aria-hidden="true">
        {[2, 1, 0].filter((i) => !!stack[i]).map((i) => (
          <div key={i} className={s.mixCover} data-i={i}>
            <Artwork src={stack[i]} size="100%" radius={14} seed={`mix-${i}`} style={{ aspectRatio: '1', height: 'auto' }} />
            {i === 0 && playingMix && isPlaying && (
              <span className={s.mixEq}>
                <EqualizerBars playing height={14} color="#fff" />
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
