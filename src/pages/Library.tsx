import { LibraryBig, Search, Shuffle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { myTracksKey } from '../app/library'
import { Button } from '../components/controls'
import { EmptyState, TrackListSkeleton } from '../components/cards'
import { IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { filterTracks, formatLongDuration, pluralRu } from '../lib/format'
import { useAllPages } from '../lib/hooks'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import s from './pages.module.css'

export function Library() {
  const me = vk.getMeId()
  const q = useAllPages(myTracksKey(), (offset) => vk.getTracks(me, offset, 500))
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => filterTracks(q.items, filter), [q.items, filter])
  const totalSec = useMemo(() => q.items.reduce((n, t) => n + t.duration, 0), [q.items])
  const playable = shown.filter((t) => t.playable)

  return (
    <>
      <PageHeader
        title="Моя музыка"
        subtitle={q.total ? `${q.total} ${pluralRu(q.total, 'трек', 'трека', 'треков')} · ${formatLongDuration(totalSec)}${q.hasNextPage ? ' · загружаем…' : ''}` : undefined}
      />
      <div className={s.toolbar}>
        <Button variant="primary" disabled={!playable.length} onClick={() => usePlayer.getState().playList(shown, 0, { shuffle: false })}>
          <IconPlay size={15} /> Слушать
        </Button>
        <Button variant="tinted" disabled={!playable.length} onClick={() => usePlayer.getState().playList(shown, 0, { shuffle: true })}>
          <Shuffle size={15} strokeWidth={2.2} /> Перемешать
        </Button>
        <label className={s.filter}>
          <Search size={15} strokeWidth={2.2} />
          <input placeholder="Найти в моей музыке" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        </label>
      </div>
      {q.isLoading && <TrackListSkeleton rows={10} />}
      {q.isError && <EmptyState icon={<LibraryBig size={26} />} title="Не удалось загрузить музыку" text={describeError(q.error)} />}
      {!q.isLoading && !q.isError && q.items.length === 0 && (
        <EmptyState icon={<LibraryBig size={26} />} title="Здесь пока пусто" text="Добавляйте треки кнопкой «+» — они появятся здесь и во всех ваших VK-клиентах." />
      )}
      {q.items.length > 0 && shown.length === 0 && <div className={s.hint}>Ничего не нашлось по запросу «{filter}»</div>}
      {shown.length > 0 && <TrackList tracks={shown} />}
    </>
  )
}
