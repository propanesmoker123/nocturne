import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Clock3,
  Compass,
  Copy,
  Disc3,
  Heart,
  ListMusic,
  Mic2,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Shuffle,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useChrome } from '../app/chrome'
import { showMenu } from '../app/menu'
import { useRouter } from '../app/router'
import { toast } from '../app/toast'
import { playlistMenuItems } from '../app/trackActions'
import { Artwork } from '../components/Artwork'
import {
  CardsSkeleton,
  Carousel,
  EmptyState,
  MixHero,
  PlaylistCard,
  playPlaylist,
  Section,
  TrackListSkeleton,
} from '../components/cards'
import { Button, IconButton, Spinner } from '../components/controls'
import { IconMore, IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { filterTracks, formatLongDuration, formatPlaysShort, pluralRu } from '../lib/format'
import p from '../pages/pages.module.css'
import { usePlayer } from '../player/store'
import type { Playlist, Track } from '../vk/models'
import * as spotify from './api'
import type { SpotifyBrowseCard, SpotifySpotlightItem, SpotifyUser } from './api'
import { spKeys } from './queries'
import { spotifyError, watchSpotifyPage } from './runtime'
import { useSpotifySession } from './session'
import sp from './SpotifyPage.module.css'

function SpotifyErrorView({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const refresh = useSpotifySession((s) => s.refresh)
  const msg = spotifyError(error)
  const signedOut = msg.includes('SIGNED_OUT')
  return (
    <div className={sp.emptyWrap}>
      <EmptyState
        icon={<Sparkles size={26} />}
        title={signedOut ? 'Нужно обновить сессию Spotify' : title}
        text={signedOut ? 'Срок действия веб-сессии Spotify истёк. Нажмите кнопку ниже для обновления.' : msg}
      />
      <div className={sp.emptyActions}>
        <Button
          variant="primary"
          onClick={() => {
            if (signedOut) void refresh(true).then(onRetry)
            else onRetry()
          }}
        >
          <RefreshCw size={15} /> {signedOut ? 'Обновить сессию' : 'Повторить'}
        </Button>
      </div>
    </div>
  )
}

function SpArtistTile({ artist, grid = false }: { artist: SpotifyUser; grid?: boolean }) {
  const push = useRouter((r) => r.push)
  return (
    <button
      type="button"
      className={grid ? `${sp.artistCard} ${sp.artistCardGrid}` : sp.artistCard}
      onClick={() => push({ name: 'spotify-artist', id: artist.id, title: artist.name })}
    >
      <Artwork src={artist.avatar} size={136} radius={999} seed={artist.name} />
      <span className={`${sp.artistName} truncate`}>{artist.name}</span>
      <span className={sp.artistSub}>Исполнитель</span>
    </button>
  )
}

function SpSpotlightCard({ item }: { item: SpotifySpotlightItem }) {
  const push = useRouter((r) => r.push)
  const [busy, setBusy] = useState(false)
  const pl = item.playlist
  const open = () => push({ name: 'spotify-playlist', id: pl.spotifyId!, kind: pl.type, title: pl.title })
  const meta = pl.ownerName ? `${item.kindLabel} · ${pl.ownerName}` : item.kindLabel

  return (
    <div className={sp.spotlightItem}>
      <div className={sp.spotlightEyebrow} title={item.eyebrow}>
        {item.eyebrow}
      </div>
      <div
        className={sp.spotlightCard}
        role="link"
        tabIndex={0}
        aria-label={`${item.eyebrow}: ${pl.title}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            open()
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          showMenu(e, playlistMenuItems(pl, undefined))
        }}
      >
        {pl.cover && (
          <img
            className={sp.spotlightBg}
            src={pl.cover}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
          />
        )}
        <div className={sp.spotlightScrim} aria-hidden="true" />
        <div className={sp.spotlightInner}>
          <div className={sp.spotlightHead}>
            <Artwork src={pl.cover} size={46} radius={8} seed={pl.title} />
            <div className={sp.spotlightMeta}>
              <div className={sp.spotlightTitle}>{pl.title}</div>
              <div className={sp.spotlightSub}>{meta}</div>
            </div>
          </div>
          <div className={sp.spotlightFoot}>
            <div className={sp.spotlightDesc}>
              {pl.description || (pl.type === 'album' && pl.year ? `Релиз · ${pl.year}` : '')}
            </div>
            <div className={sp.spotlightActions}>
              <button
                type="button"
                className={sp.spotlightBtn}
                aria-label="Ещё"
                onClick={(e) => {
                  e.stopPropagation()
                  showMenu(e, playlistMenuItems(pl, undefined))
                }}
              >
                <IconMore size={16} />
              </button>
              <button
                type="button"
                className={`${sp.spotlightBtn} ${sp.spotlightPlayBtn}`}
                aria-label={`Играть «${pl.title}»`}
                onClick={async (e) => {
                  e.stopPropagation()
                  if (busy) return
                  setBusy(true)
                  await playPlaylist(pl)
                  setBusy(false)
                }}
              >
                {busy ? <Spinner size={15} /> : <IconPlay size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SpBrowseTile({ card }: { card: SpotifyBrowseCard }) {
  const push = useRouter((r) => r.push)
  return (
    <button
      type="button"
      className={sp.browseCard}
      style={card.color ? ({ ['--tile-color' as string]: card.color } as React.CSSProperties) : undefined}
      onClick={() => {
        if (card.id && (card.kind === 'playlist' || card.kind === 'album')) {
          push({ name: 'spotify-playlist', id: card.id, kind: card.kind, title: card.title })
        } else if (card.id && card.kind === 'artist') {
          push({ name: 'spotify-artist', id: card.id, title: card.title })
        } else {
          push({ name: 'spotify-search', q: `genre:${card.title}`, ...(card.uri ? { uri: card.uri } : {}) })
        }
      }}
    >
      <span className={sp.browseLabel}>{card.title}</span>
      {card.image && <img className={sp.browseImg} src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </button>
  )
}

function SpSignIn() {
  const { regionBlocked, loginWaiting, signingIn, error, startLogin, finishLogin, cancelLogin, refresh } = useSpotifySession()

  if (regionBlocked) {
    return (
      <div className={sp.signCard}>
        <div className={sp.signIcon}><Compass size={26} /></div>
        <h2 className={sp.signTitle}>Spotify недоступен в этом регионе</h2>
        <p className={sp.signDesc}>Включите VPN для входа или воспроизведения и повторите проверку.</p>
        <div className={sp.signActions}>
          <Button variant="primary" onClick={() => void refresh(true)}>Проверить снова</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={sp.signCard}>
      <div className={sp.signIcon}><Sparkles size={26} /></div>
      <h2 className={sp.signTitle}>Подключите Spotify</h2>
      <p className={sp.signDesc}>
        Войдите в аккаунт Spotify в отдельном окне Chrome. Nocturne подхватит вашу медиатеку, рекомендации и плейлисты в тёмном интерфейсе без рекламы.
      </p>
      {error && <p className={sp.signErr}>{error}</p>}
      <div className={sp.signActions}>
        {loginWaiting ? (
          <>
            <Button variant="primary" disabled={signingIn} onClick={() => void finishLogin()}>
              {signingIn ? <Spinner size={15} /> : <Check size={16} />} Готово, я вошёл
            </Button>
            <Button variant="gray" disabled={signingIn} onClick={() => void cancelLogin()}>Отмена</Button>
          </>
        ) : (
          <Button variant="primary" disabled={signingIn} onClick={() => void startLogin()}>
            {signingIn && <Spinner size={15} />} Войти через Chrome
          </Button>
        )}
      </div>
    </div>
  )
}

function SpGate({ children }: { children: ReactNode }) {
  const phase = useSpotifySession((s) => s.phase)
  const regionBlocked = useSpotifySession((s) => s.regionBlocked)
  const refresh = useSpotifySession((s) => s.refresh)

  useEffect(() => {
    const off = watchSpotifyPage()
    if (phase === 'checking') void refresh(true)
    return off
  }, [phase, refresh])

  if (phase === 'checking') {
    return (
      <div className={sp.loadingCenter}>
        <Spinner size={28} />
        <span>Подключаем Spotify…</span>
      </div>
    )
  }
  if (phase === 'signed-out' || regionBlocked) return <SpSignIn />
  return <>{children}</>
}

function playSpotifyTracks(tracks: Track[], index = 0, shuffle = false, label?: string, contextUri?: string) {
  const playable = tracks.filter((t) => t.playable)
  if (!playable.length) {
    toast('В этом списке пока нет доступных треков', 'info')
    return
  }
  const targetKey = tracks[index]?.key
  const mappedIndex = targetKey ? Math.max(0, playable.findIndex((t) => t.key === targetKey)) : 0
  usePlayer.getState().playList(playable, mappedIndex, {
    shuffle,
    source: { kind: 'list', service: 'spotify', label, ...(contextUri ? { contextUri } : {}) },
  })
}

function SpotifyHomeBody() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: spKeys.home(), queryFn: spotify.getHome })
  const data = q.data

  const heroCovers = useMemo(() => {
    const pool = [
      ...(data?.recentTracks ?? []).map((t) => t.cover?.m),
      ...(data?.topTracks ?? []).map((t) => t.cover?.m),
      ...(data?.playlists ?? []).map((pl) => pl.cover),
    ]
    return [...new Set(pool.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, 4)
  }, [data])

  const shownTitles = useMemo(() => new Set((data?.sections ?? []).map((s) => s.title.toLowerCase())), [data])
  const { primarySections, secondarySections, extraTopArtists } = useMemo(() => {
    const all = (data?.sections ?? []).slice(0, 10)
    const primary = all.filter((s) => s.personalized !== false)
    const secondary = all.filter((s) => s.personalized === false)
    const shownArtistIds = new Set(all.flatMap((s) => s.artists.map((a) => a.id)))
    const extraArtists = (data?.topArtists ?? []).filter((a) => !shownArtistIds.has(a.id))
    return { primarySections: primary, secondarySections: secondary, extraTopArtists: extraArtists }
  }, [data])

  const renderHomeSection = (sec: spotify.SpotifyHomeSection) => {
    if (sec.playlists.length > 0) {
      return (
        <Section key={sec.id} title={sec.title} subtitle={sec.subtitle}>
          <Carousel>
            {sec.playlists.slice(0, 12).map((pl) => (
              <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
            ))}
          </Carousel>
        </Section>
      )
    }
    if (sec.artists.length > 0) {
      return (
        <Section key={sec.id} title={sec.title} subtitle={sec.subtitle}>
          <Carousel>
            {sec.artists.slice(0, 12).map((ar) => (
              <SpArtistTile key={ar.id} artist={ar} />
            ))}
          </Carousel>
        </Section>
      )
    }
    if (sec.tracks.length > 0) {
      return (
        <Section
          key={sec.id}
          title={sec.title}
          subtitle={sec.subtitle}
          action={
            sec.tracks.length > 3
              ? { label: 'Слушать', onClick: () => playSpotifyTracks(sec.tracks, 0, false, sec.title) }
              : undefined
          }
        >
          <TrackList tracks={sec.tracks.slice(0, 8)} />
        </Section>
      )
    }
    return null
  }

  return (
    <>
      <PageHeader
        title={data?.greeting || 'Для вас'}
        subtitle="Spotify"
        actions={
          <IconButton
            label="Обновить рекомендации"
            disabled={q.isFetching}
            onClick={() => void qc.invalidateQueries({ queryKey: spKeys.home() })}
          >
            <RefreshCw size={17} className={q.isFetching ? sp.refreshSpin : undefined} />
          </IconButton>
        }
      />

      {q.isLoading && (
        <>
          <CardsSkeleton />
          <TrackListSkeleton rows={6} />
        </>
      )}

      {q.isError && <SpotifyErrorView title="Рекомендации не загрузились" error={q.error} onRetry={() => void q.refetch()} />}

      {!q.isLoading && !q.isError && data && (
        <>
          <MixHero title="Spotify Микс" covers={heroCovers} service="spotify" />

          {primarySections.map(renderHomeSection)}

          {(data.spotlights?.length ?? 0) > 0 && (
            <Section title="Похоже на твои вкусы" subtitle="Индивидуальные подборки, радио и релизы">
              <div className={sp.spotlightGrid}>
                {data.spotlights!.slice(0, 16).map((item) => (
                  <SpSpotlightCard key={item.id} item={item} />
                ))}
              </div>
            </Section>
          )}

          {secondarySections.map(renderHomeSection)}

          {data.recentTracks.length > 0 && !shownTitles.has('недавно слушали') && !shownTitles.has('недавно прослушано') && (
            <Section
              title="Недавно слушали"
              action={{ label: 'Слушать', onClick: () => playSpotifyTracks(data.recentTracks, 0, false, 'Недавнее · Spotify') }}
            >
              <TrackList tracks={data.recentTracks.slice(0, 6)} />
            </Section>
          )}

          {extraTopArtists.length >= 2 && (
            <Section title={shownTitles.has('любимые исполнители') ? 'Вы подписаны' : 'Любимые исполнители'}>
              <Carousel>
                {extraTopArtists.slice(0, 12).map((a) => (
                  <SpArtistTile key={a.id} artist={a} />
                ))}
              </Carousel>
            </Section>
          )}

          {data.playlists.length > 0 && !shownTitles.has('ваши плейлисты') && (
            <Section title="Ваши плейлисты">
              <Carousel>
                {data.playlists.slice(0, 12).map((pl) => (
                  <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
                ))}
              </Carousel>
            </Section>
          )}

          {data.topTracks.length > 0 && (
            <Section
              title="Часто слушаете"
              action={{ label: 'Слушать всё', onClick: () => playSpotifyTracks(data.topTracks, 0, false, 'Часто слушаете') }}
            >
              <TrackList tracks={data.topTracks.slice(0, 10)} />
            </Section>
          )}

          {!(data.sections?.length) && !data.topTracks.length && !data.playlists.length && !data.recentTracks.length && (
            <EmptyState
              icon={<Sparkles size={26} />}
              title="Рекомендации пока пусты"
              text="Послушайте пару треков или найдите любимых исполнителей через поиск Spotify."
            />
          )}
        </>
      )}
    </>
  )
}

function SpotifyBrowseBody() {
  const q = useQuery({ queryKey: spKeys.browse(), queryFn: spotify.getBrowseCategories })
  const items = q.data ?? []

  return (
    <>
      <PageHeader title="Обзор" subtitle="Жанры, настроения и подборки Spotify" />
      {q.isLoading && <CardsSkeleton count={12} />}
      {q.isError && <SpotifyErrorView title="Категории не загрузились" error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <EmptyState icon={<Compass size={26} />} title="Категории не найдены" text="Попробуйте открыть поиск Spotify." />
      )}
      {items.length > 0 && (
        <div className={sp.browseGrid}>
          {items.map((card, i) => (
            <SpBrowseTile key={`${card.uri || card.title}-${i}`} card={card} />
          ))}
        </div>
      )}
    </>
  )
}

function SpotifyLikesBody() {
  const [filter, setFilter] = useState('')
  const q = useInfiniteQuery({
    queryKey: spKeys.likes(),
    queryFn: ({ pageParam = 0 }) => spotify.getLikes(pageParam, 50),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  })

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    if (filter.trim() && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [filter, hasNextPage, isFetchingNextPage, fetchNextPage])

  const allTracks = useMemo(() => {
    const seen = new Set<string>()
    const list: Track[] = []
    for (const page of q.data?.pages ?? []) {
      for (const t of page.items) {
        if (!seen.has(t.key)) {
          seen.add(t.key)
          list.push(t)
        }
      }
    }
    return list
  }, [q.data])

  const shown = useMemo(() => filterTracks(allTracks, filter), [allTracks, filter])
  const total = q.data?.pages[0]?.total ?? allTracks.length
  const totalSec = useMemo(() => allTracks.reduce((sum, t) => sum + t.duration, 0), [allTracks])

  return (
    <>
      <PageHeader
        title="Любимые треки"
        subtitle={[
          total ? `${total} ${pluralRu(total, 'трек', 'трека', 'треков')}` : null,
          !q.hasNextPage && totalSec > 0 ? formatLongDuration(totalSec) : null,
          'Spotify',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          allTracks.length > 0 && (
            <>
              <Button variant="primary" onClick={() => playSpotifyTracks(shown, 0, false, 'Любимые треки', 'spotify:collection:tracks')}>
                <IconPlay size={15} /> Слушать
              </Button>
              <Button variant="tinted" onClick={() => playSpotifyTracks(shown, 0, true, 'Любимые треки', 'spotify:collection:tracks')}>
                <Shuffle size={15} strokeWidth={2.2} /> Перемешать
              </Button>
            </>
          )
        }
      />

      {q.isLoading && <TrackListSkeleton rows={12} />}
      {q.isError && <SpotifyErrorView title="Любимые треки не загрузились" error={q.error} onRetry={() => void q.refetch()} />}

      {!q.isLoading && !q.isError && allTracks.length === 0 && (
        <EmptyState
          icon={<Heart size={26} />}
          title="В любимых пока пусто"
          text="Отмечайте треки сердцем в Spotify или в Nocturne — они сразу появятся здесь."
        />
      )}

      {allTracks.length > 0 && (
        <>
          <div className={sp.toolbar}>
            <div className={sp.filterWrap}>
              <Search size={15} className={sp.filterIcon} />
              <input
                type="search"
                className={sp.filterInput}
                placeholder="Поиск по любимым трекам…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && filter) {
                    e.stopPropagation()
                    setFilter('')
                  }
                }}
                aria-label="Поиск по любимым трекам"
              />
              {filter && (
                <button type="button" className={sp.filterClear} aria-label="Очистить фильтр" onClick={() => setFilter('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            {filter.trim() && (
              <span className={sp.filterCount}>
                {shown.length} из {allTracks.length}
                {q.hasNextPage ? '+' : ''}
              </span>
            )}
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={<Search size={24} />} title="Ничего не найдено" text="Попробуйте изменить запрос фильтра." />
          ) : (
            <TrackList tracks={shown} queueMeta={{ kind: 'list', service: 'spotify', label: 'Любимые треки', contextUri: 'spotify:collection:tracks' }} />
          )}

          {q.hasNextPage && (
            <div className={sp.moreRow}>
              <Button variant="gray" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? <Spinner size={15} /> : <Plus size={15} />} Загрузить ещё ({allTracks.length} / {total})
              </Button>
            </div>
          )}
        </>
      )}
    </>
  )
}

function SpotifyAlbumsBody() {
  const q = useQuery({ queryKey: spKeys.albums(), queryFn: () => spotify.getMyAlbums(0, 50) })
  const items = q.data?.items ?? []

  return (
    <>
      <PageHeader
        title="Альбомы"
        subtitle={items.length ? `${items.length} ${pluralRu(items.length, 'альбом', 'альбома', 'альбомов')} · Spotify` : 'Spotify'}
      />
      {q.isLoading && <CardsSkeleton count={8} />}
      {q.isError && <SpotifyErrorView title="Альбомы не загрузились" error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <EmptyState icon={<Disc3 size={26} />} title="Сохранённых альбомов пока нет" text="Откройте любой альбом и нажмите «Сохранить»." />
      )}
      {items.length > 0 && (
        <div className={sp.grid}>
          {items.map((pl) => (
            <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
          ))}
        </div>
      )}
    </>
  )
}

function SpotifyArtistsBody() {
  const q = useQuery({ queryKey: spKeys.artists(), queryFn: () => spotify.getFollowedArtists(0, 50) })
  const items = q.data ?? []

  return (
    <>
      <PageHeader
        title="Исполнители"
        subtitle={items.length ? `${items.length} ${pluralRu(items.length, 'исполнитель', 'исполнителя', 'исполнителей')} · Spotify` : 'Spotify'}
      />
      {q.isLoading && <CardsSkeleton count={8} />}
      {q.isError && <SpotifyErrorView title="Исполнители не загрузились" error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <EmptyState icon={<Users size={26} />} title="Подписок пока нет" text="Подпишитесь на артиста в его профиле Spotify." />
      )}
      {items.length > 0 && (
        <div className={sp.grid}>
          {items.map((a) => (
            <SpArtistTile key={a.id} artist={a} grid />
          ))}
        </div>
      )}
    </>
  )
}

function SpotifyRecentBody() {
  const q = useQuery({ queryKey: spKeys.recent(), queryFn: () => spotify.getRecentTracks(30) })
  const tracks = q.data ?? []

  return (
    <>
      <PageHeader
        title="Недавнее"
        subtitle="Недавно прослушанное в Spotify"
        actions={
          tracks.length > 0 && (
            <Button variant="primary" onClick={() => playSpotifyTracks(tracks, 0, false, 'Недавнее · Spotify')}>
              <IconPlay size={15} /> Слушать
            </Button>
          )
        }
      />
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.isError && <SpotifyErrorView title="История не загрузилась" error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.isError && tracks.length === 0 && (
        <EmptyState icon={<Clock3 size={26} />} title="История пока пуста" text="Включите трек в Spotify, и он появится в списке недавних." />
      )}
      {tracks.length > 0 && <TrackList tracks={tracks} />}
    </>
  )
}

function SpotifyPlaylistsBody() {
  const q = useQuery({ queryKey: spKeys.myPlaylists(), queryFn: spotify.getMyPlaylists })
  const items = q.data ?? []

  return (
    <>
      <PageHeader
        title="Плейлисты"
        subtitle={items.length ? `${items.length} ${pluralRu(items.length, 'плейлист', 'плейлиста', 'плейлистов')} · Spotify` : 'Spotify'}
      />
      {q.isLoading && <CardsSkeleton count={8} />}
      {q.isError && <SpotifyErrorView title="Плейлисты не загрузились" error={q.error} onRetry={() => void q.refetch()} />}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <EmptyState icon={<ListMusic size={26} />} title="Плейлистов пока нет" text="Создайте или сохраните плейлист в Spotify — он сразу появится здесь." />
      )}
      {items.length > 0 && (
        <div className={sp.grid}>
          {items.map((pl) => (
            <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
          ))}
        </div>
      )}
    </>
  )
}

export function SpotifyPage() {
  const page = useRouter((r) => (r.route.name === 'spotify' ? (r.route.page ?? 'home') : 'home'))
  return (
    <SpGate>
      {page === 'browse' ? (
        <SpotifyBrowseBody />
      ) : page === 'liked' ? (
        <SpotifyLikesBody />
      ) : page === 'albums' ? (
        <SpotifyAlbumsBody />
      ) : page === 'artists' ? (
        <SpotifyArtistsBody />
      ) : page === 'recent' ? (
        <SpotifyRecentBody />
      ) : page === 'library' ? (
        <SpotifyPlaylistsBody />
      ) : (
        <SpotifyHomeBody />
      )}
    </SpGate>
  )
}

export function SpotifyPlaylistPage({ id, kind = 'playlist', title: initialTitle }: { id: string; kind?: 'playlist' | 'album'; title?: string }) {
  const qc = useQueryClient()
  const setTitle = useChrome((c) => c.setTitle)
  const q = useQuery({
    queryKey: spKeys.playlist(id, kind),
    queryFn: () => spotify.getPlaylistOrAlbum(id, kind),
  })
  const albumsQ = useQuery({
    queryKey: spKeys.albums(),
    queryFn: () => spotify.getMyAlbums(0, 50),
    enabled: kind === 'album',
  })
  const myPlaylistsQ = useQuery({
    queryKey: spKeys.myPlaylists(),
    queryFn: spotify.getMyPlaylists,
    enabled: kind === 'playlist',
  })
  const editableQ = useQuery({
    queryKey: spKeys.editablePlaylists(),
    queryFn: spotify.getEditablePlaylists,
    enabled: kind === 'playlist',
  })

  const [loadingMore, setLoadingMore] = useState(false)
  const [savingLibrary, setSavingLibrary] = useState(false)
  const [radioBusy, setRadioBusy] = useState(false)

  const pl: Playlist | undefined = q.data?.playlist
  const tracks = useMemo(() => q.data?.tracks ?? [], [q.data?.tracks])

  useEffect(() => setTitle(pl?.title ?? initialTitle ?? ''), [pl?.title, initialTitle, setTitle])

  const isSavedAlbum = kind === 'album' && (albumsQ.data?.items ?? []).some((a) => a.spotifyId === id)
  const isEditable = kind === 'playlist' && (editableQ.data ?? []).some((p) => p.spotifyId === id)
  const isSavedPlaylist = kind === 'playlist' && (myPlaylistsQ.data ?? []).some((p) => p.spotifyId === id)
  const isSaved = kind === 'album' ? isSavedAlbum : isSavedPlaylist
  const totalCount = Math.max(tracks.length, pl?.count ?? 0)
  const totalSec = tracks.reduce((n, t) => n + t.duration, 0)

  const toggleSaveToLibrary = async () => {
    if (savingLibrary) return
    setSavingLibrary(true)
    try {
      const next = !isSaved
      if (kind === 'album') {
        await spotify.setAlbumSaved(id, next)
        await qc.invalidateQueries({ queryKey: spKeys.albums() })
        toast(next ? 'Альбом добавлен в медиатеку' : 'Альбом убран из медиатеки', next ? 'added' : 'removed')
      } else {
        await spotify.setPlaylistSaved(id, next)
        await qc.invalidateQueries({ queryKey: spKeys.myPlaylists() })
        toast(next ? 'Плейлист сохранён в медиатеку' : 'Плейлист убран из медиатеки', next ? 'added' : 'removed')
      }
    } catch (e) {
      toast(spotifyError(e), 'error')
    } finally {
      setSavingLibrary(false)
    }
  }

  const startRadio = async () => {
    if (radioBusy) return
    const seed = tracks[0]?.spotifyId ? `spotify:track:${tracks[0].spotifyId}` : kind === 'album' ? `spotify:album:${id}` : ''
    if (!seed) return
    setRadioBusy(true)
    try {
      const radio = await spotify.getTrackRadio(seed)
      const list = radio.length ? radio : tracks
      if (!list.length) {
        toast('Не удалось подобрать радио', 'error')
        return
      }
      usePlayer.getState().playList(list, 0, {
        shuffle: false,
        source: { kind: 'mix', service: 'spotify', label: `Радио · ${pl?.title ?? initialTitle ?? 'Spotify'}`, seed },
      })
    } catch (e) {
      toast(spotifyError(e), 'error')
    } finally {
      setRadioBusy(false)
    }
  }

  const loadMoreTracks = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const page = await spotify.getPlaylistTracksPage(id, kind, tracks.length, 100)
      if (page.tracks.length) {
        qc.setQueryData<{ playlist: Playlist; tracks: Track[] }>(spKeys.playlist(id, kind), (old) => {
          if (!old) return old
          const seen = new Set(old.tracks.map((t) => `${t.key}:${t.spotifyUid ?? ''}`))
          const fresh = page.tracks.filter((t) => !seen.has(`${t.key}:${t.spotifyUid ?? ''}`))
          return { ...old, tracks: [...old.tracks, ...fresh] }
        })
      }
    } catch (e) {
      toast(spotifyError(e), 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  const menuExtra = isEditable
    ? (t: Track) =>
        t.spotifyUid
          ? [
              {
                label: 'Убрать из плейлиста',
                icon: <Trash2 size={15} />,
                danger: true,
                onSelect: async () => {
                  const uid = t.spotifyUid!
                  try {
                    await spotify.removeTrackFromPlaylist(id, uid)
                    qc.setQueryData<{ playlist: Playlist; tracks: Track[] }>(spKeys.playlist(id, kind), (old) => {
                      if (!old) return old
                      const nextTracks = old.tracks.filter((x) => x.spotifyUid !== uid)
                      return {
                        playlist: { ...old.playlist, count: Math.max(nextTracks.length, old.playlist.count - 1) },
                        tracks: nextTracks,
                      }
                    })
                    void qc.invalidateQueries({ queryKey: spKeys.myPlaylists() })
                    toast('Трек убран из плейлиста', 'removed')
                  } catch (e) {
                    toast(spotifyError(e), 'error')
                  }
                },
              },
            ]
          : []
    : undefined

  return (
    <SpGate>
      {q.isError && <SpotifyErrorView title="Плейлист недоступен" error={q.error} onRetry={() => void q.refetch()} />}

      {!q.isError && (
        <>
          <div className={p.hero}>
            <Artwork
              className={p.heroArt}
              src={pl?.cover}
              mosaic={pl?.covers}
              size={220}
              radius={14}
              seed={pl?.title ?? id}
            />
            <div style={{ minWidth: 0 }}>
              <h1 className={p.heroTitle}>{pl?.title ?? initialTitle ?? '…'}</h1>
              {pl?.ownerName && <div className={p.heroOwner}>{pl.ownerName}</div>}
              <div className={p.heroMeta}>
                {[
                  kind === 'album' ? 'Альбом' : 'Плейлист',
                  totalCount ? `${totalCount} ${pluralRu(totalCount, 'трек', 'трека', 'треков')}` : null,
                  totalSec ? formatLongDuration(totalSec) : null,
                  pl?.year ? String(pl.year) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {pl?.description && <p className={p.heroDesc}>{pl.description}</p>}
              <div className={p.heroActions}>
                <Button
                  variant="primary"
                  disabled={!tracks.length}
                  onClick={() => playSpotifyTracks(tracks, 0, false, pl?.title, `spotify:${kind}:${id}`)}
                >
                  <IconPlay size={15} /> Слушать
                </Button>
                <Button
                  variant="tinted"
                  disabled={!tracks.length}
                  onClick={() => playSpotifyTracks(tracks, 0, true, pl?.title, `spotify:${kind}:${id}`)}
                >
                  <Shuffle size={15} strokeWidth={2.2} /> Перемешать
                </Button>
                {(tracks[0]?.spotifyId || kind === 'album') && (
                  <Button variant="gray" disabled={radioBusy} onClick={() => void startRadio()}>
                    {radioBusy ? <Spinner size={15} /> : <Radio size={15} />} Радио
                  </Button>
                )}
                {(kind === 'album' || !isEditable) && (
                  <Button variant="gray" disabled={savingLibrary} onClick={() => void toggleSaveToLibrary()}>
                    <Heart size={15} fill={isSaved ? 'currentColor' : 'none'} />
                    {isSaved ? 'В медиатеке' : 'Сохранить'}
                  </Button>
                )}
                {pl && (
                  <IconButton label="Ещё" onClick={(e) => showMenu(e, playlistMenuItems({ ...pl, isFollowed: isSaved }, tracks))}>
                    <IconMore size={20} />
                  </IconButton>
                )}
              </div>
            </div>
          </div>

          {q.isLoading && <TrackListSkeleton rows={10} />}
          {!q.isLoading && tracks.length === 0 && (
            <EmptyState icon={<ListMusic size={26} />} title="Треков пока нет" text="В этом списке пока нет доступных композиций." />
          )}
          {tracks.length > 0 && <TrackList tracks={tracks} playlist={pl} queueMeta={{ kind: 'list', service: 'spotify', label: pl?.title, contextUri: `spotify:${kind}:${id}` }} menuExtra={menuExtra} />}

          {!q.isLoading && totalCount > tracks.length && (
            <div className={sp.moreRow}>
              <Button variant="gray" disabled={loadingMore} onClick={() => void loadMoreTracks()}>
                {loadingMore ? <Spinner size={15} /> : <Plus size={15} />} Загрузить ещё треки ({tracks.length} / {totalCount})
              </Button>
            </div>
          )}
        </>
      )}
    </SpGate>
  )
}

export function SpotifyArtistPage({ id, title: initialTitle }: { id: string; title?: string }) {
  const qc = useQueryClient()
  const setTitle = useChrome((c) => c.setTitle)
  const q = useQuery({ queryKey: spKeys.artist(id), queryFn: () => spotify.getArtist(id) })
  const relQ = useQuery({ queryKey: spKeys.artistRelated(id), queryFn: () => spotify.getArtistRelated(id) })
  const followingQ = useQuery({ queryKey: spKeys.artists(), queryFn: () => spotify.getFollowedArtists(0, 50) })

  const [followBusy, setFollowBusy] = useState(false)
  const [radioBusy, setRadioBusy] = useState(false)

  const artist = q.data?.artist
  const tracks = q.data?.tracks ?? []
  const releases = q.data?.albums ?? []
  const related = relQ.data ?? []
  const isFollowed = artist?.saved ?? (followingQ.data ?? []).some((a) => a.id === id)
  const albumsOnly = useMemo(() => releases.filter((a) => a.albumType !== 'single'), [releases])
  const singlesOnly = useMemo(() => releases.filter((a) => a.albumType === 'single'), [releases])

  useEffect(() => setTitle(artist?.name ?? initialTitle ?? ''), [artist?.name, initialTitle, setTitle])

  const artistSubtitle = artist?.monthlyListeners
    ? `${formatPlaysShort(artist.monthlyListeners)} слушателей в месяц · Spotify`
    : artist?.followers
      ? `${formatPlaysShort(artist.followers)} подписчиков · Spotify`
      : 'Исполнитель · Spotify'

  const toggleFollow = async () => {
    if (followBusy) return
    setFollowBusy(true)
    try {
      await spotify.setArtistFollowed(id, !isFollowed)
      await Promise.all([
        qc.invalidateQueries({ queryKey: spKeys.artists() }),
        qc.invalidateQueries({ queryKey: spKeys.artist(id) }),
      ])
      toast(!isFollowed ? `Вы подписались на ${artist?.name ?? 'исполнителя'}` : 'Подписка отменена', !isFollowed ? 'added' : 'removed')
    } catch (e) {
      toast(spotifyError(e), 'error')
    } finally {
      setFollowBusy(false)
    }
  }

  const startArtistRadio = async () => {
    if (radioBusy) return
    setRadioBusy(true)
    try {
      const radio = await spotify.getTrackRadio(`spotify:artist:${id}`)
      const list = radio.length ? radio : tracks
      if (!list.length) {
        toast('Не удалось собрать радио исполнителя', 'error')
        return
      }
      usePlayer.getState().playList(list, 0, {
        shuffle: false,
        source: { kind: 'mix', service: 'spotify', label: `Радио · ${artist?.name ?? initialTitle ?? 'Исполнитель'}`, seed: `spotify:artist:${id}` },
      })
    } catch (e) {
      toast(spotifyError(e), 'error')
    } finally {
      setRadioBusy(false)
    }
  }

  return (
    <SpGate>
      {q.isError && <SpotifyErrorView title="Профиль исполнителя не загрузился" error={q.error} onRetry={() => void q.refetch()} />}

      {!q.isError && (
        <>
          <div className={sp.artistHero}>
            <Artwork className={sp.artistAvatar} src={artist?.avatar} size={180} radius={999} seed={artist?.name ?? id} />
            <div style={{ minWidth: 0 }}>
              <h1 className={p.heroTitle}>{artist?.name ?? initialTitle ?? '…'}</h1>
              <div className={p.heroMeta}>{artistSubtitle}</div>
              <div className={p.heroActions}>
                <Button variant="primary" disabled={!tracks.length} onClick={() => playSpotifyTracks(tracks, 0, false, artist?.name, `spotify:artist:${id}`)}>
                  <IconPlay size={15} /> Слушать
                </Button>
                <Button variant="tinted" disabled={!tracks.length} onClick={() => playSpotifyTracks(tracks, 0, true, artist?.name, `spotify:artist:${id}`)}>
                  <Shuffle size={15} strokeWidth={2.2} /> Перемешать
                </Button>
                <Button variant="gray" disabled={radioBusy} onClick={() => void startArtistRadio()}>
                  {radioBusy ? <Spinner size={15} /> : <Radio size={15} />} Радио
                </Button>
                <Button variant="gray" disabled={followBusy} onClick={() => void toggleFollow()}>
                  {isFollowed ? <Check size={15} /> : <Plus size={15} />}
                  {isFollowed ? 'Вы подписаны' : 'Подписаться'}
                </Button>
                <IconButton
                  label="Ещё"
                  onClick={(e) =>
                    showMenu(e, [
                      {
                        label: 'Скопировать ссылку',
                        icon: <Copy size={15} />,
                        onSelect: () => {
                          void navigator.clipboard.writeText(`https://open.spotify.com/artist/${id}`)
                          toast('Ссылка скопирована', 'info')
                        },
                      },
                    ])
                  }
                >
                  <IconMore size={20} />
                </IconButton>
              </div>
            </div>
          </div>

          {q.isLoading && <TrackListSkeleton rows={8} />}

          {!q.isLoading && tracks.length > 0 && (
            <Section title="Популярные треки">
              <TrackList tracks={tracks} queueMeta={{ kind: 'list', service: 'spotify', label: artist?.name, contextUri: `spotify:artist:${id}` }} />
            </Section>
          )}

          {!q.isLoading && albumsOnly.length > 0 && singlesOnly.length > 0 ? (
            <>
              <Section title="Альбомы">
                <Carousel>
                  {albumsOnly.map((al) => (
                    <PlaylistCard key={al.spotifyId ?? al.id} playlist={al} />
                  ))}
                </Carousel>
              </Section>
              <Section title="Синглы и EP">
                <Carousel>
                  {singlesOnly.map((al) => (
                    <PlaylistCard key={al.spotifyId ?? al.id} playlist={al} />
                  ))}
                </Carousel>
              </Section>
            </>
          ) : (
            !q.isLoading &&
            releases.length > 0 && (
              <Section title="Релизы и альбомы">
                <Carousel>
                  {releases.map((al) => (
                    <PlaylistCard key={al.spotifyId ?? al.id} playlist={al} />
                  ))}
                </Carousel>
              </Section>
            )
          )}

          {related.length > 0 && (
            <Section title="Похожие исполнители">
              <Carousel>
                {related.map((rel) => (
                  <SpArtistTile key={rel.id} artist={rel} />
                ))}
              </Carousel>
            </Section>
          )}

          {!q.isLoading && !tracks.length && !releases.length && (
            <EmptyState icon={<Mic2 size={26} />} title="Треки не найдены" text="Spotify не вернул релизы для этого исполнителя." />
          )}
        </>
      )}
    </SpGate>
  )
}

