import { create } from 'zustand'
import { onUnlink, useDevices } from '../connect/devices'
import { debouncedSaver, loadJSON } from '../lib/persist'
import { generateCode } from '../together/code'
import type { Track } from '../vk/models'
import { addTracks, deleteAlbum, liveEntries, MAX_TRACKS, mergeAlbum, moveEntry, newAlbum, removeEntry, renameAlbum, sameDoc, setAlbumCover, type AlbumDoc } from './model'
import { mergeList, type ListEntry } from './records'

/**
 * Albums as this device keeps them: the documents (the main copy — relays only carry copies)
 * and the list of albums with their access codes. Every change is saved here and announced to
 * the sync, which publishes it.
 */

interface Saved {
  docs: Record<string, AlbumDoc>
  list: ListEntry[]
}

interface AlbumsState extends Saved {
  ready: boolean
  create(name: string): string
  rename(id: string, name: string): void
  /** The album's own picture (a `data:` address); null takes it off. */
  setCover(id: string, image: string | null): void
  add(id: string, tracks: Track[], at?: number): { added: number; skipped: 'full' | null }
  removeEntry(id: string, eid: string): void
  move(id: string, eid: string, toIndex: number): void
  /** Deletes the album for everyone who has it. */
  deleteForAll(id: string): void
  /** «Удалить у себя»: forgets it here (and on the person's other devices), others keep it. */
  leave(id: string): void
  /** An album someone shared, as read while asking whether to add it. */
  join(code: string, doc: AlbumDoc): string
  markShared(id: string): void
  /** A new access code: whoever had the old one is cut off. */
  rotate(id: string): string
  rotateAll(): void
  /** Forgets every album on this device (it leaves the person's devices). */
  wipe(): void
  /** A copy from elsewhere merged in: true when it changed something. */
  applyRemote(id: string, doc: AlbumDoc): boolean
  applyList(entries: ListEntry[]): boolean
}

const saver = debouncedSaver('albums', 800)
const listeners = new Set<(ids: string[]) => void>()

