import { Copy, Disc3, ListEnd, ListPlus, ListX, Mic2, Plus, Trash2 } from 'lucide-react'
import type { MouseEvent } from 'react'
import { IconCheck, IconPlay, IconPlus } from '../components/Icons'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import type { Playlist, Track } from '../vk/models'
import { isInLibrary, toggleLibrary } from './library'
import { showMenu, type MenuItem } from './menu'
import { queryClient } from './queryClient'
import { useRouter } from './router'
import { useSheet } from './sheetStore'
import { toast } from './toast'
import { useUi } from './ui'

const ic = { size: 16, strokeWidth: 1.9 } as const

export const myPlaylistsKey = () => ['playlists', vk.getMeId()] as const

export async function myEditablePlaylists(): Promise<Playlist[]> {
  const data = await queryClient.fetchQuery({ queryKey: myPlaylistsKey(), queryFn: () => vk.getPlaylists(vk.getMeId(), 0, 200), staleTime: 60_000 })
  return data.items.filter((p) => p.canEdit)
}

export async function addTracksToPlaylist(p: Playlist, tracks: Track[]) {
  try {
    await vk.addToPlaylist(p, tracks)
    toast(`Добавлено в «${p.title}»`, 'added')
    void queryClient.invalidateQueries({ queryKey: ['playlist-tracks', p.ownerId, p.id] })
    void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
  } catch (e) {
    toast(describeError(e), 'error')
  }
}

export async function removeTracksFromPlaylist(p: Playlist, tracks: Track[]) {
  try {
    await vk.removeFromPlaylist(p, tracks)
    toast(`Убрано из «${p.title}»`, 'removed')
    void queryClient.invalidateQueries({ queryKey: ['playlist-tracks', p.ownerId, p.id] })
  } catch (e) {
    toast(describeError(e), 'error')
  }
}

interface TrackMenuContext {
  list?: Track[]
  index?: number
  playlist?: Playlist
  inNowPlaying?: boolean
}

export function trackMenuItems(track: Track, ctx: TrackMenuContext = {}): MenuItem[] {
  const player = usePlayer.getState()
  const router = useRouter.getState()
  const liked = isInLibrary(track)
  const items: MenuItem[] = []
  if (!ctx.inNowPlaying) {
    items.push({
      label: 'Играть',
      icon: <IconPlay size={15} />,
      disabled: !track.playable,
      onSelect: () => player.playList(ctx.list ?? [track], ctx.index ?? 0),
    })
  }
  items.push(
    { label: 'Играть следующим', icon: <ListPlus {...ic} />, disabled: !track.playable, onSelect: () => player.playNext([track]) },
    { label: 'В конец очереди', icon: <ListEnd {...ic} />, disabled: !track.playable, onSelect: () => player.addToQueue([track]) },
    { separator: true },
    {
      label: liked ? 'Удалить из Моей музыки' : 'Добавить в Мою музыку',
      icon: liked ? <IconCheck size={16} /> : <IconPlus size={16} />,
      onSelect: () => void toggleLibrary(track),
    },
    {
      label: 'Добавить в плейлист',
      icon: <Plus {...ic} />,
      submenu: async () => {
        const lists = await myEditablePlaylists().catch(() => [] as Playlist[])
        return [
          { label: 'Новый плейлист…', icon: <Plus {...ic} />, onSelect: () => useSheet.getState().open({ kind: 'playlist-create', addTracks: [track] }) },
          ...(lists.length ? [{ separator: true } as MenuItem] : []),
          ...lists.map((p) => ({ label: p.title, onSelect: () => void addTracksToPlaylist(p, [track]) })),
        ]
      },
    },
  )
  if (ctx.playlist?.canEdit) {
    const p = ctx.playlist
    items.push({ label: 'Убрать из плейлиста', icon: <ListX {...ic} />, danger: true, onSelect: () => void removeTracksFromPlaylist(p, [track]) })
  }
  items.push({ separator: true })
  const artist = track.artists[0]
  items.push({
    label: 'Перейти к исполнителю',
    icon: <Mic2 {...ic} />,
    onSelect: () => {
      useUi.getState().closeNowPlaying()
      router.push({ name: 'artist', id: artist?.id, artist: artist?.name ?? track.artist })
    },
  })
  if (track.album) {
    const a = track.album
    items.push({
      label: 'Перейти к альбому',
      icon: <Disc3 {...ic} />,
      onSelect: () => {
        useUi.getState().closeNowPlaying()
        router.push({ name: 'playlist', ownerId: a.ownerId, id: a.id, accessKey: a.accessKey })
      },
    })
  }
  items.push({
    label: 'Скопировать ссылку',
    icon: <Copy {...ic} />,
    onSelect: () => {
      void navigator.clipboard.writeText(`https://vk.com/audio${track.ownerId}_${track.id}`)
      toast('Ссылка скопирована', 'info')
    },
  })
  return items
}

export function openTrackMenu(e: MouseEvent, track: Track, ctx: TrackMenuContext = {}) {
  e.preventDefault()
  e.stopPropagation()
  showMenu(e, trackMenuItems(track, ctx))
}

export function playlistMenuItems(p: Playlist, tracks: Track[] | undefined): MenuItem[] {
  const player = usePlayer.getState()
  const items: MenuItem[] = [
    { label: 'Играть', icon: <IconPlay size={15} />, disabled: !tracks?.length, onSelect: () => tracks && player.playList(tracks, 0, { shuffle: false }) },
    { label: 'Играть следующим', icon: <ListPlus {...ic} />, disabled: !tracks?.length, onSelect: () => tracks && player.playNext(tracks) },
    { label: 'В конец очереди', icon: <ListEnd {...ic} />, disabled: !tracks?.length, onSelect: () => tracks && player.addToQueue(tracks) },
  ]
  if (p.canEdit) {
    items.push(
      { separator: true },
      { label: 'Изменить…', onSelect: () => useSheet.getState().open({ kind: 'playlist-edit', playlist: p }) },
      {
        label: 'Удалить плейлист',
        icon: <Trash2 {...ic} />,
        danger: true,
        onSelect: () =>
          useSheet.getState().open({
            kind: 'confirm',
            title: 'Удалить плейлист?',
            message: `«${p.title}» исчезнет из VK вместе со списком треков. Сами треки останутся.`,
            confirmLabel: 'Удалить',
            danger: true,
            onConfirm: async () => {
              await vk.deletePlaylist(p)
              toast('Плейлист удалён', 'removed')
              void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
              const r = useRouter.getState()
              if (r.route.name === 'playlist' && r.route.id === p.id) r.replace({ name: 'playlists' })
            },
          }),
      },
    )
  } else if (p.isFollowed) {
    items.push(
      { separator: true },
      {
        label: 'Убрать из моих плейлистов',
        icon: <Trash2 {...ic} />,
        danger: true,
        onSelect: async () => {
          try {
            await vk.deletePlaylist(p)
            toast('Плейлист убран', 'removed')
            void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
          } catch (e) {
            toast(describeError(e), 'error')
          }
        },
      },
    )
  } else {
    items.push(
      { separator: true },
      {
        label: 'Добавить к себе',
        icon: <Plus {...ic} />,
        onSelect: async () => {
          try {
            await vk.followPlaylist(p)
            toast('Плейлист добавлен к вам', 'added')
            void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
          } catch (e) {
            toast(describeError(e), 'error')
          }
        },
      },
    )
  }
  return items
}
