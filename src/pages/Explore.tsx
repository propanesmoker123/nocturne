import { useQuery } from '@tanstack/react-query'
import { Compass, RefreshCw } from 'lucide-react'
import { Button } from '../components/controls'
import { CardsSkeleton, EmptyState, TrackListSkeleton } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import { BlockView, NearEnd, catalogKey, useSectionRest } from './Home'

export function Explore() {
  const catalog = useQuery({ queryKey: catalogKey(), queryFn: vk.getCatalog, staleTime: 10 * 60_000 })
  const sectionId = catalog.data?.find((s) => /section=explore/.test(s.url ?? '') || s.title === 'Обзор')?.id
  const q = useQuery({
    queryKey: ['section', sectionId],
    queryFn: () => vk.getSection(sectionId!),
    enabled: !!sectionId,
    staleTime: 10 * 60_000,
  })
  const rest = useSectionRest(sectionId, q.data?.nextFrom)
  const loading = catalog.isLoading || q.isLoading
  const error = catalog.error ?? q.error

  return (
    <>
      <PageHeader title="Обзор" subtitle="Новинки, чарты и подборки VK Музыки" />
      {loading && (
        <>
          <CardsSkeleton />
          <div style={{ height: 30 }} />
          <TrackListSkeleton rows={6} />
        </>
      )}
      {!loading && (error || (catalog.data && !sectionId)) && (
        <EmptyState
          icon={<Compass size={26} />}
          title="Обзор недоступен"
          text={error ? describeError(error) : 'VK не прислал раздел «Обзор» для вашего аккаунта.'}
          action={
            <Button
              variant="tinted"
              onClick={() => {
                void catalog.refetch()
                void q.refetch()
              }}
            >
              <RefreshCw size={15} /> Повторить
            </Button>
          }
        />
      )}
      {q.data?.blocks.map((b) => <BlockView key={b.id} block={b} />)}
      {rest.blocks.map((b) => <BlockView key={b.id} block={b} />)}
      {rest.more && <NearEnd onChange={rest.setNearEnd} loading={rest.loading} />}
    </>
  )
}
