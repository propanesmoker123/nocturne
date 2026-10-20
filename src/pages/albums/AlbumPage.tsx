import { ArrowDown, ArrowUp, Disc3, ImageMinus, ImagePlus, ListX, Shuffle } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useChrome } from '../../app/chrome'
import { showMenu, type MenuItem } from '../../app/menu'
import { useRouter } from '../../app/router'
import { useSheet } from '../../app/sheetStore'
import { toast } from '../../app/toast'
import { makeCover, pickImage } from '../../albums/coverImage'
import { albumArt, liveEntries, toTrack } from '../../albums/model'
import { useAlbums } from '../../albums/store'
import { Artwork } from '../../components/Artwork'
import { Button, IconButton } from '../../components/controls'
import { EmptyState } from '../../components/cards'
import { IconMore, IconPlay } from '../../components/Icons'
import { TrackList } from '../../components/TrackList'
import { formatLongDuration, pluralRu } from '../../lib/format'
import { usePlayer } from '../../player/store'
import { useScSession } from '../../sc/session'
import s from '../pages.module.css'
import a from './albums.module.css'

const ic = { size: 16, strokeWidth: 1.9 } as const

export function AlbumPage({ id }: { id: string }) {
  const doc = useAlbums((x) => x.docs[id])
  const entry = useAlbums((x) => x.list.find((e) => e.id === id))
  const scSignedOut = useScSession((x) => x.phase === 'signed-out')
  const setTitle = useChrome((c) => c.setTitle)
  const name = doc?.meta.name || entry?.name || ''
  useEffect(() => setTitle(name), [name, setTitle])

  const live = useMemo(() => (doc ? liveEntries(doc) : []), [doc])
  const tracks = useMemo(
    // a SoundCloud track does not play without its account
    () => live.map((e) => ({ ...toTrack(e), ...(scSignedOut && e.track?.service === 'sc' ? { playable: false } : {}) })),
    [live, scSignedOut],
  )

  if (!doc || !entry || entry.removedAt || doc.meta.deletedAt) {
    return <EmptyState icon={<Disc3 size={26} />} title="Альбома больше нет" text="Его удалили или у вас больше нет к нему доступа." />
  }

  const shared = entry.shared
  const total = tracks.reduce((n, t) => n + t.duration, 0)
  const hasCover = !!doc.cover?.image
  const source = { kind: 'list' as const, label: name }
  const playable = tracks.some((t) => t.playable)
  const albums = useAlbums.getState()

  const chooseCover = async () => {
    const file = await pickImage()
    if (!file) return
    const image = await makeCover(file).catch(() => null)
    if (!image) return toast('Эту картинку не получилось открыть — попробуйте JPG или PNG', 'error')
    albums.setCover(id, image)
    toast(shared ? 'Обложка обновлена — её увидят все, у кого есть альбом' : 'Обложка обновлена', 'added')
  }

  const menu: MenuItem[] = [
    { label: 'Переименовать', onSelect: () => useSheet.getState().open({ kind: 'album-rename', id }) },
    { label: hasCover ? 'Сменить обложку' : 'Загрузить обложку', icon: <ImagePlus {...ic} />, onSelect: () => void chooseCover() },
    ...(hasCover ? [{ label: 'Убрать обложку', icon: <ImageMinus {...ic} />, onSelect: () => albums.setCover(id, null) }] : []),
    { label: 'Поделиться', onSelect: () => useSheet.getState().open({ kind: 'album-share', id }) },
    {
      label: 'Сменить код доступа',
      onSelect: () =>
        useSheet.getState().open({
          kind: 'confirm',
          title: 'Сменить код доступа?',
          message: 'Все, кому вы дали код, потеряют доступ к альбому. Ваши устройства перейдут на новый код сами.',
          confirmLabel: 'Сменить',
          danger: true,
          onConfirm: () => {
            albums.rotate(id)
            useSheet.getState().open({ kind: 'album-share', id })
          },
        }),
    },
    { separator: true },
    shared
      ? {
          label: 'Удалить у себя',
          danger: true,
          onSelect: () =>
            useSheet.getState().open({
              kind: 'confirm',
              title: 'Удалить альбом у себя?',
              message: `«${name}» пропадёт с ваших устройств. У остальных он останется.`,
              confirmLabel: 'Удалить',
              danger: true,
              onConfirm: () => {
                albums.leave(id)
                useRouter.getState().replace({ name: 'albums' })
              },
            }),
        }
      : {
          label: 'Удалить альбом',
          danger: true,
          onSelect: () =>
            useSheet.getState().open({
              kind: 'confirm',
              title: 'Удалить альбом?',
              message: `«${name}» пропадёт со всех ваших устройств. Сами треки останутся в сервисах.`,
              confirmLabel: 'Удалить',
              danger: true,
              onConfirm: () => {
                albums.deleteForAll(id)
                toast('Альбом удалён', 'removed')
                useRouter.getState().replace({ name: 'albums' })
              },
            }),
        },
  ]

  const rowMenu = (_t: unknown, index: number): MenuItem[] => {
    const eid = live[index]?.eid
    if (!eid) return []
    return [
      { label: 'Выше', icon: <ArrowUp {...ic} />, disabled: index === 0, onSelect: () => albums.move(id, eid, index - 1) },
      { label: 'Ниже', icon: <ArrowDown {...ic} />, disabled: index === live.length - 1, onSelect: () => albums.move(id, eid, index + 1) },
      { label: 'Убрать из альбома', icon: <ListX {...ic} />, danger: true, onSelect: () => albums.removeEntry(id, eid) },
    ]
  }

  return (
    <>
      <div className={s.hero}>
        <button type="button" className={a.heroCover} title={hasCover ? 'Сменить обложку' : 'Загрузить обложку'} onClick={() => void chooseCover()}>
          <Artwork className={s.heroArt} {...albumArt(doc)} size={232} radius={14} seed={name || id} />
          <span className={a.heroCoverHint} aria-hidden="true">
            <ImagePlus size={22} strokeWidth={1.9} />
            {hasCover ? 'Сменить обложку' : 'Своя обложка'}
          </span>
        </button>
        <div style={{ minWidth: 0 }}>
          <div className={s.heroKind}>{shared ? 'Общий альбом' : 'Альбом Nocturne'}</div>
          <h1 className={s.heroTitle}>{name}</h1>
          <div className={s.heroMeta}>{[`${tracks.length} ${pluralRu(tracks.length, 'трек', 'трека', 'треков')}`, total ? formatLongDuration(total) : null].filter(Boolean).join(' · ')}</div>
          <div className={s.heroActions}>
            <Button variant="primary" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: false, source })}>
              <IconPlay size={15} /> Слушать
            </Button>
            <Button variant="tinted" disabled={!playable} onClick={() => usePlayer.getState().playList(tracks, 0, { shuffle: true, source })}>
              <Shuffle size={15} strokeWidth={2.2} /> Перемешать
            </Button>
            <IconButton label="Ещё" onClick={(e) => showMenu(e, menu)}>
              <IconMore size={20} />
            </IconButton>
          </div>
        </div>
      </div>
      {tracks.length === 0 ? (
        <EmptyState icon={<Disc3 size={26} />} title="В альбоме пока нет треков" text="Плюс в строке любого трека VK или SoundCloud добавляет его сюда." />
      ) : (
        <TrackList tracks={tracks} showAlbum={false} markService menuExtra={rowMenu} onReorder={(from, to) => live[from] && albums.move(id, live[from].eid, to)} />
      )}
    </>
  )
}
