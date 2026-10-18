import { sameSong } from '../lib/search'
import type { InfiniteData } from '@tanstack/react-query'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
import { scKeys } from '../sc/queries'
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

/** What the heart button says: VK's «Моя музыка», or SoundCloud's likes. */
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

const scPending = new Set<string>()

async function likeOnSoundCloud(t: Track) {
  if (scPending.has(t.key)) return
  scPending.add(t.key)
  const account = sc.getScMeId()
  const liked = !t.liked
  const likesKey = scKeys.likes(account)
  const quickKey = ['sc-quick-likes', account]
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: likesKey })
    void queryClient.invalidateQueries({ queryKey: quickKey })
  }
  try {
    await (liked ? sc.like(t) : sc.unlike(t))
    // An older list request must not put a removed track back after the write succeeds.
    await Promise.all([
      queryClient.cancelQueries({ queryKey: likesKey }),
      queryClient.cancelQueries({ queryKey: quickKey }),
    ])
    if (sc.getScMeId() !== account) return
    markLiked(t.key, liked)
    queryClient.setQueryData<InfiniteData<sc.ScPage<Track>>>(likesKey, (old) => {
      if (!old?.pages.length) return old
      const pages = old.pages.map((page) => ({ ...page, items: page.items.filter((x) => x.key !== t.key) }))
      if (liked) pages[0].items.unshift({ ...t, liked: true })
      return { ...old, pages }
    })
    if (liked) {
      toast('Добавлено в лайки SoundCloud', 'added')
    } else {
      toast('Убрано из лайков SoundCloud', 'removed', {
        label: 'Вернуть',
        run: () => void likeOnSoundCloud({ ...t, liked: false }),
      })
    }
    refresh()
  } catch (e) {
    toast(describeScError(e), 'error')
  } finally {
    scPending.delete(t.key)
  }
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
