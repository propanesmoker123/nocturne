import { schnorr } from '@noble/secp256k1'
import { useDevices } from '../connect/devices'
import { journal } from '../lib/journal'
import { loadDeviceKeys, openRelayStore, type RelayStore, type StoredRecord } from '../lib/relayStore'
import { BUCKETS, type AlbumDoc } from './model'
import { albumBase, albumKey, albumTags, applyRecord, listKey, listTag, openRecord, parseList, parseRecord, sealRecord, splitDoc } from './records'
import { loadAlbums, onAlbumsChanged, useAlbums } from './store'

/**
 * Albums over the relays. Each device keeps its own copy of every album it has as stored records
 * (one `meta` and 16 buckets per album, under the album code's tags), reads everyone's copies
 * and merges them; the list of a person's albums travels the same way in their devices' channel.
 * The relays only ever see tags and sealed bytes.
 */

/** The relays that kept stored records of 1 and 60 KB when checked (18.10.2026). */
export const ALBUM_RELAYS = ['wss://nos.lol', 'wss://cdn.satellite.earth', 'wss://nostr.chaima.info', 'wss://nostr.christiansass.de', 'wss://nostr.rblb.it', 'wss://nostr.stakey.net']
export const PUBLISH_DELAY_MS = 2000
export const REPUBLISH_MS = 12 * 3600_000
/** A sealed record bigger than this is not sent: readers would refuse it. */
const MAX_RECORD = 60 * 1024

type Route = { kind: 'album'; id: string; key: CryptoKey } | { kind: 'list'; key: CryptoKey }

interface Options {
  WebSocketImpl?: typeof WebSocket
  /** tests: a shorter pause before publishing */
  publishDelay?: number
}

let store: RelayStore | null = null
let opts: Options = {}
let routes = new Map<string, Route>()
let version = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** What this device last published under each tag: an unchanged record is not sent again. */
const published = new Map<string, string>()
let listTimer: ReturnType<typeof setTimeout> | undefined
let republish: ReturnType<typeof setInterval> | undefined
let offs: (() => void)[] = []

async function rebuild() {
  const mine = ++version
  const next = new Map<string, Route>()
  for (const e of useAlbums.getState().list) {
    if (e.removedAt) continue
    const key = await albumKey(e.code)
    for (const tag of albumTags(await albumBase(e.code))) next.set(tag, { kind: 'album', id: e.id, key })
  }
  const group = useDevices.getState().code
  if (group) next.set(await listTag(group), { kind: 'list', key: await listKey(group) })
  if (mine !== version || !store) return
  routes = next
  // an album no longer here (left, or the device left) is not published again
  for (const tag of published.keys()) if (!routes.has(tag)) published.delete(tag)
  store.watch([...routes.keys()])
}

async function onRecord(r: StoredRecord) {
  const route = routes.get(r.d)
  if (!route) return
  const data = await openRecord(route.key, r.content)
  // read while the device left (or the album went): not taken in after all
  if (!routes.has(r.d)) return
  if (route.kind === 'list') {
    const list = data === null ? null : parseList(data)
    if (!list) return journal('albums', 'ignored record')
    useAlbums.getState().applyList(list.albums)
    return
  }
  const rec = data === null ? null : parseRecord(data)
  if (!rec || rec.id !== route.id) return journal('albums', 'ignored record')
  useAlbums.getState().applyRemote(rec.id, applyRecord(null, rec))
}

async function publishAlbum(id: string) {
  const s = store
  const entry = useAlbums.getState().list.find((e) => e.id === id)
  const doc = useAlbums.getState().docs[id]
  if (!s || !entry || !doc) return
  const key = await albumKey(entry.code)
  const tags = albumTags(await albumBase(entry.code))
  const [metaTag, ...bucketTags] = tags.slice(0, 1 + BUCKETS)
  const { meta, buckets, cover } = splitDoc(doc)
  const out: [string, unknown][] = [[metaTag, meta], ...buckets.map((b, i): [string, unknown] => [bucketTags[i], b])]
  if (cover) out.push([tags[1 + BUCKETS], cover])
  let sent = 0
  for (const [tag, record] of out) {
    const text = JSON.stringify(record)
    if (published.get(tag) === text) continue
    const sealed = await sealRecord(key, record)
    if (sealed.length > MAX_RECORD) {
      journal('albums', 'record too big')
      continue
    }
    published.set(tag, text)
    await s.publish(tag, sealed)
    sent++
  }
  if (sent) journal('albums', `published ${sent}`)
}

