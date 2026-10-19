import { useInfiniteQuery, useQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query'
import { Copy, ExternalLink, MessageCircle, Settings2, Shuffle, UserCheck, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useChrome } from '../../app/chrome'
import { showMenu } from '../../app/menu'
import { toast } from '../../app/toast'
import { Artwork } from '../../components/Artwork'
import { Button, IconButton, Segmented } from '../../components/controls'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../../components/cards'
import { IconMore, IconPlay } from '../../components/Icons'
import { TrackList } from '../../components/TrackList'
import { usePlayer } from '../../player/store'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { toggleFollow, useFollowing } from '../../sc/follow'
import { openInSoundCloud } from '../../sc/open'
import { canFollow, countsLine, openTab, TAB_LABEL, visibleTabs, type ProfileTab, type TabState } from '../../sc/profile'
import { scKeys } from '../../sc/queries'
import { useScSession } from '../../sc/session'
import type { Playlist, Track } from '../../vk/models'
import s from '../pages.module.css'
import { ScGate } from './ScGate'
import c from './sc.module.css'

const ic = { size: 15, strokeWidth: 2.2 } as const

/** A SoundCloud profile as on the site: counts, follow, and its tabs (only the ones with something). */
export function ScUser(props: { id: number; title?: string }) {
  return (
    <ScGate>
      <UserBody key={props.id} {...props} />
    </ScGate>
  )
}

type MixedQuery = UseInfiniteQueryResult<InfiniteData<sc.ScMixedPage>>

function useMixed(key: readonly unknown[], fetch: (cursor?: string) => Promise<sc.ScMixedPage>) {
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetch(pageParam),
    getNextPageParam: (last) => last.next,
  })
  const { tracks, playlists } = useMemo(() => {
    const seen = new Set<string>()
    const pls: Playlist[] = []
    for (const p of q.data?.pages.flatMap((x) => x.playlists) ?? []) {
      const k = `${p.id}_${p.urn ?? ''}`
      if (!seen.has(k)) pls.push(p)
      seen.add(k)
    }
    return { tracks: q.data?.pages.flatMap((x) => x.tracks) ?? [], playlists: pls }
  }, [q.data])
  return { q: q as MixedQuery, tracks, playlists }
}

const stateOf = (q: { isLoading: boolean; isError: boolean }, n: number): TabState => (q.isLoading ? 'loading' : n ? 'some' : q.isError ? 'error' : 'empty')

function More({ q }: { q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage(): unknown } }) {
  if (!q.hasNextPage) return null
  return (
    <div className={c.more}>
      <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
        Ещё
      </Button>
    </div>
  )
}

