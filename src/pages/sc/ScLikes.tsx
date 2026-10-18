import { Heart } from 'lucide-react'
import { Button } from '../../components/controls'
import { EmptyState, TrackListSkeleton } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import { TrackList } from '../../components/TrackList'
import { pluralRu } from '../../lib/format'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys, useAllCursorPages } from '../../sc/queries'
import { useScSession } from '../../sc/session'
import { ScGate } from './ScGate'

export function ScLikes() {
  return (
    <ScGate>
      <LikesBody />
    </ScGate>
  )
}

function LikesBody() {
  const me = useScSession((x) => x.user?.id ?? sc.getScMeId())
  const q = useAllCursorPages(scKeys.likes(me), (cursor) => sc.getLikes(me, cursor), { max: 2000 })
  const n = q.items.length
  return (
    <>
      <PageHeader title="Лайки" subtitle={n ? `${n} ${pluralRu(n, 'трек', 'трека', 'треков')}${q.hasNextPage ? '…' : ''}` : undefined} />
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.isError && !n && <EmptyState title="Лайки не загрузились" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && !n && !q.isError && <EmptyState icon={<Heart size={26} />} title="Лайков пока нет" text="Ставьте ♥ трекам SoundCloud — они появятся здесь." />}
      {n > 0 && <TrackList tracks={q.items} showAlbum={false} />}
    </>
  )
}