/** The sync hears about every change (to publish it); returns the way to stop listening. */
export function onAlbumsChanged(fn: (ids: string[]) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const me = () => useDevices.getState().deviceId || '0000000000000000'

/** Limits on what copies from elsewhere may make of an album: a little over the tracks one may add, removal markers of a long life. */
const LIVE_SLACK = 200
const MAX_ENTRIES = 12_000
const tooBig = (next: AlbumDoc, prev?: AlbumDoc) => {
  const n = Object.keys(next.entries).length
  const live = liveEntries(next).length
  return (n > MAX_ENTRIES && n > (prev ? Object.keys(prev.entries).length : 0)) || (live > MAX_TRACKS + LIVE_SLACK && live > (prev ? liveEntries(prev).length : 0))
}

/** What a code for album `id` means here: a new album, one already here by this code, or one here by another code. */
export function joinKind(id: string, code: string): 'new' | 'have' | 'recode' {
  const e = useAlbums.getState().list.find((x) => x.id === id && !x.removedAt)
  return !e ? 'new' : e.code === code ? 'have' : 'recode'
}

export const useAlbums = create<AlbumsState>((set, get) => {
  const changed = (ids: string[]) => {
    const { docs, list } = get()
    saver.save({ docs, list })
    for (const fn of listeners) fn(ids)
  }
  const setDoc = (id: string, doc: AlbumDoc) => set({ docs: { ...get().docs, [id]: doc } })
  // each field of the list carries its own time (see ListEntry): callers set it with the field
  const setEntry = (id: string, patch: Partial<ListEntry>) => set({ list: get().list.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
  const codeAt = (id: string) => Math.max(Date.now(), (get().list.find((e) => e.id === id)?.codeAt ?? 0) + 1)
  const edit = (id: string, fn: (d: AlbumDoc, now: number, by: string) => AlbumDoc) => {
    const d = get().docs[id]
    if (!d) return
    setDoc(id, fn(d, Date.now(), me()))
    changed([id])
  }

  return {
    ready: false,
    docs: {},
    list: [],
    create(name) {
      const now = Date.now()
      const doc = newAlbum(name, now, me())
      set({ docs: { ...get().docs, [doc.id]: doc }, list: [...get().list, { id: doc.id, code: generateCode(), codeAt: now, name, shared: false, updatedAt: now, by: me() }] })
      changed([doc.id])
      return doc.id
    },
    rename(id, name) {
      const d = get().docs[id]
      if (!d) return
      setDoc(id, renameAlbum(d, name, Date.now(), me()))
      setEntry(id, { name, updatedAt: Date.now(), by: me() })
      changed([id])
    },
    add(id, tracks, at) {
      const d = get().docs[id]
      if (!d) return { added: 0, skipped: null }
      const r = addTracks(d, tracks, Date.now(), me(), at)
      if (r.added) {
        setDoc(id, r.doc)
        changed([id])
      }
      return { added: r.added, skipped: r.skipped }
    },
    setCover: (id, image) => edit(id, (d, now, by) => setAlbumCover(d, image ?? undefined, now, by)),
    removeEntry: (id, eid) => edit(id, (d, now, by) => removeEntry(d, eid, now, by)),
    move: (id, eid, toIndex) => edit(id, (d, now, by) => moveEntry(d, eid, toIndex, now, by)),
    deleteForAll(id) {
      const d = get().docs[id]
      if (d) setDoc(id, deleteAlbum(d, Date.now(), me()))
      setEntry(id, { removedAt: Date.now() })
      changed([id])
    },
    leave(id) {
      const docs = { ...get().docs }
      delete docs[id]
      set({ docs })
      setEntry(id, { removedAt: Date.now() })
      changed([id])
    },
    join(code, doc) {
      const now = Date.now()
      const existing = get().list.find((e) => e.id === doc.id)
      // a new code for an album already here moves it to that code; one left before comes back
      const entry: ListEntry = { id: doc.id, code, codeAt: codeAt(doc.id), name: doc.meta.name, shared: true, updatedAt: now, by: me(), joinedAt: Math.max(now, (existing?.removedAt ?? 0) + 1) }
      set({
        docs: { ...get().docs, [doc.id]: get().docs[doc.id] ? mergeAlbum(get().docs[doc.id], doc) : doc },
        list: existing ? get().list.map((e) => (e.id === doc.id ? entry : e)) : [...get().list, entry],
      })
      changed([doc.id])
      return doc.id
    },
    markShared(id) {
      if (get().list.find((e) => e.id === id)?.shared) return
      setEntry(id, { shared: true })
      changed([id])
    },
    rotate(id) {
      const code = generateCode()
      setEntry(id, { code, codeAt: codeAt(id) })
      changed([id])
      return code
    },
    rotateAll() {
      const live = get().list.filter((e) => !e.removedAt)
      for (const e of live) setEntry(e.id, { code: generateCode(), codeAt: codeAt(e.id) })
      if (live.length) changed(live.map((e) => e.id))
    },
    wipe() {
      set({ docs: {}, list: [] })
      // the sync hears it too: it stops reading these albums and forgets what it published
      changed([])
    },
    applyRemote(id, doc) {
      // only albums in the list: not one left, nor one of a device that left (a deletion still comes through)
      const e = get().list.find((x) => x.id === id)
      if (!e || (e.removedAt && !doc.meta.deletedAt)) return false
      const local = get().docs[id]
      const merged = local ? mergeAlbum(local, doc) : doc
      if (local && sameDoc(merged, local)) return false
      if (tooBig(merged, local)) return false
      setDoc(id, merged)
      // the list's label follows a rename made elsewhere (the document's name is the one shown)
      if (merged.meta.name && get().list.some((e) => e.id === id && e.name !== merged.meta.name)) {
        set({ list: get().list.map((e) => (e.id === id ? { ...e, name: merged.meta.name } : e)) })
      }
      changed([id])
      return true
    },
    applyList(entries) {
      const merged = mergeList(get().list, entries)
      const before = JSON.stringify(get().list)
      if (JSON.stringify(merged) === before) return false
      const removed = new Set(merged.filter((e) => e.removedAt).map((e) => e.id))
      const docs = Object.fromEntries(Object.entries(get().docs).filter(([id, d]) => !removed.has(id) || d.meta.deletedAt))
      set({ list: merged, docs })
      changed(merged.map((e) => e.id))
      return true
    },
  }
})

// A lost or given-away device must not keep the albums: unlinking all devices changes every
// album's code, and a device that leaves forgets its albums
onUnlink((kind) => (kind === 'all' ? useAlbums.getState().rotateAll() : useAlbums.getState().wipe()))

/**
 * Reads what the last run kept (call once, at start). Anything made before it came is merged
 * with it, never dropped, and the two are saved together.
 */
export async function loadAlbums(): Promise<void> {
  const saved = await loadJSON<Saved>('albums')
  // a list from before codes had their own time
  const list = (saved?.list ?? []).map((e) => ({ ...e, codeAt: e.codeAt ?? e.updatedAt }))
  const docs = { ...(saved?.docs ?? {}) }
  const made = useAlbums.getState()
  for (const [id, d] of Object.entries(made.docs)) docs[id] = docs[id] ? mergeAlbum(docs[id], d) : d
  useAlbums.setState({ ready: true, docs, list: mergeList(list, made.list) })
  if (made.list.length) saver.save({ docs, list: useAlbums.getState().list })
}
