type Rect = { top: number; height: number }
type Box = { top: number; scrollTop: number; height: number }

/** Where a scroll box must scroll to bring `el` to its top (minus `margin`) or its middle. */
export function scrollTarget(el: Rect, box: Box, block: 'start' | 'center', margin: number): number {
  const offset = el.top - box.top + box.scrollTop
  const target = block === 'start' ? offset - margin : offset - (box.height - el.height) / 2
  return Math.max(0, Math.round(target))
}

const scrolls = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)

interface ActiveScroll {
  raf: number
  target: number
  current: number
  lastWall: number
  cleanupListeners?: () => void
}

const activeScrolls = new WeakMap<Element, ActiveScroll>()

function cancelBoxScroll(box: Element) {
  const st = activeScrolls.get(box)
  if (!st) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(st.raf)
  st.cleanupListeners?.()
  activeScrolls.delete(box)
}

function animateScrollTo(box: Element, target: number) {
  const existing = activeScrolls.get(box)
  if (existing) {
    existing.target = target
    return
  }

  const maxTop = Math.max(0, box.scrollHeight - box.clientHeight)
  const clampedTarget = Math.min(maxTop, Math.max(0, target))
  const startTop = box.scrollTop
  if (Math.abs(clampedTarget - startTop) < 1) {
    box.scrollTop = clampedTarget
    return
  }

  const state: ActiveScroll = {
    raf: 0,
    target: clampedTarget,
    current: startTop,
    lastWall: performance.now(),
  }

  const onUserInput = () => cancelBoxScroll(box)
  box.addEventListener('wheel', onUserInput, { passive: true })
  box.addEventListener('touchstart', onUserInput, { passive: true })
  box.addEventListener('pointerdown', onUserInput, { passive: true })
  state.cleanupListeners = () => {
    box.removeEventListener('wheel', onUserInput)
    box.removeEventListener('touchstart', onUserInput)
    box.removeEventListener('pointerdown', onUserInput)
  }

  const step = (now: number) => {
    const dtMs = Math.max(1, Math.min(48, now - state.lastWall))
    state.lastWall = now
    const maxNow = Math.max(0, box.scrollHeight - box.clientHeight)
    const goal = Math.min(maxNow, Math.max(0, state.target))
    const diff = goal - state.current
    if (Math.abs(diff) <= 0.6) {
      box.scrollTop = Math.round(goal)
      cancelBoxScroll(box)
      return
    }
    const factor = 1 - Math.exp(-dtMs / 108)
    state.current += diff * factor
    box.scrollTop = state.current
    state.raf = requestAnimationFrame(step)
  }

  activeScrolls.set(box, state)
  state.raf = requestAnimationFrame(step)
}

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
  const target = scrollTarget(r, { top: b.top, scrollTop: box.scrollTop, height: box.clientHeight }, block, margin)

  if (!smooth || typeof requestAnimationFrame !== 'function') {
    cancelBoxScroll(box)
    box.scrollTo({ top: target, behavior: 'auto' })
    return
  }
  animateScrollTo(box, target)
}
