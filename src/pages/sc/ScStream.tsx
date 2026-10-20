import { useInfiniteQuery } from '@tanstack/react-query'
import { Rss } from 'lucide-react'
import { useMemo, useState } from 'react'
import { queryClient } from '../../app/queryClient'
import { artistRoute, useRouter } from '../../app/router'
import { openTrackMenu } from '../../app/trackActions'
import { Artwork } from '../../components/Artwork'
import { Button, EqualizerBars, IconButton, Segmented } from '../../components/controls'
import { EmptyState, TrackListSkeleton } from '../../components/cards'
import { IconMore } from '../../components/Icons'
import { PageHeader } from '../../components/PageHeader'
import { AlbumAddButton, HeartButton } from '../../components/TrackButtons'
import { formatTime } from '../../lib/format'
import { usePlayer } from '../../player/store'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { agoRu, feedPage, kindLabel, mapLimit, mergeFeed, type FeedItem, type FeedKind } from '../../sc/feed'
import { scKeys } from '../../sc/queries'
import { unplayableHint, useScSession } from '../../sc/session'
import type { Track } from '../../vk/models'
import { ScGate } from './ScGate'
import c from './sc.module.css'

/** Followed profiles read per «Ещё» (each costs three requests). */
const PEOPLE_PER_PAGE = 12
/** Profiles read at once. */
const AT_ONCE = 4

type Filter = 'all' | FeedKind
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Всё' },
  { value: 'post', label: 'Треки' },
  { value: 'repost', label: 'Репосты' },
  { value: 'like', label: 'Лайки' },
]

/** «Лента»: what the people one follows put up, reposted and liked, newest first. */
export function ScStream() {
  return (
    <ScGate>
      <FeedBody />
    </ScGate>
  )
}

function FeedBody() {
  const me = useScSession((x) => x.user?.id ?? 0)
  const [filter, setFilter] = useState<Filter>('all')
  const q = useInfiniteQuery({
    queryKey: scKeys.feed(me),
    enabled: me > 0,
    staleTime: 2 * 60_000,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const people = await queryClient.fetchQuery({ queryKey: scKeys.feedPeople(me), queryFn: sc.getFeedPeople, staleTime: 5 * 60_000 })
      const page = feedPage(people, pageParam, PEOPLE_PER_PAGE)
      // SoundCloud's own stream once, with the first people; a stream that fails leaves their activity
      const stream = pageParam === 0 ? sc.getStreamFeed().then((r) => r.items, () => []) : Promise.resolve([])
      const [own, activity] = await Promise.all([stream, mapLimit(page.people, AT_ONCE, sc.getUserActivity)])
      return { items: mergeFeed([own, ...activity]), next: page.next, people: people.length }
    },
    getNextPageParam: (last) => last.next,
  })
  // later people may have newer things: the whole feed is ordered again
  const all = useMemo(() => mergeFeed(q.data?.pages.map((p) => p.items) ?? []), [q.data])
  const shown = useMemo(() => (filter === 'all' ? all : all.filter((i) => i.kind === filter)), [all, filter])
  const tracks = useMemo(() => shown.flatMap((i) => (i.track ? [i.track] : [])), [shown])
  const following = q.data?.pages[0]?.people ?? 0

  const play = (t: Track) => {
    if (t.key === usePlayer.getState().current?.key) return usePlayer.getState().toggle()
    usePlayer.getState().playList(tracks, Math.max(0, tracks.findIndex((x) => x.key === t.key)), { source: { kind: 'list', label: 'Лента' } })
  }

  return (
    <>
      <PageHeader title="Лента" subtitle="Новые треки, репосты и лайки тех, на кого вы подписаны" />
      {all.length > 0 && (
        <div className={c.tabs}>
          <Segmented id="sc-feed" value={filter} options={FILTERS} onChange={setFilter} />
        </div>
      )}
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.isError && <EmptyState title="Лента не загрузилась" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && !all.length && (
        <EmptyState
          icon={<Rss size={26} />}
          title={following ? 'Пока ничего нового' : 'Вы пока ни на кого не подписаны'}
          text={following ? 'Здесь появятся новые треки, репосты и лайки тех, на кого вы подписаны.' : 'Подпишитесь на артистов — их треки, репосты и лайки появятся здесь.'}
        />
      )}
      {all.length > 0 && !shown.length && <EmptyState title="Здесь пока пусто" text="Попробуйте другой фильтр." />}
      <div className={c.feed}>
        {shown.map((it) => (
          <FeedRow key={it.id} item={it} onPlay={play} />
        ))}
      </div>
      {q.hasNextPage && (
        <div className={c.more}>
          <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Ещё
          </Button>
        </div>
      )}
    </>
  )
}

