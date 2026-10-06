import { normalizeSearch } from '../lib/format'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Track } from '../vk/models'
import { patchTrackInCache, queryClient } from './queryClient'
import { toast } from './toast'

export const myTracksKey = () => ['tracks', vk.getMeId()] as const

export function isInLibrary(t: Track): boolean {
  return t.liked || t.ownerId === vk.getMeId()
}

function markLiked(key: string, liked: boolean) {
  usePlayer.getState().updateTrack(key, { liked })
  patchTrackInCache(key, { liked })
}

const sameSong = (a: Track, b: Track) =>
  (!!a.releaseId && a.releaseId === b.releaseId) ||
  (normalizeSearch(a.title) === normalizeSearch(b.title) && normalizeSearch(a.artist) === normalizeSearch(b.artist) && Math.abs(a.duration - b.duration) <= 2)

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

/** Adds the track to "Моя музыка" or removes it (with an undo action). */
export async function toggleLibrary(t: Track | null | undefined): Promise<void> {
  if (!t) return
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
