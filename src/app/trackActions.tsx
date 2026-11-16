import { Copy, Disc3, ExternalLink, Heart, ListEnd, ListPlus, ListX, Mic2, Plus, Radio, Send, SquarePlus, Trash2 } from 'lucide-react'
import type { MouseEvent } from 'react'
import { albumMenuItems } from '../albums/addMenu'
import { IconPlay } from '../components/Icons'
import { fullTrackName } from '../lib/format'
import { usePlayer } from '../player/store'
import { openInSoundCloud } from '../sc/open'
import * as spotify from '../spotify/api'
import { spKeys } from '../spotify/queries'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import { serviceOf, type Playlist, type Track } from '../vk/models'
import { isInLibrary, likeLabel, toggleLibrary } from './library'
import { showMenu, type MenuItem } from './menu'
import { queryClient } from './queryClient'
import { artistRoute, useRouter } from './router'
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

/** The track's page (in VK, SoundCloud, or Spotify): what «Скопировать ссылку» copies and what goes out when sharing. */
export const trackLink = (t: Pick<Track, 'ownerId' | 'id' | 'service' | 'permalink' | 'spotifyId'>) =>
  serviceOf(t) === 'spotify'
    ? (t.permalink ?? (t.spotifyId ? `https://open.spotify.com/track/${t.spotifyId}` : 'https://open.spotify.com/'))
    : serviceOf(t) === 'sc'
      ? (t.permalink ?? 'https://soundcloud.com/')
      : `https://vk.com/audio${t.ownerId}_${t.id}`

export async function copyTrackLink(t: Pick<Track, 'ownerId' | 'id' | 'service' | 'permalink' | 'spotifyId'>) {
  await navigator.clipboard.writeText(trackLink(t))
}

/** «Поделиться треком»: a VK track goes to a friend; a SoundCloud/Spotify one has its link copied. */
export function shareTrack(t: Track) {
  if (serviceOf(t) === 'vk') return useSheet.getState().open({ kind: 'send-track', track: t })
  void copyTrackLink(t).then(
    () => toast('Ссылка скопирована', 'info'),
    () => toast('Не получилось скопировать', 'error'),
  )
}

/** A click on the title in the player copies «Исполнитель — Название». */
export function copyTrackName(t: Track) {
  void navigator.clipboard.writeText(fullTrackName(t)).then(
    () => toast('Название скопировано', 'info'),
    () => toast('Не получилось скопировать', 'error'),
  )
}

interface TrackMenuContext {
  list?: Track[]
  index?: number
  playlist?: Playlist
  inNowPlaying?: boolean
  /** Opened on a queue row: «Играть следующим» moves that entry instead of adding a copy. */
  queuePos?: number
  /** Items of the list the track is in (an album's «Выше», «Ниже», «Убрать из альбома»). */
  extra?: MenuItem[]
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
  const queuePos = ctx.queuePos
  if (queuePos === undefined) {
    items.push(
      { label: 'Играть следующим', icon: <ListPlus {...ic} />, disabled: !track.playable, onSelect: () => player.playNext([track]) },
      { label: 'В конец очереди', icon: <ListEnd {...ic} />, disabled: !track.playable, onSelect: () => player.addToQueue([track]) },
      { separator: true },
    )
  } else if (queuePos !== player.queue?.pos) {
    items.push(
      { label: 'Играть следующим', icon: <ListPlus {...ic} />, disabled: !track.playable, onSelect: () => player.playNextFromQueue(queuePos) },
      { label: 'Убрать из очереди', icon: <ListX {...ic} />, onSelect: () => player.removeFromQueue(queuePos) },
      { separator: true },
    )
  }
  if (serviceOf(track) === 'sc') return withExtra(items.concat(scTrackItems(track, liked)), ctx.extra)
  if (serviceOf(track) === 'spotify') return withExtra(items.concat(spotifyTrackItems(track, liked)), ctx.extra)
  items.push(
    likeItem(track, liked),
    albumItem(track),
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
  items.push({ label: 'Отправить другу', icon: <Send {...ic} />, onSelect: () => useSheet.getState().open({ kind: 'send-track', track }) })
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
      router.push(artistRoute(track, artist))
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
      void copyTrackLink(track)
      toast('Ссылка скопирована', 'info')
    },
  })
  return withExtra(items, ctx.extra)
}

/** The heart: the service's own like. */
const likeItem = (track: Track, liked: boolean): MenuItem => ({
  label: likeLabel(track, liked),
  icon: <Heart {...ic} fill={liked ? 'currentColor' : 'none'} />,
  onSelect: () => void toggleLibrary(track),
})

/** The plus: one of Nocturne's albums, for a track of any service. */
const albumItem = (track: Track): MenuItem => ({ label: 'Добавить в альбом Nocturne', icon: <SquarePlus {...ic} />, submenu: async () => albumMenuItems([track]) })

const withExtra = (items: MenuItem[], extra?: MenuItem[]) => (extra?.length ? [...items, { separator: true } as MenuItem, ...extra] : items)

