import { sameSong } from '../lib/search'
import { usePlayer } from '../player/store'
import { openInSoundCloud } from '../sc/open'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import { serviceOf, type Track } from '../vk/models'
import { patchTrackInCache, queryClient } from './queryClient'
import { toast } from './toast'

export const myTracksKey = () => ['tracks', vk.getMeId()] as const

export function isInLibrary(t: Track): boolean {
  if (serviceOf(t) === 'sc') return t.liked
  return t.liked || t.ownerId === vk.getMeId()
}

/** What the heart button says: VK's «Моя музыка», or SoundCloud's likes (put on its site). */
export function likeLabel(t: Track, liked: boolean): string {
  if (serviceOf(t) === 'sc') return liked ? 'В ваших лайках SoundCloud' : 'Лайкнуть на сайте SoundCloud'
  return liked ? 'Удалить из Моей музыки' : 'Добавить в Мою музыку'
}

function markLiked(key: string, liked: boolean) {
  usePlayer.getState().updateTrack(key, { liked })
  patchTrackInCache(key, { liked })
}

/** Finds the copy of `t` that lives in "Моя музыка" (owner = me). */
async function findLibraryCopy(t: Track): Promise<Track | null> {
  const me = vk.getMeId()
  if (t.ownerId === me) return t
  for (const [, data] of queryClient.getQueriesData<{ pages?: { items: Track[] }[] }>({ queryKey: ['tracks', me] })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((x) => sameSong(x, t))
      if (hit) return hit
    }
  }
  const first = await vk.getTracks(me, 0, 1000)
  return first.items.find((x) => sameSong(x, t)) ?? null
}

/**
 * SoundCloud guards likes with bot protection (DataDome): a like from anything but its own site gets
 * a captcha. Nocturne does not work around that: the like is put on the track's page there.
 */
function likeOnSoundCloud(t: Track) {
  toast('Лайк в SoundCloud ставится только на его сайте', 'info', { label: 'Открыть', run: () => void openInSoundCloud(t.permalink) })
}

/** Adds the track to "Моя музыка" or removes it (with an undo action); for SoundCloud, its like. */
export async function toggleLibrary(t: Track | null | undefined): Promise<void> {
  if (!t) return
  if (serviceOf(t) === 'sc') return likeOnSoundCloud(t)
  try {
    if (!isInLibrary(t)) {
      await vk.addTrack(t)
      markLiked(t.key, true)
      toast('Добавлено в Мою музыку', 'added')
      void queryClient.invalidateQueries({ queryKey: myTracksKey() })
      return
    }
    const copy = await findLibraryCopy(t)
    if (!copy) {
      toast('Не нашёл этот трек в Моей музыке', 'error')
      return
    }
    await vk.deleteTrack(copy)
    markLiked(t.key, false)
    if (copy.key !== t.key) markLiked(copy.key, false)
    toast('Удалено из Моей музыки', 'removed', {
      label: 'Вернуть',
      run: () =>
        void vk
          .restoreTrack(copy)
          .then(() => {
            markLiked(t.key, true)
            if (copy.key !== t.key) markLiked(copy.key, true)
            void queryClient.invalidateQueries({ queryKey: myTracksKey() })
          })
          .catch((e) => toast(describeError(e), 'error')),
    })
    void queryClient.invalidateQueries({ queryKey: myTracksKey() })
  } catch (e) {
    toast(describeError(e), 'error')
  }
}
