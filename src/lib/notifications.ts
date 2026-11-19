import { create } from 'zustand'
import { journal } from './journal'
import { loadJSON, saveJSON } from './persist'
import { invoke, isTauri } from './tauri'
import { useUpdates } from './updates'
import { useSheet } from '../app/sheetStore'
import { toast } from '../app/toast'

export interface RelayReply {
  id: string
  reportId: string
  reportMessage: string
  kind: string
  message: string
  createdAt: number
}

export interface RelayAnnouncement {
  id: string
  title: string
  message: string
  createdAt: number
}

export interface ReleaseNote {
  version: string
  title: string
  notes: string
  publishedAt: string
  url: string
}

export interface SubmittedReport {
  id: string
  kind: string
  preview: string
  createdAt: number
}

export interface NotificationsPayload {
  currentVersion: string
  inboxOk: boolean
  releasesOk: boolean
  replies: RelayReply[]
  announcements: RelayAnnouncement[]
  releases: ReleaseNote[]
  sentReports: SubmittedReport[]
}

export type NotificationItem =
  | {
      kind: 'reply'
      itemId: string
      sortAt: number
      reply: RelayReply
    }
  | {
      kind: 'announcement'
      itemId: string
      sortAt: number
      announcement: RelayAnnouncement
    }
  | {
      kind: 'release'
      itemId: string
      sortAt: number
      release: ReleaseNote
      isAvailable: boolean
      isCurrent: boolean
    }

interface PersistedReadState {
  seeded?: boolean
  seenIds?: string[]
}

const READ_STORE_NAME = 'notifications-read'
const POLL_EVERY_MS = 5 * 60_000
const MIN_FOCUS_GAP_MS = 60_000
const MAX_SEEN_IDS = 200

export function compareSemver(a: string, b: string): number {
  const pa = a.trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length, 3)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da > db ? 1 : -1
  }
  return 0
}

export function buildFeedItems(
  payload: Pick<NotificationsPayload, 'currentVersion' | 'replies' | 'announcements' | 'releases'>,
  updateState?: { phase: string; version?: string; notes?: string },
): NotificationItem[] {
  const out: NotificationItem[] = []

  for (const reply of payload.replies) {
    out.push({
      kind: 'reply',
      itemId: `reply:${reply.id}`,
      sortAt: reply.createdAt || 0,
      reply,
    })
  }

  for (const announcement of payload.announcements) {
    out.push({
      kind: 'announcement',
      itemId: `ann:${announcement.id}`,
      sortAt: announcement.createdAt || 0,
      announcement,
    })
  }

  const availVer = updateState?.phase === 'available' ? updateState.version : undefined
  const releases = [...payload.releases]
  if (availVer && !releases.some((r) => compareSemver(r.version, availVer) === 0)) {
    releases.unshift({
      version: availVer,
      title: `Nocturne ${availVer}`,
      notes: updateState?.notes?.trim() ?? '',
      publishedAt: new Date().toISOString(),
      url: '',
    })
  }

  for (const release of releases) {
    const parsedTime = release.publishedAt ? Date.parse(release.publishedAt) : 0
    const isCurrent = compareSemver(release.version, payload.currentVersion) === 0
    const isAvailable =
      (Boolean(availVer) && compareSemver(release.version, availVer!) === 0) ||
      compareSemver(release.version, payload.currentVersion) > 0
    out.push({
      kind: 'release',
      itemId: `rel:${release.version}`,
      sortAt: Number.isFinite(parsedTime) ? parsedTime : 0,
      release,
      isAvailable,
      isCurrent,
    })
  }

  // Monotonic per-item score ensures strict weak ordering while floating recent replies and available updates to the top.
  const BOOST_MS = 7 * 86_400_000
  const score = (x: NotificationItem) => {
    if (x.kind === 'reply') return x.sortAt + BOOST_MS * 2
    if (x.kind === 'release' && x.isAvailable) return x.sortAt + BOOST_MS
    return x.sortAt
  }
  return out.sort((a, b) => score(b) - score(a) || b.sortAt - a.sortAt || a.itemId.localeCompare(b.itemId))
}

