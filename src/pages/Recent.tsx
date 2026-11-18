import { Clock3, Shuffle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SERVICES } from '../app/service'
import { Button } from '../components/controls'
import { EmptyState } from '../components/cards'
import { IconPlay } from '../components/Icons'
import { PageHeader } from '../components/PageHeader'
import { ServiceLogo } from '../components/ServiceLogo'
import { TrackList } from '../components/TrackList'
import { saveJSON } from '../lib/persist'
import * as Q from '../player/queue'
import { usePlayer } from '../player/store'
import { serviceOf, type ServiceId, type Track } from '../vk/models'
import s from './pages.module.css'

const RECENT_FILTER_KEY = 'nocturne:recent-filter:v1'
type RecentServiceFilter = Record<ServiceId, boolean>
const DEFAULT_FILTER: RecentServiceFilter = { vk: true, sc: true, spotify: true }

function loadRecentFilter(): RecentServiceFilter {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(RECENT_FILTER_KEY)
    if (!raw) return DEFAULT_FILTER
    const parsed = JSON.parse(raw) as Partial<RecentServiceFilter> | null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_FILTER
    return {
      vk: typeof parsed.vk === 'boolean' ? parsed.vk : true,
      sc: typeof parsed.sc === 'boolean' ? parsed.sc : true,
      spotify: typeof parsed.spotify === 'boolean' ? parsed.spotify : true,
    }
  } catch {
    return DEFAULT_FILTER
  }
}

function saveRecentFilter(filter: RecentServiceFilter): void {
  try {
    ;(globalThis as { localStorage?: Storage }).localStorage?.setItem(RECENT_FILTER_KEY, JSON.stringify(filter))
  } catch {}
}

function syncRecentQueue(history: Track[], nextFilter: RecentServiceFilter) {
  const st = usePlayer.getState()
  if (st.source?.label !== 'Недавние' || !st.queue) return
  const nextFiltered = history.filter((t) => nextFilter[serviceOf(t)])
  if (nextFiltered.length === 0) {
    st.pause()
    usePlayer.setState({ queue: null })
    return
  }
  const cur = st.current
  if (cur && nextFilter[serviceOf(cur)]) {
    const idx = nextFiltered.findIndex((t) => t.key === cur.key)
    if (idx >= 0) {
      usePlayer.setState({ queue: Q.createQueue(nextFiltered, idx, st.shuffle, st.repeat) })
      return
    }
  }
  st.playList(nextFiltered, 0, {
    shuffle: st.shuffle,
    source: { kind: 'list', label: 'Недавние' },
    paused: !st.isPlaying,
  })
}

export function Recent() {
  const history = usePlayer((p) => p.history)
  const [filter, setFilter] = useState<RecentServiceFilter>(loadRecentFilter)

  const filteredHistory = useMemo(() => history.filter((t) => filter[serviceOf(t)]), [history, filter])

  const toggleService = (id: ServiceId) => {
    const next = { ...filter, [id]: !filter[id] }
    setFilter(next)
    saveRecentFilter(next)
    syncRecentQueue(history, next)
  }

  return (
    <>
      <PageHeader
        title="Недавние"
        actions={
          history.length > 0 && (
            <>
              <Button
                variant="primary"
                disabled={filteredHistory.length === 0}
                onClick={() =>
                  usePlayer.getState().playList(filteredHistory, 0, { shuffle: false, source: { kind: 'list', label: 'Недавние' } })
                }
              >
                <IconPlay size={15} /> Слушать
              </Button>
              <Button
                variant="tinted"
                disabled={filteredHistory.length === 0}
                onClick={() =>
                  usePlayer.getState().playList(filteredHistory, 0, { shuffle: true, source: { kind: 'list', label: 'Недавние' } })
                }
              >
                <Shuffle size={15} strokeWidth={2.2} /> Перемешать
              </Button>
              <Button
                onClick={() => {
                  usePlayer.setState({ history: [] })
                  void saveJSON('history', [])
                }}
              >
                Очистить
              </Button>
            </>
          )
        }
      />
      {history.length > 0 && (
        <div className={s.serviceFilters} role="group" aria-label="Фильтр по площадкам">
          {SERVICES.map((info) => {
            const on = filter[info.id]
            return (
              <button
                key={info.id}
                type="button"
                aria-pressed={on}
                title={info.name}
                className={s.serviceTile}
                data-on={on || undefined}
                style={{ ['--ring' as string]: info.color }}
                onClick={() => toggleService(info.id)}
              >
                <ServiceLogo id={info.id} size={36} tone="dark" />
              </button>
            )
          })}
        </div>
      )}
      {history.length === 0 ? (
        <EmptyState icon={<Clock3 size={26} />} title="История пуста" text="Здесь появятся треки, которые вы дослушаете хотя бы до половины." />
      ) : filteredHistory.length === 0 ? (
        <EmptyState
          icon={<Clock3 size={26} />}
          title="Нет треков по выбранному фильтру"
          text="Выберите площадки выше, чтобы отобразить и слушать их треки."
        />
      ) : (
        <TrackList
          tracks={filteredHistory}
          queueSource={filteredHistory}
          queueMeta={{ kind: 'list', label: 'Недавние' }}
          markService
        />
      )}
    </>
  )
}