function SpotifyCategoryView({ title, uri = '' }: { title: string; uri?: string }) {
  const push = useRouter((r) => r.push)
  const q = useQuery({
    queryKey: spKeys.category(title, '', uri),
    queryFn: () => spotify.getBrowseCategory(title, '', uri),
    enabled: title.length > 0 || uri.length > 0,
  })
  const data = q.data
  const displayTitle = data?.title || title
  const sections = data?.sections ?? []
  const subcategories = data?.subcategories ?? []
  const playlists = data?.playlists ?? []
  const tracks = data?.tracks ?? []
  const albums = data?.albums ?? []

  return (
    <>
      <PageHeader
        title={displayTitle}
        subtitle="Официальные подборки и плейлисты · Spotify"
        actions={
          <>
            {tracks.length > 0 && (
              <>
                <Button variant="primary" onClick={() => playSpotifyTracks(tracks, 0, false, displayTitle)}>
                  <IconPlay size={15} /> Слушать жанр
                </Button>
                <Button variant="tinted" onClick={() => playSpotifyTracks(tracks, 0, true, displayTitle)}>
                  <Shuffle size={15} strokeWidth={2.2} /> Перемешать
                </Button>
              </>
            )}
            <Button variant="gray" onClick={() => push({ name: 'spotify', page: 'browse' })}>
              Все категории
            </Button>
          </>
        }
      />

      {q.isLoading && (
        <>
          <CardsSkeleton count={8} />
          <TrackListSkeleton rows={8} />
        </>
      )}

      {q.isError && <SpotifyErrorView title="Подборки жанра не загрузились" error={q.error} onRetry={() => void q.refetch()} />}

      {!q.isLoading && !q.isError && (
        <>
          {subcategories.length > 0 && (
            <Section title="Подкатегории">
              <div className={sp.browseGrid}>
                {subcategories.map((card, i) => (
                  <SpBrowseTile key={`${card.uri || card.title}-${i}`} card={card} />
                ))}
              </div>
            </Section>
          )}

          {sections.length > 0 ? (
            sections.map((sec) => {
              if (sec.playlists.length > 0) {
                return (
                  <Section key={sec.id} title={sec.title}>
                    <Carousel>
                      {sec.playlists.slice(0, 14).map((pl) => (
                        <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
                      ))}
                    </Carousel>
                  </Section>
                )
              }
              if (sec.artists.length > 0) {
                return (
                  <Section key={sec.id} title={sec.title}>
                    <Carousel>
                      {sec.artists.slice(0, 12).map((ar) => (
                        <SpArtistTile key={ar.id} artist={ar} />
                      ))}
                    </Carousel>
                  </Section>
                )
              }
              if (sec.tracks.length > 0) {
                return (
                  <Section
                    key={sec.id}
                    title={sec.title}
                    action={{ label: 'Слушать', onClick: () => playSpotifyTracks(sec.tracks, 0, false, sec.title) }}
                  >
                    <TrackList tracks={sec.tracks.slice(0, 15)} />
                  </Section>
                )
              }
              return null
            })
          ) : (
            <>
              {playlists.length > 0 && (
                <Section title="Плейлисты и подборки жанра">
                  <div className={sp.grid}>
                    {playlists.slice(0, 18).map((pl) => (
                      <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
                    ))}
                  </div>
                </Section>
              )}

              {tracks.length > 0 && (
                <Section
                  title="Популярные треки жанра"
                  action={{ label: 'Слушать всё', onClick: () => playSpotifyTracks(tracks, 0, false, displayTitle) }}
                >
                  <TrackList tracks={tracks.slice(0, 20)} />
                </Section>
              )}

              {albums.length > 0 && (
                <Section title="Альбомы жанра">
                  <Carousel>
                    {albums.slice(0, 12).map((al) => (
                      <PlaylistCard key={al.spotifyId ?? al.id} playlist={al} />
                    ))}
                  </Carousel>
                </Section>
              )}
            </>
          )}

          {!sections.length && !playlists.length && !tracks.length && !albums.length && !subcategories.length && (
            <EmptyState icon={<Compass size={26} />} title="Подборки не найдены" text={`Не удалось загрузить плейлисты для жанра «${displayTitle}».`} />
          )}
        </>
      )}
    </>
  )
}