/** The rest of a SoundCloud track's menu: its like, its artist, its page. Nothing of VK's. */
function scTrackItems(track: Track, liked: boolean): MenuItem[] {
  return [
    likeItem(track, liked),
    albumItem(track),
    { separator: true },
    {
      label: 'Перейти к исполнителю',
      icon: <Mic2 {...ic} />,
      onSelect: () => {
        useUi.getState().closeNowPlaying()
        useRouter.getState().push(artistRoute(track))
      },
    },
    { label: 'Открыть в SoundCloud', icon: <ExternalLink {...ic} />, disabled: !track.permalink, onSelect: () => void openInSoundCloud(track.permalink) },
    {
      label: 'Скопировать ссылку',
      icon: <Copy {...ic} />,
      onSelect: () => {
        void copyTrackLink(track)
        toast('Ссылка скопирована', 'info')
      },
    },
  ]
}

function spotifyTrackItems(track: Track, liked: boolean): MenuItem[] {
  const router = useRouter.getState()
  const items: MenuItem[] = [
    likeItem(track, liked),
    albumItem(track),
  ]
  if (track.spotifyId) {
    const trackId = track.spotifyId
    items.push(
      {
        label: 'Добавить в плейлист Spotify',
        icon: <Plus {...ic} />,
        submenu: async () => {
          const lists = await queryClient
            .fetchQuery({ queryKey: spKeys.editablePlaylists(), queryFn: spotify.getEditablePlaylists, staleTime: 60_000 })
            .catch(() => [] as Playlist[])
          if (!lists.length) return [{ label: 'Нет доступных плейлистов', disabled: true }]
          return lists.map((p) => ({
            label: p.title,
            onSelect: async () => {
              try {
                await spotify.addTrackToPlaylist(p.spotifyId!, trackId)
                void queryClient.invalidateQueries({ queryKey: spKeys.playlist(p.spotifyId!, 'playlist') })
                void queryClient.invalidateQueries({ queryKey: spKeys.myPlaylists() })
                toast(`Добавлено в «${p.title}»`, 'added')
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Не удалось добавить в плейлист', 'error')
              }
            },
          }))
        },
      },
      {
        label: 'Включить радио по треку',
        icon: <Radio {...ic} />,
        onSelect: () => {
          useUi.getState().closeNowPlaying()
          void usePlayer.getState().playRadio(track)
        },
      },
    )
  }
  items.push(
    { separator: true },
    {
      label: 'Перейти к исполнителю',
      icon: <Mic2 {...ic} />,
      onSelect: () => {
        useUi.getState().closeNowPlaying()
        router.push(artistRoute(track))
      },
    },
  )
  if (track.album?.spotifyId) {
    const a = track.album
    items.push({
      label: 'Перейти к альбому',
      icon: <Disc3 {...ic} />,
      onSelect: () => {
        useUi.getState().closeNowPlaying()
        router.push({ name: 'spotify-playlist', id: a.spotifyId!, kind: 'album', title: a.title })
      },
    })
  }
  items.push({
    label: 'Скопировать ссылку',
    icon: <Copy {...ic} />,
    onSelect: () => {
      void copyTrackLink(track)
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
  // a SoundCloud or Spotify playlist is only listened to here; editing it stays in its service
  if (p.service === 'sc') {
    if (p.permalink) items.push({ separator: true }, { label: 'Открыть в SoundCloud', icon: <ExternalLink {...ic} />, onSelect: () => void openInSoundCloud(p.permalink) })
    return items
  }
  if (p.service === 'spotify') {
    const link = p.permalink ?? (p.spotifyId ? `https://open.spotify.com/${p.type ?? 'playlist'}/${p.spotifyId}` : '')
    if (p.spotifyId) {
      const id = p.spotifyId
      const isAlbum = p.type === 'album'
      items.push(
        { separator: true },
        {
          label: p.isFollowed ? 'Убрать из медиатеки' : isAlbum ? 'Сохранить альбом' : 'Сохранить плейлист',
          icon: <Heart {...ic} fill={p.isFollowed ? 'currentColor' : 'none'} />,
          onSelect: async () => {
            try {
              const next = !p.isFollowed
              if (isAlbum) await spotify.setAlbumSaved(id, next)
              else await spotify.setPlaylistSaved(id, next)
              void queryClient.invalidateQueries({ queryKey: isAlbum ? spKeys.albums() : spKeys.myPlaylists() })
              void queryClient.invalidateQueries({ queryKey: ['playlist', p.ownerId, p.id] })
              toast(next ? 'Добавлено в медиатеку Spotify' : 'Убрано из медиатеки Spotify', next ? 'added' : 'removed')
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Не удалось обновить медиатеку Spotify', 'error')
            }
          },
        },
      )
    }
    if (link) {
      items.push(
        { separator: true },
        {
          label: 'Скопировать ссылку',
          icon: <Copy {...ic} />,
          onSelect: () => {
            void navigator.clipboard.writeText(link)
            toast('Ссылка скопирована', 'info')
          },
        },
      )
    }
    return items
  }
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
            const mine = queryClient.getQueryData<{ items: Playlist[] }>(myPlaylistsKey())
            const ownCopy = mine?.items?.find(
              (m) => (m.ownerId === p.ownerId && m.id === p.id) || (m.original?.ownerId === p.ownerId && m.original?.id === p.id),
            )
            await vk.deletePlaylist(ownCopy ?? p)
            toast('Плейлист убран', 'removed')
            void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
            void queryClient.invalidateQueries({ queryKey: ['playlist', p.ownerId, p.id] })
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
            void queryClient.invalidateQueries({ queryKey: ['playlist', p.ownerId, p.id] })
          } catch (e) {
            toast(describeError(e), 'error')
          }
        },
      },
    )
  }
  return items
}