export function seedInitialSeenIds(currentVersion: string, items: NotificationItem[], existingSeen: string[]): string[] {
  const seen = new Set(existingSeen)
  for (const item of items) {
    if (item.kind === 'release' && compareSemver(item.release.version, currentVersion) < 0) {
      seen.add(item.itemId)
    }
  }
  return [...seen].slice(-MAX_SEEN_IDS)
}

export function unreadNotificationCount(items: NotificationItem[], seenIds: string[]): number {
  if (!items.length) return 0
  const seen = new Set(seenIds)
  let count = 0
  for (const item of items) {
    if (!seen.has(item.itemId)) count += 1
  }
  return count
}

export interface NotificationsStore {
  currentVersion: string
  items: NotificationItem[]
  sentReports: SubmittedReport[]
  seenIds: string[]
  highlightedIds: string[]
  seeded: boolean
  hydrated: boolean
  loading: boolean
  error: string
  inboxOk: boolean
  releasesOk: boolean
  lastCheckedAt: number | null
  hydrate(): Promise<void>
  refresh(silent?: boolean): Promise<void>
  markAllRead(): Promise<void>
  markSeen(itemId: string): Promise<void>
  openSheet(): void
}

async function persistRead(seenIds: string[], seeded = true): Promise<void> {
  await saveJSON(READ_STORE_NAME, {
    seeded,
    seenIds: seenIds.slice(-MAX_SEEN_IDS),
  } satisfies PersistedReadState)
}

let inflightRefresh: Promise<void> | null = null

export const useNotifications = create<NotificationsStore>((set, get) => ({
  currentVersion: '',
  items: [],
  sentReports: [],
  seenIds: [],
  highlightedIds: [],
  seeded: false,
  hydrated: false,
  loading: false,
  error: '',
  inboxOk: false,
  releasesOk: false,
  lastCheckedAt: null,

  async hydrate() {
    if (get().hydrated) return
    const saved = await loadJSON<PersistedReadState>(READ_STORE_NAME)
    set({
      seenIds: Array.isArray(saved?.seenIds) ? saved.seenIds.filter((s) => typeof s === 'string') : [],
      seeded: saved?.seeded === true,
      hydrated: true,
    })
  },

  async refresh(silent = false) {
    if (!isTauri()) return
    if (inflightRefresh) return inflightRefresh

    inflightRefresh = (async () => {
      await get().hydrate()
      if (!silent || !get().items.length) {
        set({ loading: true, error: '' })
      }
      try {
        const prevReplyIds = new Set(
          get()
            .items.filter((x): x is Extract<NotificationItem, { kind: 'reply' }> => x.kind === 'reply')
            .map((x) => x.itemId),
        )

        const payload = await invoke<NotificationsPayload>('fetch_notifications')
        const updater = useUpdates.getState()
        const items = buildFeedItems(payload, {
          phase: updater.phase,
          version: updater.version,
          notes: updater.notes,
        })

        let seenIds = get().seenIds
        let seeded = get().seeded
        if (!seeded) {
          seenIds = seedInitialSeenIds(payload.currentVersion, items, seenIds)
          seeded = true
          await persistRead(seenIds, true)
        }

        const sheetOpen = useSheet.getState().sheet?.kind === 'notifications'
        if (sheetOpen) {
          const merged = [...new Set([...seenIds, ...items.map((x) => x.itemId)])].slice(-MAX_SEEN_IDS)
          seenIds = merged
          await persistRead(seenIds, true)
        }

        const hadInitial = get().lastCheckedAt !== null
        const newlyArrivedReply =
          hadInitial &&
          !sheetOpen &&
          items.some(
            (x) => x.kind === 'reply' && !prevReplyIds.has(x.itemId) && !seenIds.includes(x.itemId),
          )

        set({
          currentVersion: payload.currentVersion,
          items,
          sentReports: payload.sentReports,
          seenIds,
          seeded,
          loading: false,
          inboxOk: payload.inboxOk,
          releasesOk: payload.releasesOk,
          lastCheckedAt: Date.now(),
          error: !payload.inboxOk && !payload.releasesOk && !items.length ? 'Не удалось загрузить уведомления' : '',
        })

        if (newlyArrivedReply) {
          toast('Ответ от разработчика в Nocturne', 'info', {
            label: 'Открыть',
            run: () => get().openSheet(),
          })
        }
      } catch (e) {
        journal('notifications', `refresh failed: ${String(e)}`)
        set({
          loading: false,
          error: get().items.length ? '' : 'Не удалось загрузить уведомления',
        })
      } finally {
        inflightRefresh = null
      }
    })()

    return inflightRefresh
  },

  async markAllRead() {
    if (!get().hydrated) await get().hydrate()
    const { items, seenIds } = get()
    const next = [...new Set([...seenIds, ...items.map((x) => x.itemId)])].slice(-MAX_SEEN_IDS)
    set({ seenIds: next, seeded: true })
    await persistRead(next, true)
  },

  async markSeen(itemId: string) {
    if (!get().hydrated) await get().hydrate()
    const cur = get().seenIds
    if (cur.includes(itemId) && get().seeded) return
    const next = [...new Set([...cur, itemId])].slice(-MAX_SEEN_IDS)
    set({ seenIds: next, seeded: true })
    await persistRead(next, true)
  },

  openSheet() {
    const { items, seenIds, lastCheckedAt } = get()
    const seen = new Set(seenIds)
    const unreadNow = items.filter((x) => !seen.has(x.itemId)).map((x) => x.itemId)
    set({ highlightedIds: unreadNow })
    useSheet.getState().open({ kind: 'notifications' })
    void get().markAllRead()
    if (lastCheckedAt === null || Date.now() - lastCheckedAt > 20_000) {
      void get().refresh(true)
    }
  },
}))

