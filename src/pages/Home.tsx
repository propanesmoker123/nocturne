import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useScroller } from '../app/scroller'
import { useSession } from '../app/session'
import { Button, Spinner } from '../components/controls'
import { Carousel, CardsSkeleton, EmptyState, MixHero, PlaylistCard, RecommendedCard, Section, TrackListSkeleton } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import { TrackGrid } from '../components/TrackList'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Block } from '../vk/models'

export const catalogKey = () => ['catalog', vk.getMeId()] as const

function greeting(name?: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : h < 23 ? 'Добрый вечер' : 'Доброй ночи'
  const first = name?.split(' ')[0]
  return first ? `${part}, ${first}` : part
}

/** Loads the rest of a paged catalog section once the reader scrolls near its end. */
export function useSectionRest(sectionId: string | undefined, nextFrom: string | undefined) {
  const [nearEnd, setNearEnd] = useState(false)
  const paged = !!sectionId && !!nextFrom
  const q = useInfiniteQuery({
    queryKey: ['section-rest', sectionId, nextFrom],
    queryFn: ({ pageParam }) => vk.getSection(sectionId!, pageParam),
    initialPageParam: nextFrom ?? '',
    getNextPageParam: (last) => last.nextFrom || undefined,
    enabled: paged && nearEnd,
    staleTime: 10 * 60_000,
  })
  const { hasNextPage, isFetching, isError, fetchNextPage } = q
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetching && !isError) void fetchNextPage()
  }, [nearEnd, hasNextPage, isFetching, isError, fetchNextPage])
  return {
    blocks: q.data?.pages.flatMap((p) => p.blocks) ?? [],
    more: paged && !isError && (!q.data || hasNextPage),
    loading: isFetching,
    setNearEnd,
  }
}

/** Invisible marker that reports when the page is scrolled close to it. */
export function NearEnd({ onChange, loading }: { onChange(near: boolean): void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const scroller = useScroller()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => onChange(e.isIntersecting), { root: scroller.current, rootMargin: '0px 0px 900px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [scroller, onChange])
  return (
    <div ref={ref} style={{ display: 'grid', placeItems: 'center', minHeight: 48 }}>
      {loading && <Spinner size={20} />}
    </div>
  )
}

export function BlockView({ block }: { block: Block }) {
  if (block.kind === 'mix') return <MixHero title={block.title} description={block.description} />
  if (block.kind === 'recommended') {
    return (
      <Section title={block.title || 'Слушайте друг друга'}>
        <Carousel card={264}>
          {block.items.map((item) => (
            <RecommendedCard key={`${item.playlist.ownerId}_${item.playlist.id}`} item={item} />
          ))}
        </Carousel>
      </Section>
    )
  }
  if (block.kind === 'tracks') {
    return (
      <Section title={block.title || 'Треки'}>
        <TrackGrid tracks={block.tracks} />
      </Section>
    )
  }
  return (
    <Section title={block.title || 'Плейлисты'}>
      <Carousel card={block.layout === 'large_slider' ? 216 : 176}>
        {block.playlists.map((p) => (
          <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
        ))}
      </Carousel>
    </Section>
  )
}

export function Home() {
  const user = useSession((x) => x.user)
  const history = usePlayer((p) => p.history)
  const q = useQuery({ queryKey: catalogKey(), queryFn: vk.getCatalog, staleTime: 10 * 60_000 })
  const home = q.data?.[0]
  const rest = useSectionRest(home?.id, home?.nextFrom)

  return (
    <>
      <PageHeader title="Для вас" subtitle={<span>{greeting(user?.name)}</span>} />
      {q.isLoading && (
        <>
          <CardsSkeleton />
          <div style={{ height: 30 }} />
          <TrackListSkeleton rows={6} />
        </>
      )}
      {q.isError && (
        <EmptyState
          icon={<Sparkles size={26} />}
          title="Рекомендации не загрузились"
          text={describeError(q.error)}
          action={
            <Button variant="tinted" onClick={() => void q.refetch()}>
              <RefreshCw size={15} /> Повторить
            </Button>
          }
        />
      )}
      {home?.blocks.filter((b) => b.kind === 'mix').map((b) => <BlockView key={b.id} block={b} />)}
      {history.length > 0 && (
        <Section title="Недавно играло">
          <TrackGrid tracks={history.slice(0, 18)} />
        </Section>
      )}
      {home?.blocks.filter((b) => b.kind !== 'mix').map((b) => <BlockView key={b.id} block={b} />)}
      {rest.blocks.map((b) => <BlockView key={b.id} block={b} />)}
      {rest.more && <NearEnd onChange={rest.setNearEnd} loading={rest.loading} />}
    </>
  )
}

