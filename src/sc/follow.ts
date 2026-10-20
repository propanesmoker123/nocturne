import { useQuery } from '@tanstack/react-query'
import { queryClient } from '../app/queryClient'
import { toast } from '../app/toast'
import { follow, getMyFollowings, getScMeId, unfollow, type ScUser } from './api'
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

/** Follows or stops following: the button turns at once and turns back if it did not happen. */
export async function toggleFollow(u: Person, deps = { follow, unfollow, open: openInSoundCloud }): Promise<void> {
  const me = getScMeId()
  if (!me) return toast('Войдите в SoundCloud', 'error')
  const key = scKeys.followings(me)
  const ids = () => queryClient.getQueryData<number[]>(key) ?? []
  const was = ids().includes(u.id)
  // only this person changes, now and on the way back: other changes meanwhile stay
  const set = (on: boolean) => queryClient.setQueryData(key, [...ids().filter((x) => x !== u.id), ...(on ? [u.id] : [])])
  // An optional link to the profile after leaving someone.
  const site = u.permalink ? { label: 'Открыть в SoundCloud', run: () => void deps.open(u.permalink) } : undefined
  set(!was)
  // said at once with the button: the site's session takes a moment; a failure turns both back below
  if (was) toast('Вы отписались', 'removed', site)
  else toast('Вы подписались', 'added')
  try {
    await (was ? deps.unfollow(u.id) : deps.follow(u))
    void queryClient.invalidateQueries({ queryKey: scKeys.followingUsers(me) })
    queryClient.removeQueries({ queryKey: scKeys.feed(me) })
  } catch (e) {
    set(was)
    const err = ScApiError.from(e)
    // the button on screen is the one the person pressed, as it was before
    if (err.kind === 'challenge') return toast(`Пройдите проверку SoundCloud в открывшемся окне и нажмите «${was ? 'Вы подписаны' : 'Подписаться'}» ещё раз`, 'error')
    toast(describeScError(err), 'error')
  }
}
