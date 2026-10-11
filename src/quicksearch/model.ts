import type { QuickTrack } from '../lib/events'

export type Row = { kind: 'header'; id: string; label: string } | { kind: 'track'; id: string; track: QuickTrack }

/** «В моей музыке» first, then the rest of VK; a section shows only when it found something. */
export function buildRows(own: QuickTrack[], others: QuickTrack[]): Row[] {
  const rows: Row[] = []
  const section = (id: string, label: string, list: QuickTrack[]) => {
    if (list.length === 0) return
    rows.push({ kind: 'header', id, label })
    for (const track of list) rows.push({ kind: 'track', id: `${id}:${track.key}`, track })
  }
  section('own', 'В моей музыке', own)
  section('vk', 'VK Музыка', others)
  return rows
}

const selectable = (r: Row | undefined) => r?.kind === 'track' && r.track.playable

/** The next track row in `dir` from `from`; stays put at the ends. */
export function step(rows: Row[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (selectable(rows[i])) return i
  return selectable(rows[from]) ? from : firstTrack(rows)
}

export function firstTrack(rows: Row[]): number {
  return rows.findIndex(selectable)
}

export function indexOfKey(rows: Row[], key: string | null): number {
  if (!key) return -1
  return rows.findIndex((r) => r.kind === 'track' && r.track.key === key && r.track.playable)
}

export type Intent = 'up' | 'down' | 'play' | 'next' | 'close'

export function keyIntent(e: { key: string; shiftKey: boolean }): Intent | null {
  switch (e.key) {
    case 'ArrowDown':
      return 'down'
    case 'ArrowUp':
      return 'up'
    case 'Tab':
      return e.shiftKey ? 'up' : 'down'
    case 'Enter':
      return e.shiftKey ? 'next' : 'play'
    case 'Escape':
      return 'close'
    default:
      return null
  }
}
