import { isTauri } from './tauri'

type StoreLike = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; save(): Promise<void> }

const stores = new Map<string, Promise<StoreLike>>()

function store(name: string): Promise<StoreLike> {
  let s = stores.get(name)
  if (!s) {
    s = import('@tauri-apps/plugin-store')
      .then((m) => m.load(`${name}.json`, { autoSave: false, defaults: {} }) as Promise<StoreLike>)
      .catch((err) => {
        if (stores.get(name) === s) stores.delete(name)
        throw err
      })
    stores.set(name, s)
  }
  return s
}

/** Reads a JSON document persisted under `name` (Tauri store file, or localStorage in a browser). */
export async function loadJSON<T>(name: string): Promise<T | null> {
  try {
    if (isTauri()) return ((await (await store(name)).get<T>('data')) ?? null) as T | null
    const raw = localStorage.getItem(`nocturne:${name}`)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export async function saveJSON(name: string, data: unknown): Promise<void> {
  try {
    if (isTauri()) {
      const s = await store(name)
      await s.set('data', data)
      await s.save()
      return
    }
    localStorage.setItem(`nocturne:${name}`, JSON.stringify(data))
  } catch {
    // persistence is best effort; playback never depends on it
  }
}

const activeFlushers = new Set<() => void>()
let unloadRegistered = false

function ensureUnloadFlush() {
  if (unloadRegistered || typeof window === 'undefined') return
  unloadRegistered = true
  const flushAll = () => {
    for (const fn of activeFlushers) fn()
  }
  window.addEventListener('pagehide', flushAll)
  window.addEventListener('beforeunload', flushAll)
}

/** Debounced saver: coalesces bursts of writes into one, flushing on page unload. */
export function debouncedSaver(name: string, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: unknown
  let hasPending = false
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!hasPending) return
    const data = pending
    pending = undefined
    hasPending = false
    void saveJSON(name, data)
  }
  activeFlushers.add(flush)
  ensureUnloadFlush()
  return {
    save(data: unknown) {
      pending = data
      hasPending = true
      clearTimeout(timer)
      timer = setTimeout(flush, ms)
    },
    flush,
  }
}
