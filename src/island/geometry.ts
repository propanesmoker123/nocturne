export type IslandShape = 'compact' | 'volume' | 'peek' | 'expanded'

/** Fixed size of the transparent island window (logical px); must match island.rs. */
export const WINDOW = { w: 480, h: 260 }
export const TOP = 8
const MARGIN = 4

export const SHAPES: Record<IslandShape, { w: number; h: number; r: number }> = {
  compact: { w: 200, h: 36, r: 18 },
  /** Volume HUD: the compact pill, a little wider, for a moment after the volume changes. */
  volume: { w: 236, h: 36, r: 18 },
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

/** How long the volume HUD stays after the last change (ms). */
export const VOLUME_HUD_MS = 1500

/** The volume or mute changed between two snapshots (the very first one is not a change). */
export function volumeChanged(prev: { volume: number; muted: boolean } | null, next: { volume: number; muted: boolean }): boolean {
  return prev !== null && (Math.abs(prev.volume - next.volume) > 0.001 || prev.muted !== next.muted)
}

/** What the island shows: an open player wins, then news (track change, like), then the volume. */
export function pickShape(s: { hasTrack: boolean; expanded: boolean; peek: boolean; volume: boolean }): IslandShape {
  if (!s.hasTrack) return 'compact'
  if (s.expanded) return 'expanded'
  if (s.peek) return 'peek'
  return s.volume ? 'volume' : 'compact'
}

/** How long the expanded island lingers after the cursor leaves it (ms). */
export const COLLAPSE_DELAY = 100
