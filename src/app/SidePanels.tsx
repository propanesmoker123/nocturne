import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { AnimatedLyrics } from '../lyrics/AnimatedLyrics'
import { queryClient } from './queryClient'
import { findLyrics } from './lyrics'
import lyCss from '../lyrics/AnimatedLyrics.module.css'
import { RefreshCw, X } from 'lucide-react'
import { ServiceLogo } from '../components/ServiceLogo'
import { EqualizerBars, IconButton, Spinner } from '../components/controls'
import { IconLyrics } from '../components/Icons'
import { formatTime, pluralRu } from '../lib/format'
import { scrollWithin } from '../lib/scrollWithin'
import { remainingSeconds } from '../player/logic'
import { allInOrder } from '../player/queue'
import { usePlayer } from '../player/store'
import { serviceOf, type Track } from '../vk/models'
import { describeError } from '../vk/errors'
import s from './SidePanels.module.css'
import { openTrackMenu } from './trackActions'

function minutesLabel(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} ${pluralRu(m, 'минута', 'минуты', 'минут')}`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} ч ${rest} мин` : `${h} ч`
}

/** Separate so the playback clock re-renders only this line, not every queue row. */
function QueueHeader({ label, count }: { label: string; count: number }) {
  const queue = usePlayer((p) => p.queue)
  const position = usePlayer((p) => p.position)
  return (
    <div className={s.header}>
      <span className={s.headerTitle}>{label}</span>
      <span className={s.headerMeta}>
        {count} {pluralRu(count, 'трек', 'трека', 'треков')} · {minutesLabel(remainingSeconds(queue, position))}
      </span>
    </div>
  )
}

/** Keys that stay put while the queue advances, so rows (and their artwork) are not rebuilt. */
function stableKeys(tracks: Track[]): string[] {
  const seen = new Map<string, number>()
  return tracks.map((t) => {
    const n = seen.get(t.key) ?? 0
    seen.set(t.key, n + 1)
    return `${t.key}#${n}`
  })
}

/** One continuous list in play order: what already played (dimmed), what plays now, what comes next. */
export function QueuePanel() {
  const queue = usePlayer((p) => p.queue)
  const source = usePlayer((p) => p.source)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const remoteName = usePlayer((p) => p.remoteName)
  const { jumpTo, removeFromQueue, moveInQueue } = usePlayer.getState()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const nowLabel = useRef<HTMLLIElement>(null)
  const scrolledOnce = useRef(false)

  const rows = useMemo(() => (queue ? allInOrder(queue) : []), [queue])
  const keys = useMemo(() => stableKeys(rows.map((r) => r.item)), [rows])
  const pos = queue?.pos ?? -1

  // Open on the current track (what played is above it); follow it when the track changes
  useEffect(() => {
    scrollWithin(nowLabel.current, 'start', scrolledOnce.current)
    scrolledOnce.current = true
  }, [pos])

  if (remoteName) {
    return (
      <div className={s.empty}>
        <span>Очередь — на устройстве «{remoteName}»</span>
      </div>
    )
  }
  if (!queue || rows.length === 0) {
    return (
      <div className={s.empty}>
        <span>Очередь пуста</span>
      </div>
    )
  }
  const upcomingCount = rows.length - pos - 1

  return (
    <>
      <QueueHeader label={source?.label ?? 'Очередь'} count={rows.length} />
      <ol className={s.list}>
        {rows.map(({ orderPos, item: t, part }, i) => {
          const next = part === 'next'
          return (
            <Fragment key={keys[i]}>
              {(i === 0 && part === 'played') && <li className={s.groupLabel}>Уже играло</li>}
              {part === 'current' && (
                <li ref={nowLabel} className={s.groupLabel}>
                  Сейчас играет
                </li>
              )}
              {next && orderPos === pos + 1 && <li className={s.groupLabel}>Далее</li>}
              <li
                className={s.row}
                tabIndex={0}
                draggable={next}
                title={part === 'current' ? undefined : 'Играть'}
                data-played={part === 'played' || undefined}
                data-current={part === 'current' || undefined}
                data-dragging={dragFrom === orderPos || undefined}
                data-drop-target={next && dropAt === orderPos && dragFrom !== orderPos ? true : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDragFrom(orderPos)
                }}
                onDragOver={(e) => {
                  if (!next || dragFrom === null) return
                  e.preventDefault()
                  setDropAt(orderPos)
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDropAt(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (next && dragFrom !== null && dragFrom !== orderPos) moveInQueue(dragFrom, orderPos)
                  setDragFrom(null)
                  setDropAt(null)
                }}
                onClick={() => part !== 'current' && jumpTo(orderPos)}
                onContextMenu={(e) => openTrackMenu(e, t, { inNowPlaying: true, queuePos: orderPos })}
                onKeyDown={(e) => e.key === 'Enter' && part !== 'current' && jumpTo(orderPos)}
              >
                <Artwork src={t.cover?.s} size={40} radius={6} seed={t.key} />
                <div className={s.rowText}>
                  <div className={`${s.rowTitle} truncate`}>
                    {serviceOf(t) !== 'vk' && <ServiceLogo id={serviceOf(t)} size={13} className={s.rowMark} />}
                    {t.title}
                  </div>
                  <div className={`${s.rowArtist} truncate`}>{t.artist}</div>
                </div>
                <div className={s.rowEnd}>
                  {part === 'current' ? (
                    <EqualizerBars playing={isPlaying} height={14} />
                  ) : (
                    <span className={s.duration}>{formatTime(t.duration)}</span>
                  )}
                  {next && (
                    <IconButton
                      className={s.removeBtn}
                      size={26}
                      label="Убрать из очереди"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFromQueue(orderPos)
                      }}
                    >
                      <X size={15} strokeWidth={2.2} />
                    </IconButton>
                  )}
                </div>
              </li>
            </Fragment>
          )
        })}
        {upcomingCount === 0 && (
          <li className={s.endNote}>{source?.kind === 'mix' ? `${source.label || 'VK Микс'} подбирает следующие треки…` : 'Дальше в очереди ничего нет'}</li>
        )}
      </ol>
    </>
  )
}

