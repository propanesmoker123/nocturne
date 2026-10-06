export type IslandShape = 'compact' | 'peek' | 'expanded'

/** Fixed size of the transparent island window (logical px); must match island.rs. */
export const WINDOW = { w: 480, h: 260 }
export const TOP = 8
const MARGIN = 4

export const SHAPES: Record<IslandShape, { w: number; h: number; r: number }> = {
  compact: { w: 200, h: 36, r: 18 },
  peek: { w: 360, h: 64, r: 28 },
  expanded: { w: 420, h: 212, r: 36 },
}

/** The rectangle Rust hit-tests against, in window coordinates. */
export function hitRect(shape: IslandShape) {
  const s = SHAPES[shape]
  return { x: (WINDOW.w - s.w) / 2 - MARGIN, y: TOP - MARGIN, w: s.w + MARGIN * 2, h: s.h + MARGIN * 2 }
}

/** Whether the shape takes clicks; otherwise clicks fall through to the windows below. */
export function isInteractive(shape: IslandShape, expandOn: 'hover' | 'click'): boolean {
  return shape === 'expanded' || expandOn === 'click'
}
