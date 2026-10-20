import { useInfiniteQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useMemo } from 'react'
import { useRouter } from '../../app/router'
import { Artwork } from '../../components/Artwork'
import { Button } from '../../components/controls'
import { EmptyState } from '../../components/cards'
import { PageHeader } from '../../components/PageHeader'
import { formatPlaysShort, pluralRu } from '../../lib/format'
import * as sc from '../../sc/api'
import { describeScError } from '../../sc/errors'
import { scKeys } from '../../sc/queries'
import { useScSession } from '../../sc/session'
import { ScGate } from './ScGate'
import c from './sc.module.css'

const followers = (n: number) => (n >= 1000 ? `${formatPlaysShort(n)} подписчиков` : `${n} ${pluralRu(n, 'подписчик', 'подписчика', 'подписчиков')}`)

/** «Подписки»: the people the signed-in person follows on SoundCloud. */
export function ScFollowing() {
  return (
    <ScGate>
      <FollowingBody />
    </ScGate>
  )
}

function FollowingBody() {
  const me = useScSession((x) => x.user?.id ?? 0)
  const push = useRouter((r) => r.push)
  const q = useInfiniteQuery({
    queryKey: scKeys.followingUsers(me),
    enabled: me > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => sc.getFollowingUsers(me, pageParam),
    getNextPageParam: (last) => last.next,
  })
  const people = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  return (
    <>
      <PageHeader title="Подписки" subtitle={people.length ? `${people.length}${q.hasNextPage ? '+' : ''} ${pluralRu(people.length, 'артист', 'артиста', 'артистов')}` : undefined} />
      {q.isError && <EmptyState title="Подписки не загрузились" text={describeScError(q.error)} action={<Button onClick={() => void q.refetch()}>Повторить</Button>} />}
      {q.data && !people.length && <EmptyState icon={<Users size={26} />} title="Вы пока ни на кого не подписаны" text="Подписки, сделанные на SoundCloud, появятся здесь." />}
      {people.length > 0 && (
        <div className={c.peopleGrid}>
          {people.map((u) => (
            <button key={u.id} type="button" className={c.person} onClick={() => push({ name: 'sc-user', id: u.id, title: u.name })}>
              <Artwork src={u.avatar ?? undefined} size={120} radius={60} seed={u.name} />
              <span className={`${c.personName} truncate`}>{u.name}</span>
              {u.followers !== undefined && <span className={c.personSub}>{followers(u.followers)}</span>}
            </button>
          ))}
        </div>
      )}
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
