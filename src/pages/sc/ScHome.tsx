import { useQuery } from '@tanstack/react-query'
import { Button } from '../../components/controls'
import { Carousel, CardsSkeleton, EmptyState, PlaylistCard, Section } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import { ScGate } from './ScGate'

export function ScHome() {
  return (
    <ScGate>
      <HomeBody />
    </ScGate>
  )
}

function HomeBody() {
  const q = useQuery({ queryKey: scKeys.selections(), queryFn: sc.getSelections, staleTime: 5 * 60_000 })
  return (
    <>
      <PageHeader title="Для вас" />
      {q.isLoading && <CardsSkeleton />}
      {q.isError && <EmptyState title="Подборки не загрузились" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && q.data.length === 0 && <EmptyState title="Подборок пока нет" text="Ставьте лайки и подписывайтесь на артистов — SoundCloud подберёт музыку." />}
      {q.data?.map((sel) => (
        <Section key={sel.id} title={sel.title}>
          <Carousel>
            {sel.playlists.map((p) => (
              <PlaylistCard key={`${p.id}_${p.urn ?? ''}`} playlist={p} />
            ))}
          </Carousel>
        </Section>
      ))}
    </>
  )
}