let checksStarted = false

export function startNotificationChecks() {
  if (!isTauri() || checksStarted) return
  checksStarted = true
  void useNotifications.getState().hydrate().then(() => useNotifications.getState().refresh(true))

  let lastAvailKey = ''
  useUpdates.subscribe((u) => {
    const key = u.phase === 'available' ? `${u.version ?? ''}:${u.notes ?? ''}` : ''
    if (!key || key === lastAvailKey) return
    lastAvailKey = key
    const st = useNotifications.getState()
    if (!st.currentVersion) {
      void st.refresh(true)
      return
    }
    const items = buildFeedItems(
      {
        currentVersion: st.currentVersion,
        replies: st.items.filter((x): x is Extract<NotificationItem, { kind: 'reply' }> => x.kind === 'reply').map((x) => x.reply),
        announcements: st.items
          .filter((x): x is Extract<NotificationItem, { kind: 'announcement' }> => x.kind === 'announcement')
          .map((x) => x.announcement),
        releases: st.items
          .filter((x): x is Extract<NotificationItem, { kind: 'release' }> => x.kind === 'release')
          .map((x) => x.release),
      },
      { phase: u.phase, version: u.version, notes: u.notes },
    )
    useNotifications.setState({ items })
  })

  const maybeRefresh = () => {
    const last = useNotifications.getState().lastCheckedAt
    if (last === null || Date.now() - last >= MIN_FOCUS_GAP_MS) {
      void useNotifications.getState().refresh(true)
    }
  }
  setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void useNotifications.getState().refresh(true)
  }, POLL_EVERY_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && maybeRefresh())
  window.addEventListener('focus', maybeRefresh)
}

export function formatNotificationDate(msOrIso: number | string): string {
  const ts = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso)
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return 'только что'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} ч назад`
  try {
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}