function UserBody({ id, title }: { id: number; title?: string }) {
  const me = useScSession((x) => x.user?.id ?? 0)
  const user = useQuery({ queryKey: scKeys.user(id), queryFn: () => sc.getUser(id) })
  const top = useQuery({ queryKey: scKeys.userTop(id), queryFn: () => sc.getUserTopTracks(id) })
  const all = useInfiniteQuery({
    queryKey: scKeys.userTracks(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => sc.getUserTracks(id, pageParam),
    getNextPageParam: (last) => last.next,
  })
  const reposts = useMixed(scKeys.userReposts(id), (cursor) => sc.getUserReposts(id, cursor))
  const likes = useMixed(scKeys.userLikes(id), (cursor) => sc.getUserLikes(id, cursor))
  const lists = useQuery({ queryKey: scKeys.userPlaylists(id), queryFn: () => sc.getUserPlaylists(id) })
  const tracks = useMemo(() => all.data?.pages.flatMap((p) => p.items) ?? [], [all.data])
  const following = useFollowing(id)
  const name = user.data?.name || title || ''
  const permalink = user.data?.permalink
  const setTitle = useChrome((x) => x.setTitle)
  useEffect(() => setTitle(name), [name, setTitle])

  const states: Record<ProfileTab, TabState> = {
    popular: stateOf(top, top.data?.length ?? 0),
    tracks: stateOf(all, tracks.length),
    reposts: stateOf(reposts.q, reposts.tracks.length + reposts.playlists.length),
    likes: stateOf(likes.q, likes.tracks.length + likes.playlists.length),
    playlists: stateOf(lists, lists.data?.length ?? 0),
  }
  const visible = visibleTabs(states)
  // the person's own choice stays; until then the first tab with something
  const [picked, setPicked] = useState<ProfileTab | null>(null)
  const tab = picked && visible.includes(picked) ? picked : openTab(states)
  const settled = !Object.values(states).includes('loading')

  const tabTracks: Track[] = tab === 'popular' ? (top.data ?? []) : tab === 'tracks' ? tracks : tab === 'reposts' ? reposts.tracks : tab === 'likes' ? likes.tracks : []
  const playable = tabTracks.some((t) => t.playable)
  const source = { kind: 'list' as const, label: tab ? `${name} · ${TAB_LABEL[tab]}` : name }
  const own = me > 0 && id === me

  if (user.isError && top.isError) return <EmptyState title="Профиль недоступен" text={describeScError(user.error)} action={<Button onClick={() => void user.refetch()}>Повторить</Button>} />

  const menu = () => [
    { label: 'Открыть в SoundCloud', icon: <ExternalLink size={16} strokeWidth={1.9} />, disabled: !permalink, onSelect: () => void openInSoundCloud(permalink) },
    {
      label: 'Скопировать ссылку',
      icon: <Copy size={16} strokeWidth={1.9} />,
      disabled: !permalink,
      onSelect: () =>
        void navigator.clipboard.writeText(permalink!).then(
          () => toast('Ссылка скопирована', 'info'),
          () => toast('Не получилось скопировать', 'error'),
        ),
    },
  ]

  return (
    <>
      <div className={s.hero}>
        <Artwork className={c.avatar} src={user.data?.avatar ?? undefined} size={180} radius={90} seed={name || String(id)} />
        <div style={{ minWidth: 0 }}>
          <div className={s.heroKind}>Артист SoundCloud</div>
          <h1 className={s.heroTitle}>{name || '…'}</h1>
          {user.data && <div className={s.heroMeta}>{countsLine(user.data)}</div>}
          <div className={s.heroActions}>
            <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tabTracks, 0, { shuffle: false, source })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tabTracks, 0, { shuffle: true, source })}>
              <Shuffle {...ic} /> Перемешать
            </Button>
            {canFollow(id, me) && (
              <Button variant={following ? 'gray' : 'tinted'} onClick={() => void toggleFollow({ id, permalink })}>
                {following ? <UserCheck {...ic} /> : <UserPlus {...ic} />} {following ? 'Вы подписаны' : 'Подписаться'}
              </Button>
            )}
            {canFollow(id, me) && permalink && (
              <Button
                onClick={() => {
                  // the site has no address of its own for a new message: its «Message» is on the profile
                  void openInSoundCloud(permalink)
                  toast('В SoundCloud нажмите «Message» на странице профиля', 'info')
                }}
              >
                <MessageCircle {...ic} /> Написать
              </Button>
            )}
            {own && (
              <Button onClick={() => void openInSoundCloud('https://soundcloud.com/settings')}>
                <Settings2 {...ic} /> Изменить профиль
              </Button>
            )}
            <IconButton label="Ещё" onClick={(e) => showMenu(e, menu())}>
              <IconMore size={20} />
            </IconButton>
          </div>
        </div>
      </div>

      {visible.length > 0 && (
        <div className={c.tabs}>
          <Segmented id={`sc-user-${id}`} value={tab ?? visible[0]} options={visible.map((t) => ({ value: t, label: TAB_LABEL[t] }))} onChange={setPicked} />
        </div>
      )}

      {!tab && !settled && <TrackListSkeleton rows={6} />}
      {!tab && settled && <EmptyState title="Здесь пока пусто" text="У этого профиля нет ни треков, ни репостов, ни лайков." />}
      {tab === 'popular' && (
        <TabBody state={states.popular} error={top.error} retry={() => void top.refetch()}>
          <TrackList tracks={top.data ?? []} showAlbum={false} />
        </TabBody>
      )}
      {tab === 'tracks' && (
        <TabBody state={states.tracks} error={all.error} retry={() => void all.refetch()}>
          <TrackList tracks={tracks} showAlbum={false} />
          <More q={all} />
        </TabBody>
      )}
      {(tab === 'reposts' || tab === 'likes') && (
        <MixedTab data={tab === 'reposts' ? reposts : likes} state={states[tab]} />
      )}
      {tab === 'playlists' && (
        <TabBody state={states.playlists} error={lists.error} retry={() => void lists.refetch()}>
          <div className={c.cards}>
            {lists.data?.map((p) => (
              <PlaylistCard key={`${p.id}_${p.urn ?? ''}`} playlist={p} />
            ))}
          </div>
        </TabBody>
      )}
    </>
  )
}

function TabBody({ state, error, retry, children }: { state: TabState; error: unknown; retry(): void; children: React.ReactNode }) {
  if (state === 'error') return <EmptyState title="Не загрузилось" text={describeScError(error)} action={<Button onClick={retry}>Повторить</Button>} />
  return <>{children}</>
}

function MixedTab({ data, state }: { data: ReturnType<typeof useMixed>; state: TabState }) {
  return (
    <TabBody state={state} error={data.q.error} retry={() => void data.q.refetch()}>
      {data.tracks.length > 0 && <TrackList tracks={data.tracks} showAlbum={false} />}
      <More q={data.q} />
      {data.playlists.length > 0 && (
        <Section title="Плейлисты">
          <Carousel>
            {data.playlists.map((p) => (
              <PlaylistCard key={`${p.id}_${p.urn ?? ''}`} playlist={p} />
            ))}
          </Carousel>
        </Section>
      )}
    </TabBody>
  )
}
