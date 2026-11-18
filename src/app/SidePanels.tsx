import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { allInOrder, current as currentInQueue, move as moveQueue } from '../player/queue'
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

interface QueueDragState {
  from: number
  to: number
  settling: boolean
}

/** One continuous list in play order: what already played (dimmed), what plays now, what comes next. */
export function QueuePanel() {
  const queue = usePlayer((p) => p.queue)
  const source = usePlayer((p) => p.source)
  const isPlaying = usePlayer((p) => p.isPlaying)
  const remoteName = usePlayer((p) => p.remoteName)
  const { jumpTo, removeFromQueue, moveInQueue } = usePlayer.getState()
  const [drag, setDrag] = useState<QueueDragState | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const nowLabel = useRef<HTMLLIElement>(null)
  const scrolledOnce = useRef(false)
  const suppressClickRef = useRef(false)
  const cleanupDragRef = useRef<(() => void) | null>(null)
  const prevRectsRef = useRef<Map<string, number>>(new Map())
  const dragPointerRef = useRef<{ clientY: number; grabOffsetY: number }>({ clientY: 0, grabOffsetY: 27 })

  const itemKeys = useMemo(() => (queue ? stableKeys(queue.items) : []), [queue?.items])
  const displayQueue = useMemo(
    () => (queue && drag && drag.from !== drag.to ? moveQueue(queue, drag.from, drag.to) : queue),
    [queue, drag?.from, drag?.to],
  )
  const rows = useMemo(() => (displayQueue ? allInOrder(displayQueue) : []), [displayQueue])
  const pos = displayQueue?.pos ?? -1
  const currentKey = queue ? currentInQueue(queue)?.key : undefined

  useEffect(() => () => cleanupDragRef.current?.(), [])

  // Open on the current track (what played is above it); follow it when the playing track changes
  useEffect(() => {
    if (drag) return
    scrollWithin(nowLabel.current, 'start', scrolledOnce.current)
    scrolledOnce.current = true
  }, [currentKey])

  // FLIP animation whenever `drag.to` swaps rows/headers or when settling on release
  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return

    if (!drag) {
      prevRectsRef.current.clear()
      for (const el of listEl.querySelectorAll<HTMLElement>('[data-flip-id]')) {
        el.style.transition = ''
        el.style.transform = ''
      }
      return
    }

    const listRect = listEl.getBoundingClientRect()
    const draggedEl = listEl.querySelector<HTMLLIElement>('[data-dragging="true"]')
    if (draggedEl) {
      if (drag.settling) {
        draggedEl.style.transition =
          'transform 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease, background-color 180ms ease'
        draggedEl.style.transform = 'translate3d(0, 0, 0) scale(1)'
      } else {
        const { clientY, grabOffsetY } = dragPointerRef.current
        const maxTop = Math.max(0, listEl.offsetHeight - draggedEl.offsetHeight)
        const desiredTop = Math.min(maxTop, Math.max(0, clientY - listRect.top - grabOffsetY))
        const deltaY = desiredTop - draggedEl.offsetTop
        draggedEl.style.transition = 'box-shadow 180ms ease, background-color 140ms ease'
        draggedEl.style.transform = `translate3d(0, ${deltaY}px, 0) scale(1.018)`
      }
    }

    const prevRects = prevRectsRef.current
    if (prevRects.size > 0) {
      const inverted: HTMLElement[] = []
      for (const el of listEl.querySelectorAll<HTMLElement>('[data-flip-id]')) {
        if (el === draggedEl) continue
        const id = el.dataset.flipId
        if (!id) continue
        const prevTop = prevRects.get(id)
        if (prevTop === undefined) continue
        const newNaturalTop = listRect.top + el.offsetTop
        const invertY = prevTop - newNaturalTop
        if (Math.abs(invertY) > 0.5) {
          el.style.transition = 'none'
          el.style.transform = `translate3d(0, ${invertY}px, 0)`
          inverted.push(el)
        }
      }
      prevRects.clear()
      if (inverted.length > 0) {
        void listEl.offsetHeight
        for (const el of inverted) {
          el.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
          el.style.transform = 'translate3d(0, 0, 0)'
        }
      }
    }
  }, [drag?.to, drag?.settling, drag === null])

  if (remoteName) {
    return (
      <div className={s.empty}>
        <span>Очередь — на устройстве «{remoteName}»</span>
      </div>
    )
  }
  if (!queue || !displayQueue || rows.length === 0) {
    return (
      <div className={s.empty}>
        <span>Очередь пуста</span>
      </div>
    )
  }

  const canDrag = rows.length > 1
  const upcomingCount = rows.length - pos - 1

  const beginPointerDrag = (e: ReactPointerEvent<HTMLLIElement>, orderPos: number) => {
    if (!canDrag || e.button !== 0 || drag?.settling) return
    if ((e.target as HTMLElement).closest('button')) return
    const listEl = listRef.current
    if (!listEl) return

    cleanupDragRef.current?.()
    const rowEl = e.currentTarget
    const scroller = listEl.parentElement
    const startX = e.clientX
    const startY = e.clientY
    const initialRowRect = rowEl.getBoundingClientRect()
    const grabOffsetY = Math.min(initialRowRect.height - 4, Math.max(4, startY - initialRowRect.top))
    let active = false
    let lastClientY = startY
    let currentTo = orderPos
    let rafId = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const snapshotVisualPositions = () => {
      const map = prevRectsRef.current
      map.clear()
      for (const el of listEl.querySelectorAll<HTMLElement>('[data-flip-id]')) {
        const id = el.dataset.flipId
        if (id) map.set(id, el.getBoundingClientRect().top)
      }
    }

    const updateDragPosition = (clientY: number) => {
      dragPointerRef.current = { clientY, grabOffsetY }
      const listRect = listEl.getBoundingClientRect()
      const rowEls = Array.from(listEl.querySelectorAll<HTMLLIElement>('[data-queue-idx]'))
      const draggedEl = rowEls[currentTo]
      if (!draggedEl) return

      const rowHeight = draggedEl.offsetHeight || 54
      const maxTop = Math.max(0, listEl.offsetHeight - rowHeight)
      const desiredTop = Math.min(maxTop, Math.max(0, clientY - listRect.top - grabOffsetY))
      const dragCenterY = desiredTop + rowHeight * 0.5

      let nextTo = currentTo
      const currentSlotCenter = draggedEl.offsetTop + rowHeight * 0.5
      if (dragCenterY < currentSlotCenter) {
        for (let i = currentTo - 1; i >= 0; i--) {
          const el = rowEls[i]
          if (dragCenterY < el.offsetTop + el.offsetHeight * 0.5) nextTo = i
          else break
        }
      } else if (dragCenterY > currentSlotCenter) {
        for (let i = currentTo + 1; i < rowEls.length; i++) {
          const el = rowEls[i]
          if (dragCenterY > el.offsetTop + el.offsetHeight * 0.5) nextTo = i
          else break
        }
      }

      if (nextTo !== currentTo) {
        snapshotVisualPositions()
        currentTo = nextTo
        setDrag({ from: orderPos, to: nextTo, settling: false })
      } else {
        const deltaY = desiredTop - draggedEl.offsetTop
        draggedEl.style.transition = 'box-shadow 180ms ease, background-color 140ms ease'
        draggedEl.style.transform = `translate3d(0, ${deltaY}px, 0) scale(1.018)`
      }
    }

    const stepScroll = () => {
      if (!active || !scroller) return
      const box = scroller.getBoundingClientRect()
      const edge = 48
      let delta = 0
      if (lastClientY < box.top + edge) {
        delta = -Math.ceil(((box.top + edge - lastClientY) / edge) * 10)
      } else if (lastClientY > box.bottom - edge) {
        delta = Math.ceil(((lastClientY - (box.bottom - edge)) / edge) * 10)
      }
      if (delta !== 0) {
        const prev = scroller.scrollTop
        scroller.scrollTop += delta
        if (scroller.scrollTop !== prev) {
          updateDragPosition(lastClientY)
        }
      }
      rafId = requestAnimationFrame(stepScroll)
    }

    const onMove = (ev: PointerEvent) => {
      lastClientY = ev.clientY
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
        active = true
        dragPointerRef.current = { clientY: ev.clientY, grabOffsetY }
        setDrag({ from: orderPos, to: orderPos, settling: false })
        rafId = requestAnimationFrame(stepScroll)
      }
      updateDragPosition(ev.clientY)
    }

    const detachListeners = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onCancel)
      cancelAnimationFrame(rafId)
    }

    const finish = (commit: boolean) => {
      detachListeners()
      if (!active) {
        cleanupDragRef.current = null
        return
      }
      suppressClickRef.current = true
      setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      const finalTo = commit ? currentTo : orderPos
      if (!commit && currentTo !== orderPos) {
        snapshotVisualPositions()
      }
      setDrag({ from: orderPos, to: finalTo, settling: true })
      settleTimer = setTimeout(() => {
        settleTimer = null
        cleanupDragRef.current = null
        if (commit && finalTo !== orderPos) moveInQueue(orderPos, finalTo)
        setDrag(null)
      }, 185)
      cleanupDragRef.current = () => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
        detachListeners()
        setDrag(null)
      }
    }

    const onEnd = () => finish(true)
    const onCancel = () => finish(false)

    cleanupDragRef.current = () => {
      if (settleTimer) clearTimeout(settleTimer)
      detachListeners()
      setDrag(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <>
      <QueueHeader label={source?.label ?? 'Очередь'} count={rows.length} />
      <ol ref={listRef} className={s.list} data-reordering={drag !== null || undefined}>
        {rows.map(({ orderPos, item: t, part }, i) => {
          const next = part === 'next'
          const isDragging = drag !== null && orderPos === drag.to
          const itemIdx = displayQueue.order[orderPos]
          const rowKey = itemKeys[itemIdx] ?? `${t.key}#${orderPos}`

          return (
            <Fragment key={rowKey}>
              {i === 0 && part === 'played' && (
                <li className={s.groupLabel} data-flip-id="group:played">
                  Уже играло
                </li>
              )}
              {part === 'current' && (
                <li ref={nowLabel} className={s.groupLabel} data-flip-id="group:current">
                  Сейчас играет
                </li>
              )}
              {next && orderPos === pos + 1 && (
                <li className={s.groupLabel} data-flip-id="group:next">
                  Далее
                </li>
              )}
              <li
                className={s.row}
                tabIndex={0}
                title={part === 'current' ? 'Перетащите, чтобы переместить в очереди' : 'Играть или перетащить'}
                data-flip-id={rowKey}
                data-queue-idx={orderPos}
                data-can-drag={canDrag || undefined}
                data-played={part === 'played' || undefined}
                data-current={part === 'current' || undefined}
                data-dragging={isDragging || undefined}
                data-settling={(isDragging && drag?.settling) || undefined}
                onPointerDown={(e) => beginPointerDrag(e, orderPos)}
                onClick={() => {
                  if (suppressClickRef.current) return
                  if (part !== 'current') jumpTo(orderPos)
                }}
                onContextMenu={(e) => openTrackMenu(e, t, { inNowPlaying: true, queuePos: orderPos })}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === 'ArrowUp' && orderPos > 0) {
                    e.preventDefault()
                    moveInQueue(orderPos, orderPos - 1)
                  } else if (e.altKey && e.key === 'ArrowDown' && orderPos < rows.length - 1) {
                    e.preventDefault()
                    moveInQueue(orderPos, orderPos + 1)
                  } else if (e.key === 'Enter' && part !== 'current') {
                    jumpTo(orderPos)
                  }
                }}
              >
                <Artwork src={t.cover?.s} size={40} radius={6} seed={t.key} />
                <div className={s.rowText}>
                  <div className={`${s.rowTitle} truncate`}>
                    <ServiceLogo id={serviceOf(t)} size={13} className={s.rowMark} />
                    {t.title}
                  </div>
                  <div className={`${s.rowArtist} truncate`}>{t.artist}</div>
                </div>
                <div className={s.rowEnd}>
                  {part === 'current' ? (
                    <EqualizerBars playing={isPlaying} height={14} />
                  ) : (
                    <>
                      <span className={s.duration}>{formatTime(t.duration)}</span>
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
                    </>
                  )}
                </div>
              </li>
            </Fragment>
          )
        })}
        {upcomingCount === 0 && (
          <li className={s.endNote} data-flip-id="group:end">
            {source?.kind === 'mix' ? `${source.label || 'VK Микс'} подбирает следующие треки…` : 'Дальше в очереди ничего нет'}
          </li>
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
