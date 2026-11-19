import { sameSong } from '../lib/search'
import type { InfiniteData } from '@tanstack/react-query'
import { usePlayer } from '../player/store'
import * as sc from '../sc/api'
import { describeScError } from '../sc/errors'
import { scKeys } from '../sc/queries'
import * as spotify from '../spotify/api'
import { spKeys } from '../spotify/queries'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import { serviceOf, type Track } from '../vk/models'
import { patchTrackInCache, queryClient } from './queryClient'
import { toast } from './toast'

export const myTracksKey = () => ['tracks', vk.getMeId()] as const

const deletedOwnKeys = new Set<string>()
export function clearDeletedOwnKeys() {
  deletedOwnKeys.clear()
}

export function isInLibrary(t: Track): boolean {
  if (serviceOf(t) === 'sc' || serviceOf(t) === 'spotify') return t.liked
  if (deletedOwnKeys.has(t.key)) return false
  return t.liked || t.ownerId === vk.getMeId()
}

/** What the heart button says: VK's «Моя музыка», or SoundCloud/Spotify likes. */
export function likeLabel(t: Track, liked: boolean): string {
  if (serviceOf(t) === 'sc' || serviceOf(t) === 'spotify') return liked ? 'Убрать из лайков' : 'Нравится'
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

const inFlight = new Set<string>()

async function likeOnSoundCloud(t: Track) {
  if (inFlight.has(t.key)) return
  inFlight.add(t.key)
  const account = sc.getScMeId()
  const liked = !t.liked
  const likesKey = scKeys.likes(account)
  const quickKey = ['sc-quick-likes', account]
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: likesKey })
    void queryClient.invalidateQueries({ queryKey: quickKey })
  }
  // the heart turns now: SoundCloud's first like of a run opens its site in the background, which takes a while
  markLiked(t.key, liked)
  try {
    await (liked ? sc.like(t) : sc.unlike(t))
    // An older list request must not put a removed track back after the write succeeds.
    await Promise.all([
      queryClient.cancelQueries({ queryKey: likesKey }),
      queryClient.cancelQueries({ queryKey: quickKey }),
    ])
    if (sc.getScMeId() !== account) return
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
    if (sc.getScMeId() === account) markLiked(t.key, !liked)
    toast(describeScError(e), 'error')
  } finally {
    inFlight.delete(t.key)
  }
}

async function likeOnSpotify(t: Track) {
  if (!t.spotifyId || inFlight.has(t.key)) return
  inFlight.add(t.key)
  const liked = !t.liked
  markLiked(t.key, liked)
  try {
    await spotify.setTrackLiked(t.spotifyId, liked)
    void queryClient.invalidateQueries({ queryKey: spKeys.likes() })
    void queryClient.invalidateQueries({ queryKey: ['sp-quick-likes'] })
    toast(liked ? 'Добавлено в Любимые треки Spotify' : 'Убрано из Любимых треков Spotify', liked ? 'added' : 'removed')
  } catch (e) {
    markLiked(t.key, !liked)
    toast(typeof e === 'string' ? e : 'Не удалось обновить лайк в Spotify', 'error')
  } finally {
    inFlight.delete(t.key)
  }
}

/** Adds the track to "Моя музыка" or removes it (with an undo action); for SoundCloud/Spotify, its like. */
export async function toggleLibrary(t: Track | null | undefined): Promise<void> {
  if (!t) return
  if (serviceOf(t) === 'sc') return likeOnSoundCloud(t)
  if (serviceOf(t) === 'spotify') return likeOnSpotify(t)
  if (inFlight.has(t.key)) return
  inFlight.add(t.key)
  try {
    if (!isInLibrary(t)) {
      await vk.addTrack(t)
      deletedOwnKeys.delete(t.key)
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
    deletedOwnKeys.add(t.key)
    deletedOwnKeys.add(copy.key)
    markLiked(t.key, false)
    if (copy.key !== t.key) markLiked(copy.key, false)
    toast('Удалено из Моей музыки', 'removed', {
      label: 'Вернуть',
      run: () =>
        void vk
          .restoreTrack(copy)
          .then(() => {
            deletedOwnKeys.delete(t.key)
            deletedOwnKeys.delete(copy.key)
            markLiked(t.key, true)
            if (copy.key !== t.key) markLiked(copy.key, true)
            void queryClient.invalidateQueries({ queryKey: myTracksKey() })
          })
          .catch((e) => toast(describeError(e), 'error')),
    })
    void queryClient.invalidateQueries({ queryKey: myTracksKey() })
  } catch (e) {
    toast(describeError(e), 'error')
  } finally {
    inFlight.delete(t.key)
  }
}
