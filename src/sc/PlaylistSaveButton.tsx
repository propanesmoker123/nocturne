import { useQuery } from '@tanstack/react-query'
import { Check, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { queryClient } from '../app/queryClient'
import { toast } from '../app/toast'
import { Button, Spinner } from '../components/controls'
import type { Playlist } from '../vk/models'
import * as sc from './api'
import { describeScError, ScApiError } from './errors'
import { scKeys } from './queries'
import { useScSession } from './session'

/** Saves to the signed-in SoundCloud account, the same library shown by its website. */
export function PlaylistSaveButton({ playlist }: { playlist: Playlist }) {
  const me = useScSession((s) => s.user?.id ?? 0)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const key = scKeys.playlistLikes(me)
  const saved = useQuery({ queryKey: key, queryFn: sc.getPlaylistLikes, enabled: me > 0, staleTime: 60_000 })
  const liked = saved.data ? sc.isPlaylistLiked(playlist, saved.data) : false
  if (!me || playlist.ownerId === me) return null

  const toggle = async () => {
    if (pending.current) return
    if (saved.isError) {
      const result = await saved.refetch()
      if (result.error) toast(describeScError(result.error), 'error')
      return
    }
    if (!saved.data) return
    pending.current = true
    setBusy(true)
    try {
      await queryClient.cancelQueries({ queryKey: key })
      await sc.setPlaylistLiked(playlist, !liked)
      if (sc.getScMeId() !== me) return
      await queryClient.cancelQueries({ queryKey: key })
      if (sc.getScMeId() !== me) return
      queryClient.setQueryData<sc.ScPlaylistLikes>(key, (old) => {
        const next = old ?? saved.data!
        if (playlist.urn) return { ...next, urns: liked ? next.urns.filter((u) => u !== playlist.urn) : [...new Set([...next.urns, playlist.urn])] }
        return { ...next, ids: liked ? next.ids.filter((id) => id !== playlist.id) : [...new Set([...next.ids, playlist.id])] }
      })
      void queryClient.invalidateQueries({ queryKey: scKeys.myPlaylists(me) })
      toast(liked ? 'Убрано из библиотеки SoundCloud' : 'Добавлено в библиотеку SoundCloud', liked ? 'removed' : 'added')
    } catch (e) {
      const error = ScApiError.from(e)
      toast(error.kind === 'challenge' ? 'Пройдите проверку SoundCloud в открывшемся окне и нажмите кнопку ещё раз' : describeScError(error), 'error')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Button
      variant={liked ? 'gray' : 'tinted'}
      disabled={busy || saved.isPending}
      aria-pressed={liked}
      title={saved.isError ? 'Не удалось проверить библиотеку SoundCloud' : liked ? 'Убрать из библиотеки SoundCloud' : 'Добавить в библиотеку SoundCloud'}
      onClick={() => void toggle()}
    >
      {busy || saved.isPending ? <Spinner size={16} /> : liked ? <Check size={16} /> : <Plus size={16} />}
      {saved.isError ? 'Повторить проверку' : liked ? 'В библиотеке' : 'Добавить к себе'}
    </Button>
  )
}
