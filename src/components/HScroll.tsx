import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useState } from 'react'
import { columnTarget, wheelPixels, wheelStep } from '../lib/hscroll'
import s from './cards.module.css'

/** One column: the first item's width plus the gap between items. */
function columnWidth(el: HTMLElement): number {
  const first = el.firstElementChild as HTMLElement | null
  if (!first) return el.clientWidth
  const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0
  return first.getBoundingClientRect().width + gap
}

export interface HorizontalScroll {
  edges: { start: boolean; end: boolean }
  /** Page left or right (arrow buttons). */
  page(dir: 1 | -1): void
  /** Re-measure after the content changed. */
  refresh(): void
}

/**
 * The mouse wheel over a horizontal strip moves it column by column; once the strip is at its
 * end, the wheel scrolls the page again, so nothing ever traps it.
 */
export function useHorizontalScroll(ref: RefObject<HTMLElement | null>): HorizontalScroll {
  const [edges, setEdges] = useState({ start: true, end: false })

  const refresh = useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    setEdges({ start: el.scrollLeft < 4, end: el.scrollLeft >= max - 4 })
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let acc = 0
    let target: number | null = null
    let settle: ReturnType<typeof setTimeout> | undefined
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return
      const px = wheelPixels(e, el.clientWidth)
      if (px === 0) return
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      const from = target ?? el.scrollLeft
      if (max <= 0 || (px > 0 && from >= max - 2) || (px < 0 && from <= 2)) {
        acc = 0
        return
      }
      e.preventDefault()
      const step = wheelStep(acc, px)
      acc = step.acc
      if (step.dir === 0) return
      target = columnTarget(from, step.dir, columnWidth(el), max)
      el.scrollTo({ left: target, behavior: 'smooth' })
      clearTimeout(settle)
      settle = setTimeout(() => (target = null), 450)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', refresh, { passive: true })
    const ro = new ResizeObserver(refresh)
    ro.observe(el)
    refresh()
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', refresh)
      ro.disconnect()
      clearTimeout(settle)
    }
  }, [ref, refresh])

  const page = useCallback(
    (dir: 1 | -1) => {
      const el = ref.current
      el?.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
    },
    [ref],
  )

  return { edges, page, refresh }
}

/** «Назад» / «Вперёд» over the strip's edges, shown on hover while there is somewhere to go. */
export function EdgeArrows({ scroll, middle }: { scroll: HorizontalScroll; middle?: boolean }) {
  const place = middle ? s.arrowMiddle : ''
  return (
    <>
      <button type="button" className={`${s.arrow} ${s.prev} ${place}`} aria-label="Назад" disabled={scroll.edges.start} onClick={() => scroll.page(-1)}>
        <ChevronLeft size={20} strokeWidth={2.4} />
      </button>
      <button type="button" className={`${s.arrow} ${s.next} ${place}`} aria-label="Вперёд" disabled={scroll.edges.end} onClick={() => scroll.page(1)}>
        <ChevronRight size={20} strokeWidth={2.4} />
      </button>
    </>
  )
}
