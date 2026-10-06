import { isTauri } from './tauri'

type StoreLike = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; save(): Promise<void> }

const stores = new Map<string, Promise<StoreLike>>()

function store(name: string): Promise<StoreLike> {
  let s = stores.get(name)
  if (!s) {
    s = import('@tauri-apps/plugin-store').then((m) => m.load(`${name}.json`, { autoSave: false, defaults: {} }) as Promise<StoreLike>)
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

/** Debounced saver: coalesces bursts of writes into one. */
export function debouncedSaver(name: string, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: unknown
  return {
    save(data: unknown) {
      pending = data
      clearTimeout(timer)
      timer = setTimeout(() => void saveJSON(name, pending), ms)
    },
    flush() {
      clearTimeout(timer)
      if (pending !== undefined) void saveJSON(name, pending)
    },
  }
}