export function LyricsPanel({ theater }: { theater?: boolean } = {}) {
  const track = usePlayer((p) => p.current)
  const fromVk = !!track && serviceOf(track) !== 'vk'
  const [refreshing, setRefreshing] = useState(false)

  const q = useQuery({
    queryKey: ['lyrics', track?.key],
    queryFn: () => findLyrics(track!),
    enabled: !!track,
    staleTime: Infinity,
  })
  const lyrics = q.data

  const forceRefresh = async () => {
    if (!track || refreshing) return
    setRefreshing(true)
    try {
      const fresh = await findLyrics(track, { force: true })
      queryClient.setQueryData(['lyrics', track.key], fresh)
    } finally {
      setRefreshing(false)
    }
  }

  if (!track) return null
  if (q.isLoading) {
    return (
      <div className={s.empty}>
        <Spinner />
      </div>
    )
  }
  if (lyrics?.instrumental) {
    return (
      <div className={s.empty}>
        <div className={s.emptyBadge}>
          <IconLyrics size={24} />
        </div>
        <span className={s.emptyTitle}>Инструментальный трек</span>
        <span className={s.emptySub}>В этой композиции нет вокала</span>
        {lyrics.credits && <div className={s.credits}>{lyrics.credits}</div>}
      </div>
    )
  }

  if (q.isError || !lyrics?.lines.length) {
    return (
      <div className={s.empty}>
        <div className={s.emptyBadge}>
          <IconLyrics size={24} />
        </div>
        <span className={s.emptyTitle}>{q.isError ? describeError(q.error) : 'Текст для этого трека не найден'}</span>
        {!q.isError && <span className={s.emptySub}>Слова к этой композиции пока не добавлены</span>}
        <div className={lyCss.actionRow}>
          <button
            type="button"
            className={lyCss.actionPill}
            disabled={refreshing}
            onClick={() => void forceRefresh()}
          >
            <RefreshCw size={12} />
            Проверить снова
          </button>
        </div>
      </div>
    )
  }

  const footer = (
    <div className={lyCss.metaBarActions}>
      <button
        type="button"
        className={lyCss.actionPill}
        disabled={refreshing}
        onClick={() => void forceRefresh()}
      >
        <RefreshCw size={12} />
        Обновить
      </button>
    </div>
  )

  return <AnimatedLyrics track={track} lyrics={lyrics} fromVk={fromVk} theater={theater} footer={footer} />
}
