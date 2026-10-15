type Rect = { top: number; height: number }
type Box = { top: number; scrollTop: number; height: number }

/** Where a scroll box must scroll to bring `el` to its top (minus `margin`) or its middle. */
export function scrollTarget(el: Rect, box: Box, block: 'start' | 'center', margin: number): number {
  const offset = el.top - box.top + box.scrollTop
  const target = block === 'start' ? offset - margin : offset - (box.height - el.height) / 2
  return Math.max(0, Math.round(target))
}

const scrolls = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)

/** Like scrollIntoView, but moves only the nearest scrolling panel — never the page or a
 *  sheet that merely clips its content (that would shift the whole layout on a phone). */
export function scrollWithin(el: HTMLElement | null, block: 'start' | 'center', smooth: boolean) {
  if (!el) return
  let box = el.parentElement
  while (box && !scrolls(box)) box = box.parentElement
  if (!box) return
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  box.scrollTo({ top: scrollTarget(r, { top: b.top, scrollTop: box.scrollTop, height: box.clientHeight }, block, margin), behavior: smooth ? 'smooth' : 'auto' })
}
