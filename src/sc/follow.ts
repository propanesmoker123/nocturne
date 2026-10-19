import { useQuery } from '@tanstack/react-query'
import { queryClient } from '../app/queryClient'
import { toast } from '../app/toast'
import { FOLLOW_NOT_DONE, follow, getMyFollowings, getScMeId, unfollow, type ScUser } from './api'
import { describeScError, ScApiError } from './errors'
import { openInSoundCloud } from './open'
import { scKeys } from './queries'
import { useScSession } from './session'

/** Whom the signed-in person follows (ids), read once a minute at most. */
export function useFollowings(): number[] {
  const me = useScSession((s) => s.user?.id ?? 0)
  const q = useQuery({ queryKey: scKeys.followings(me), queryFn: getMyFollowings, enabled: me > 0, staleTime: 60_000 })
  return q.data ?? []
}

export const useFollowing = (id: number) => useFollowings().includes(id)

type Person = Pick<ScUser, 'id' | 'permalink'>

/**
 * Follows or stops following: the button turns at once and turns back if it did not happen.
 * Following from Nocturne is not made yet (see `follow` in api.ts): it says so and offers the
 * profile on the site.
 */
export async function toggleFollow(u: Person, deps = { follow, unfollow, open: openInSoundCloud }): Promise<void> {
  const me = getScMeId()
  if (!me) return toast('Войдите в SoundCloud', 'error')
  const key = scKeys.followings(me)
  const ids = () => queryClient.getQueryData<number[]>(key) ?? []
  const was = ids().includes(u.id)
  // only this person changes, now and on the way back: other changes meanwhile stay
  const set = (on: boolean) => queryClient.setQueryData(key, [...ids().filter((x) => x !== u.id), ...(on ? [u.id] : [])])
  set(!was)
  try {
    if (was) await deps.unfollow(u.id)
    else await deps.follow(u)
    toast(was ? 'Вы отписались' : 'Вы подписались', was ? 'removed' : 'added')
  } catch (e) {
    set(was)
    const err = ScApiError.from(e)
    if (err.kind === 'invalid' && err.message === FOLLOW_NOT_DONE) {
      return toast('Подписка из Nocturne пока не сделана', 'info', { label: 'Открыть в SoundCloud', run: () => void deps.open(u.permalink) })
    }
    if (err.kind === 'challenge') return toast('Пройдите проверку SoundCloud в открывшемся окне и нажмите «Подписаться» ещё раз', 'error')
    toast(describeScError(err), 'error')
  }
}
