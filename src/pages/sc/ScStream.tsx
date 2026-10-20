import { useInfiniteQuery } from '@tanstack/react-query'
import { RotateCw, Rss, Shuffle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { queryClient } from '../../app/queryClient'
import { useRouter } from '../../app/router'
import { Artwork } from '../../components/Artwork'
import { Button, IconButton, Segmented } from '../../components/controls'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../../components/cards'
import { IconPlay } from '../../components/Icons'
import { PageHeader } from '../../components/PageHeader'
import { TrackList } from '../../components/TrackList'
import { usePlayer } from '../../player/store'
import * as sc from '../../sc/api'
import { pluralRu } from '../../lib/format'
import { describeScError } from '../../sc/errors'
import { agoRu, feedPage, kindLabel, mapLimit, mergeFeed, settle, settlePage, uniqueTracks, type FeedItem, type FeedKind } from '../../sc/feed'
import { scKeys } from '../../sc/queries'
import { useScSession } from '../../sc/session'
import { ScGate } from './ScGate'
import c from './sc.module.css'

/** Followed profiles read per «Ещё» (each costs three requests). */
const PEOPLE_PER_PAGE = 12
/** Profiles read at once (each sends its three requests together: about nine in flight). */
const AT_ONCE = 3
/** Coming back to the feed later than this reads it again from the top (the first page only). */
const FRESH_MS = 10 * 60_000

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
  const key = scKeys.feed(me)
  const q = useInfiniteQuery({
    queryKey: key,
    enabled: me > 0,
    // never refetched as a whole (that would read every loaded page again: hundreds of requests);
    // «Обновить», or coming back after FRESH_MS, starts again from the first page
    staleTime: Infinity,
    retry: false,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      // the first page reads whom the person follows afresh; later pages keep that list, so nobody is skipped
      const people =
        pageParam === 0
          ? await queryClient.fetchQuery({ queryKey: scKeys.feedPeople(me), queryFn: sc.getFeedPeople, staleTime: 0 })
          : await queryClient.ensureQueryData({ queryKey: scKeys.feedPeople(me), queryFn: sc.getFeedPeople })
      const page = feedPage(people, pageParam, PEOPLE_PER_PAGE)
      // SoundCloud's own stream once, with the first people
      const [own, activity] = await Promise.all([
        pageParam === 0 ? settle(sc.getStreamFeed().then((r) => r.items)).then((r) => [r]) : Promise.resolve([]),
        mapLimit(page.people, AT_ONCE, (p) => settle(sc.getUserActivity(p))),
      ])
      const { items, failed } = settlePage([...own, ...activity])
      return { items, failed, next: page.next, people: people.length }
    },
    getNextPageParam: (last) => last.next,
  })
  const refresh = () => void queryClient.resetQueries({ queryKey: key, exact: true })
  useEffect(() => {
    const at = queryClient.getQueryState(scKeys.feed(me))?.dataUpdatedAt ?? 0
    if (at && Date.now() - at > FRESH_MS) void queryClient.resetQueries({ queryKey: scKeys.feed(me), exact: true })
  }, [me])
  // later people may have newer things: the whole feed is ordered again
  const all = useMemo(() => mergeFeed(q.data?.pages.map((p) => p.items) ?? []), [q.data])
  const shown = useMemo(() => (filter === 'all' ? all : all.filter((i) => i.kind === filter)), [all, filter])
  // tracks are rows of the list, playlists and albums cards over it
  const rows = useMemo(() => shown.filter((i) => i.track), [shown])
  const tracks = useMemo(() => rows.map((i) => i.track!), [rows])
  // a track several people put up, reposted or liked is a row each, and plays once
  const queue = useMemo(() => uniqueTracks(tracks), [tracks])
  const lists = useMemo(() => shown.filter((i) => i.playlist), [shown])
  const following = q.data?.pages[0]?.people ?? 0
  const failed = q.data?.pages.reduce((n, p) => n + p.failed, 0) ?? 0
  const playable = queue.some((t) => t.playable)
  const play = (shuffle: boolean) => usePlayer.getState().playList(queue, 0, { shuffle, source: { kind: 'list', label: 'Лента' } })

  return (
    <>
      <PageHeader
        title="Лента"
        actions={
          <>
            {q.data && (
              <IconButton label="Обновить" disabled={q.isFetching} onClick={refresh}>
                <RotateCw size={18} strokeWidth={2} />
              </IconButton>
            )}
            {tracks.length > 0 && (
              <>
              <Button variant="primary" disabled={!playable} onClick={() => play(false)}>
                <IconPlay size={15} /> Слушать
              </Button>
              <Button variant="tinted" disabled={!playable} onClick={() => play(true)}>
                <Shuffle size={15} strokeWidth={2.2} /> Перемешать
              </Button>
              </>
            )}
          </>
        }
      />
      {all.length > 0 && (
        <div className={c.tabs}>
          <Segmented id="sc-feed" value={filter} options={FILTERS} onChange={setFilter} />
        </div>
      )}
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {/* only when nothing is shown yet: a failed «Ещё» keeps the feed (and says so by the button) */}
      {q.isError && !q.data && <EmptyState title="Лента не загрузилась" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {failed > 0 && <div className={c.feedNote}>SoundCloud не ответил про {failed} {pluralRu(failed, 'профиль', 'профиля', 'профилей')} — нажмите «Обновить» чуть позже.</div>}
      {q.data && !all.length && (
        <EmptyState
          icon={<Rss size={26} />}
          title={following ? 'Пока ничего нового' : 'Вы пока ни на кого не подписаны'}
          text={following ? 'Здесь появятся новые треки, репосты и лайки тех, на кого вы подписаны.' : 'Подпишитесь на артистов — их треки, репосты и лайки появятся здесь.'}
        />
      )}
      {all.length > 0 && !shown.length && <EmptyState title="Здесь пока пусто" text="Попробуйте другой фильтр." />}
      {lists.length > 0 && (
        <Section title="Плейлисты и альбомы">
          <Carousel>
            {lists.map((it) => (
              <PlaylistCard key={it.id} playlist={it.playlist!} note={<FeedWho item={it} compact />} />
            ))}
          </Carousel>
        </Section>
      )}
      {tracks.length > 0 && <TrackList tracks={tracks} queueSource={queue} note={{ label: 'Кто и когда', render: (_t, i) => rows[i] && <FeedWho item={rows[i]} /> }} />}
      {q.hasNextPage && (
        <div className={c.more}>
          {q.isFetchNextPageError && <span className={c.feedNote}>Не загрузилось: {describeScError(q.error)}</span>}
          <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchNextPageError ? 'Попробовать ещё раз' : 'Ещё'}
          </Button>
        </div>
      )}
    </>
  )
}

/** Who put it up, reposted or liked it, and when: the person opens their profile. */
function FeedWho({ item, compact = false }: { item: FeedItem; compact?: boolean }) {
  const push = useRouter((r) => r.push)
  return (
    <span className={c.who} data-compact={compact || undefined}>
      <button type="button" className={c.whoPerson} onClick={() => push({ name: 'sc-user', id: item.who.id, title: item.who.name })}>
        <Artwork src={item.who.avatar} size={18} radius={9} seed={item.who.name} />
        <span className="truncate">{item.who.name}</span>
      </button>
      <span className={`${c.whoWhat} truncate`}>
        {kindLabel(item)} · {agoRu(item.at)}
      </span>
    </span>
  )
}
