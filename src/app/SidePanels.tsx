import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Artwork } from '../components/Artwork'
import { IconButton, Spinner } from '../components/controls'
import { IconLyrics } from '../components/Icons'
import { formatTime, pluralRu } from '../lib/format'
import { remainingSeconds } from '../player/logic'
import { upcoming } from '../player/queue'
import { usePlayer } from '../player/store'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import s from './SidePanels.module.css'
import { X } from 'lucide-react'

function minutesLabel(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} ${pluralRu(m, 'минута', 'минуты', 'минут')}`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} ч ${rest} мин` : `${h} ч`
}

export function QueuePanel() {
  const queue = usePlayer((p) => p.queue)
  const position = usePlayer((p) => p.position)
  const source = usePlayer((p) => p.source)
  const { jumpTo, removeFromQueue, moveInQueue } = usePlayer.getState()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const rest = queue ? upcoming(queue) : []
  const left = remainingSeconds(queue, position)
  if (!queue || rest.length === 0) {
    return (
      <div className={s.empty}>
        <span>{source?.kind === 'mix' ? 'VK Микс подбирает следующие треки…' : 'Очередь закончилась'}</span>
      </div>
    )
  }
  const [nextUp, ...later] = rest
  const base = queue.pos + 1

  return (
    <>
      <div className={s.header}>
        <span className={s.headerTitle}>{source?.label ?? 'Очередь'}</span>
        <span className={s.headerMeta}>
          {rest.length} {pluralRu(rest.length, 'трек', 'трека', 'треков')} · {minutesLabel(left)}
        </span>
      </div>
      <button type="button" className={s.nextUp} onClick={() => jumpTo(base)} style={{ width: 'calc(100% - 16px)', textAlign: 'left' }}>
        <Artwork src={nextUp.cover?.m} size={64} radius={8} seed={nextUp.key} />
        <div className={s.rowText}>
          <div className={s.nextLabel}>Следующий</div>
          <div className={`${s.rowTitle} truncate`}>{nextUp.title}</div>
          <div className={`${s.rowArtist} truncate`}>{nextUp.artist}</div>
        </div>
      </button>
      <ol className={s.list}>
        {later.map((t, i) => {
          const orderPos = base + 1 + i
          return (
            <li
              key={`${t.key}-${orderPos}`}
              className={s.row}
              draggable
              data-dragging={dragFrom === orderPos || undefined}
              data-drop-target={dropAt === orderPos && dragFrom !== orderPos ? true : undefined}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragFrom(orderPos)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDropAt(orderPos)
              }}
              onDragEnd={() => {
                setDragFrom(null)
                setDropAt(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== orderPos) moveInQueue(dragFrom, orderPos)
                setDragFrom(null)
                setDropAt(null)
              }}
              onDoubleClick={() => jumpTo(orderPos)}
            >
              <Artwork src={t.cover?.s} size={40} radius={6} seed={t.key} />
              <div className={s.rowText}>
                <div className={`${s.rowTitle} truncate`}>{t.title}</div>
                <div className={`${s.rowArtist} truncate`}>{t.artist}</div>
              </div>
              <div className={s.rowEnd}>
                <span className={s.duration}>{formatTime(t.duration)}</span>
                <IconButton className={s.removeBtn} size={26} label="Убрать из очереди" onClick={() => removeFromQueue(orderPos)}>
                  <X size={15} strokeWidth={2.2} />
                </IconButton>
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}

export function LyricsPanel() {
  const track = usePlayer((p) => p.current)
  const position = usePlayer((p) => p.position)
  const seek = usePlayer((p) => p.seek)
  const box = useRef<HTMLDivElement>(null)
  const q = useQuery({
    queryKey: ['lyrics', track?.key],
    queryFn: () => vk.getLyrics(track!),
    enabled: !!track && track.hasLyrics,
    staleTime: Infinity,
  })
  const lyrics = q.data

  const activeIndex = useMemo(() => {
    if (!lyrics?.synced) return -1
    const ms = position * 1000
    let idx = -1
    for (let i = 0; i < lyrics.lines.length; i++) {
      if ((lyrics.lines[i].begin ?? Infinity) <= ms) idx = i
      else break
    }
    return idx
  }, [lyrics, position])

  useEffect(() => {
    if (activeIndex < 0 || !box.current) return
    const el = box.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeIndex])

  if (!track) return null
  if (!track.hasLyrics) {
    return (
      <div className={s.empty}>
        <IconLyrics size={28} />
        <span>Для этого трека в VK нет текста</span>
      </div>
    )
  }
  if (q.isLoading) {
    return (
      <div className={s.empty}>
        <Spinner />
      </div>
    )
  }
  if (q.isError || !lyrics) {
    return <div className={s.empty}>{q.isError ? describeError(q.error) : 'Текст не найден'}</div>
  }
  return (
    <div ref={box} className={`${s.lyrics} ${lyrics.synced ? '' : s.plain}`}>
      {lyrics.lines.map((l, i) => (
        <button
          type="button"
          key={i}
          data-index={i}
          className={s.line}
          data-active={i === activeIndex || undefined}
          data-past={lyrics.synced && i < activeIndex ? true : undefined}
          onClick={() => lyrics.synced && l.begin !== undefined && seek(l.begin / 1000)}
        >
          {l.text || '♪'}
        </button>
      ))}
      {lyrics.credits && <div className={s.credits}>{lyrics.credits}</div>}
    </div>
  )
}