async function publishList() {
  const s = store
  const group = useDevices.getState().code
  if (!s || !group) return
  const tag = await listTag(group)
  const record = { v: 1, albums: useAlbums.getState().list }
  const text = JSON.stringify(record)
  if (published.get(tag) === text) return
  const sealed = await sealRecord(await listKey(group), record)
  if (sealed.length > MAX_RECORD) return journal('albums', 'record too big')
  published.set(tag, text)
  await s.publish(tag, sealed)
}

function schedule(ids: string[]) {
  const delay = opts.publishDelay ?? PUBLISH_DELAY_MS
  for (const id of ids) {
    clearTimeout(timers.get(id))
    timers.set(id, setTimeout(() => void publishAlbum(id), delay))
  }
  clearTimeout(listTimer)
  listTimer = setTimeout(() => void publishList(), delay)
}

/** Everything this device has, published again: relays may forget, and a copy heals them. */
async function publishAll() {
  published.clear()
  for (const e of useAlbums.getState().list) if (!e.removedAt || useAlbums.getState().docs[e.id]?.meta.deletedAt) await publishAlbum(e.id)
  await publishList()
}

/** Starts the albums' sync (once): reads every copy, publishes this device's own. */
export async function startAlbumSync(o: Options = {}): Promise<void> {
  if (store) return
  opts = o
  // normally loaded at start already (main.tsx), so nothing made meanwhile is lost
  if (!useAlbums.getState().ready) await loadAlbums()
  const keys = await loadDeviceKeys()
  store = openRelayStore({ relays: ALBUM_RELAYS, WebSocketImpl: o.WebSocketImpl, keys, onRecord: (r) => void onRecord(r) })
  await rebuild()
  void publishAll()
  republish = setInterval(() => void publishAll(), REPUBLISH_MS)
  offs = [
    onAlbumsChanged((ids) => {
      schedule(ids)
      void rebuild()
    }),
    useDevices.subscribe((s, prev) => {
      if (s.code === prev.code) return
      void rebuild()
      clearTimeout(listTimer)
      listTimer = setTimeout(() => void publishList(), opts.publishDelay ?? PUBLISH_DELAY_MS)
    }),
  ]
}

export function stopAlbumSync() {
  for (const off of offs) off()
  offs = []
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  clearTimeout(listTimer)
  clearInterval(republish)
  published.clear()
  store?.close()
  store = null
  routes = new Map()
}

/**
 * Reads an album by its code (to show its name before adding it): everyone's copies that come
 * within `ms`, merged; null when no `meta` came.
 */
export async function readAlbum(code: string, ms = 10_000): Promise<AlbumDoc | null> {
  const key = await albumKey(code)
  const tags = albumTags(await albumBase(code))
  let doc: AlbumDoc | null = null
  let last = Date.now()
  const reader = openRelayStore({
    relays: ALBUM_RELAYS,
    WebSocketImpl: opts.WebSocketImpl,
    keys: schnorr.keygen(),
    onRecord: (r) =>
      void openRecord(key, r.content).then((data) => {
        const rec = data === null ? null : parseRecord(data)
        if (!rec || (doc && rec.id !== doc.id)) return
        doc = applyRecord(doc, rec)
        last = Date.now()
      }),
  })
  reader.watch(tags)
  const end = Date.now() + ms
  // done once the name came and nothing new has come for a moment
  while (Date.now() < end && !(doc && (doc as AlbumDoc).meta.updatedAt > 0 && Date.now() - last > 400)) await new Promise((r) => setTimeout(r, 50))
  reader.close()
  const found = doc as AlbumDoc | null
  return found && found.meta.updatedAt > 0 ? found : null
}