function FeedRow({ item, onPlay }: { item: FeedItem; onPlay(t: Track): void }) {
  const push = useRouter((r) => r.push)
  return (
    <article className={c.feedItem}>
      <div className={c.feedWho}>
        <button type="button" className={c.feedPerson} onClick={() => push({ name: 'sc-user', id: item.who.id, title: item.who.name })}>
          <Artwork src={item.who.avatar} size={22} radius={11} seed={item.who.name} />
          <span className="truncate">{item.who.name}</span>
        </button>
        <span className={c.feedWhat}>
          {kindLabel(item)} · {agoRu(item.at)}
        </span>
      </div>
      {item.track && <FeedTrack track={item.track} onPlay={onPlay} />}
      {item.playlist && (
        <button
          type="button"
          className={c.feedThing}
          onClick={() => push({ name: 'sc-playlist', id: item.playlist!.id, urn: item.playlist!.urn, title: item.playlist!.title })}
        >
          <Artwork src={item.playlist.cover} size={52} radius={8} seed={item.playlist.title} />
          <span className={c.feedText}>
            <span className={`${c.feedTitle} truncate`}>{item.playlist.title}</span>
            <span className={`${c.feedSub} truncate`}>
              {[item.playlist.ownerName, item.playlist.type === 'album' ? 'альбом' : 'плейлист', `${item.playlist.count} тр.`].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
      )}
    </article>
  )
}

function FeedTrack({ track, onPlay }: { track: Track; onPlay(t: Track): void }) {
  const push = useRouter((r) => r.push)
  const isCurrent = usePlayer((p) => p.current?.key === track.key)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const scPhase = useScSession((x) => x.phase)
  return (
    <div
      className={c.feedThing}
      role="button"
      tabIndex={0}
      data-current={isCurrent || undefined}
      data-disabled={!track.playable || undefined}
      title={unplayableHint(track, scPhase)}
      onClick={(e) => !(e.target as Element).closest('button') && track.playable && onPlay(track)}
      onKeyDown={(e) => e.key === 'Enter' && track.playable && onPlay(track)}
      onContextMenu={(e) => openTrackMenu(e, track)}
    >
      <span className={c.feedArt}>
        <Artwork src={track.cover?.s} size={52} radius={8} seed={track.key} />
        {isCurrent && (
          <span className={c.feedEq}>
            <EqualizerBars playing={isPlaying} height={14} color="#fff" />
          </span>
        )}
      </span>
      <span className={c.feedText}>
        <span className={`${c.feedTitle} truncate`}>{track.title}</span>
        <button type="button" className={`${c.feedSub} truncate`} onClick={() => push(artistRoute(track))}>
          {track.artist}
        </button>
      </span>
      <span className={c.feedActions}>
        <AlbumAddButton track={track} size={30} iconSize={17} />
        <HeartButton track={track} size={30} iconSize={16} />
        <span className={c.feedTime}>{formatTime(track.duration)}</span>
        <IconButton size={30} label="Ещё" onClick={(e) => openTrackMenu(e, track)}>
          <IconMore size={17} />
        </IconButton>
      </span>
    </div>
  )
}
