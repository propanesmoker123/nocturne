export type RepeatMode = 'off' | 'all' | 'one'

/**
 * Immutable play queue. `items` holds the tracks, `order` maps play positions to item
 * indices (natural or shuffled), `pos` is the current play position inside `order`.
 */
export interface QueueState<T> {
  items: T[]
  order: number[]
  pos: number
  shuffle: boolean
  repeat: RepeatMode
}

function shuffled(indices: number[], rnd: () => number): number[] {
  const a = [...indices]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Puts `first` at position 0 and shuffles the rest. */
function shuffledAround(count: number, first: number, rnd: () => number): number[] {
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => i !== first)
  return [first, ...shuffled(rest, rnd)]
}

export function createQueue<T>(items: T[], startIndex: number, shuffle: boolean, repeat: RepeatMode, rnd: () => number = Math.random): QueueState<T> {
  const start = items.length ? Math.min(Math.max(startIndex, 0), items.length - 1) : 0
  if (shuffle && items.length) {
    return { items, order: shuffledAround(items.length, start, rnd), pos: 0, shuffle, repeat }
  }
  return { items, order: items.map((_, i) => i), pos: start, shuffle, repeat }
}

export function current<T>(q: QueueState<T>): T | null {
  const idx = q.order[q.pos]
  return idx === undefined ? null : q.items[idx]
}

/** Walks `step` positions at a time looking for a playable track; wraps only when `wrap` is set. */
function seek<T>(q: QueueState<T>, step: 1 | -1, wrap: boolean, isPlayable: (t: T) => boolean): QueueState<T> | null {
  const n = q.order.length
  for (let i = 1; i <= n; i++) {
    let p = q.pos + step * i
    if (p < 0 || p >= n) {
      if (!wrap) return null
      p = ((p % n) + n) % n
    }
    if (isPlayable(q.items[q.order[p]])) return { ...q, pos: p }
  }
  return null
}

export function next<T>(q: QueueState<T>, isPlayable: (t: T) => boolean, manual: boolean): QueueState<T> | null {
  if (q.order.length === 0) return null
  const cur = current(q)
  if (q.repeat === 'one' && !manual && cur !== null && isPlayable(cur)) return q
  return seek(q, 1, q.repeat !== 'off', isPlayable)
}

export function prev<T>(q: QueueState<T>, isPlayable: (t: T) => boolean): QueueState<T> | null {
  if (q.order.length === 0) return null
  return seek(q, -1, q.repeat === 'all', isPlayable)
}

export function setShuffle<T>(q: QueueState<T>, on: boolean, rnd: () => number = Math.random): QueueState<T> {
  const curIdx = q.order[q.pos]
  if (curIdx === undefined) return { ...q, shuffle: on }
  if (on) return { ...q, order: shuffledAround(q.items.length, curIdx, rnd), pos: 0, shuffle: true }
  const order = q.items.map((_, i) => i)
  return { ...q, order, pos: curIdx, shuffle: false }
}

export function insertNext<T>(q: QueueState<T>, items: T[]): QueueState<T> {
  const base = q.items.length
  const added = items.map((_, i) => base + i)
  const at = q.order.length ? q.pos + 1 : 0
  const order = [...q.order.slice(0, at), ...added, ...q.order.slice(at)]
  return { ...q, items: [...q.items, ...items], order }
}

export function append<T>(q: QueueState<T>, items: T[]): QueueState<T> {
  const base = q.items.length
  return { ...q, items: [...q.items, ...items], order: [...q.order, ...items.map((_, i) => base + i)] }
}

export function removeAt<T>(q: QueueState<T>, orderPos: number): QueueState<T> {
  if (orderPos < 0 || orderPos >= q.order.length) return q
  const order = q.order.filter((_, i) => i !== orderPos)
  let pos = q.pos
  if (orderPos < q.pos) pos -= 1
  pos = Math.min(pos, Math.max(order.length - 1, 0))
  return { ...q, order, pos }
}

export function move<T>(q: QueueState<T>, from: number, to: number): QueueState<T> {
  const n = q.order.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return q
  const curIdx = q.order[q.pos]
  const order = [...q.order]
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  return { ...q, order, pos: order.indexOf(curIdx) }
}

export function upcoming<T>(q: QueueState<T>): T[] {
  return q.order.slice(q.pos + 1).map((i) => q.items[i])
}
