/** Wheel deltas big enough to count as one deliberate step (a mouse notch is ~100). */
export const WHEEL_STEP = 40

/**
 * Vertical wheel movement in pixels, or 0 when the gesture is already horizontal (trackpad
 * swipe, Shift+wheel) — the browser scrolls those sideways on its own.
 */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pageWidth: number): number {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0
  if (e.deltaMode === 1) return e.deltaY * 40
  if (e.deltaMode === 2) return e.deltaY * pageWidth
  return e.deltaY
}

/** Adds the delta to what has gathered; a full step yields a direction and starts over. */
export function wheelStep(acc: number, delta: number): { dir: 1 | -1 | 0; acc: number } {
  const next = Math.sign(acc) === Math.sign(delta) ? acc + delta : delta
  if (Math.abs(next) >= WHEEL_STEP) return { dir: next > 0 ? 1 : -1, acc: 0 }
  return { dir: 0, acc: next }
}

/** The next column edge in that direction, clamped to the scrollable range. */
export function columnTarget(from: number, dir: 1 | -1, step: number, max: number): number {
  if (step <= 0) return dir > 0 ? max : 0
  const at = from / step
  const index = dir > 0 ? Math.floor(at + 0.01) + 1 : Math.ceil(at - 0.01) - 1
  return Math.min(max, Math.max(0, index * step))
}