export function SpotifySearchPage({ q: query, uri }: { q: string; uri?: string }) {
  const trimmed = query.trim()
  const isGenre = /^genre:/i.test(trimmed)
  const genreTitle = isGenre ? trimmed.replace(/^genre:/i, '').trim() : ''

  const q = useQuery({
    queryKey: spKeys.search(trimmed),
    queryFn: () => spotify.search(trimmed),
    enabled: trimmed.length > 0 && !isGenre,
  })
  const ownLikesQ = useQuery({
    queryKey: ['sp-search-likes'],
    queryFn: () => spotify.getLikes(0, 100),
    staleTime: 60_000,
    enabled: trimmed.length >= 2 && !isGenre,
  })
  const browseQ = useQuery({
    queryKey: spKeys.browse(),
    queryFn: spotify.getBrowseCategories,
    enabled: trimmed.length === 0,
  })

  const res = q.data
  const browseItems = browseQ.data ?? []
  const ownMatches = useMemo(() => {
    if (!trimmed || trimmed.length < 2) return []
    return filterTracks(ownLikesQ.data?.items ?? [], trimmed).slice(0, 8)
  }, [ownLikesQ.data?.items, trimmed])

  if (isGenre && genreTitle) {
    return (
      <SpGate>
        <SpotifyCategoryView title={genreTitle} uri={uri} />
      </SpGate>
    )
  }

  return (
    <SpGate>
      <PageHeader
        title={trimmed ? `Поиск: ${trimmed}` : 'Поиск в Spotify'}
        subtitle={trimmed ? 'Медиатека, исполнители, альбомы, плейлисты и треки' : 'Введите запрос или выберите жанр ниже'}
      />

      {!trimmed && (
        <>
          {browseQ.isLoading && <CardsSkeleton count={8} />}
          {browseItems.length > 0 && (
            <Section title="Обзор категорий">
              <div className={sp.browseGrid}>
                {browseItems.map((card, i) => (
                  <SpBrowseTile key={`${card.uri || card.title}-${i}`} card={card} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {trimmed && q.isLoading && (
        <>
          <CardsSkeleton />
          <TrackListSkeleton rows={8} />
        </>
      )}

      {trimmed && q.isError && <SpotifyErrorView title="Поиск не сработал" error={q.error} onRetry={() => void q.refetch()} />}

      {trimmed && !q.isLoading && !q.isError && res && (
        <>
          {ownMatches.length > 0 && (
            <Section
              title="В моей медиатеке"
              action={{ label: 'Слушать', onClick: () => playSpotifyTracks(ownMatches, 0, false, trimmed) }}
            >
              <TrackList tracks={ownMatches} />
            </Section>
          )}
          {res.artists.length > 0 && (
            <Section title="Исполнители">
              <Carousel>
                {res.artists.slice(0, 12).map((a) => (
                  <SpArtistTile key={a.id} artist={a} />
                ))}
              </Carousel>
            </Section>
          )}
          {(res.albums?.length ?? 0) > 0 && (
            <Section title="Альбомы">
              <Carousel>
                {(res.albums ?? []).slice(0, 12).map((al) => (
                  <PlaylistCard key={al.spotifyId ?? al.id} playlist={al} />
                ))}
              </Carousel>
            </Section>
          )}
          {res.playlists.length > 0 && (
            <Section title="Плейлисты">
              <Carousel>
                {res.playlists.slice(0, 12).map((pl) => (
                  <PlaylistCard key={pl.spotifyId ?? pl.id} playlist={pl} />
                ))}
              </Carousel>
            </Section>
          )}
          {res.tracks.length > 0 && (
            <Section
              title="Треки"
              action={{ label: 'Слушать', onClick: () => playSpotifyTracks(res.tracks, 0, false, trimmed) }}
            >
              <TrackList tracks={res.tracks} />
            </Section>
          )}
          {!ownMatches.length && !res.tracks.length && !res.artists.length && !res.playlists.length && !(res.albums?.length ?? 0) && (
            <EmptyState icon={<Search size={26} />} title="Ничего не найдено" text={`По запросу «${trimmed}» в Spotify совпадений нет.`} />
          )}
        </>
      )}
    </SpGate>
  )
}
