import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Sparkles } from 'lucide-react'
import { useSession } from '../app/session'
import { Button } from '../components/controls'
import { Carousel, CardsSkeleton, EmptyState, MixHero, PlaylistCard, Section, TrackListSkeleton } from '../components/cards'
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

export function BlockView({ block }: { block: Block }) {
  if (block.kind === 'mix') return <MixHero title={block.title} description={block.description} />
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
    </>
  )
}
