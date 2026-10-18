import { sameSong } from '../lib/search'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
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

/** What the heart button says: VK's «Моя музыка» or SoundCloud's likes. */
export function likeLabel(t: Track, liked: boolean): string {
  if (serviceOf(t) === 'sc') return liked ? 'Убрать из лайков' : 'Нравится'
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

/** A SoundCloud like, or taking it back (with an undo action). */
async function toggleScLike(t: Track): Promise<void> {
  const likes = () => void queryClient.invalidateQueries({ queryKey: ['sc-likes'] })
  try {
    if (!t.liked) {
      await sc.like(t)
      markLiked(t.key, true)
      toast('Добавлено в лайки SoundCloud', 'added')
      likes()
      return
    }
    await sc.unlike(t)
    markLiked(t.key, false)
    likes()
    toast('Убрано из лайков SoundCloud', 'removed', {
      label: 'Вернуть',
      run: () =>
        void sc
          .like(t)
          .then(() => {
            markLiked(t.key, true)
            likes()
          })
          .catch((e) => toast(describeScError(e), 'error')),
    })
  } catch (e) {
    toast(describeScError(e), 'error')
  }
}

/** Adds the track to "Моя музыка" or removes it (with an undo action); for SoundCloud, its like. */
export async function toggleLibrary(t: Track | null | undefined): Promise<void> {
  if (!t) return
  if (serviceOf(t) === 'sc') return toggleScLike(t)
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
