import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  storeData: new Map<string, unknown>(),
  invokeImpl: vi.fn(),
  toastCalls: [] as Array<{ text: string; icon?: string; action?: unknown }>,
  sheetOpenCalls: [] as unknown[],
  sheetKind: null as string | null,
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => h.invokeImpl(...args),
}))

vi.mock('./persist', () => ({
  loadJSON: async (name: string) => (h.storeData.get(name) ?? null),
  saveJSON: async (name: string, data: unknown) => {
    h.storeData.set(name, data)
  },
}))

vi.mock('../app/toast', () => ({
  toast: (text: string, icon?: string, action?: unknown) => {
    h.toastCalls.push({ text, icon, action })
  },
}))

vi.mock('../app/sheetStore', () => ({
  useSheet: {
    getState: () => ({
      sheet: h.sheetKind ? { kind: h.sheetKind } : null,
      open: (req: { kind: string }) => {
        h.sheetKind = req.kind
        h.sheetOpenCalls.push(req)
      },
    }),
  },
}))

import {
  buildFeedItems,
  compareSemver,
  seedInitialSeenIds,
  unreadNotificationCount,
  useNotifications,
} from './notifications'

describe('notifications store and feed helpers', () => {
  beforeEach(() => {
    h.storeData.clear()
    h.invokeImpl.mockReset()
    h.toastCalls.length = 0
    h.sheetOpenCalls.length = 0
    h.sheetKind = null
    useNotifications.setState({
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
    })
  })

  it('compares semantic versions properly', () => {
    expect(compareSemver('0.3.7', '0.3.6')).toBe(1)
    expect(compareSemver('v0.3.7', '0.3.7')).toBe(0)
    expect(compareSemver('0.3.5', '0.3.10')).toBe(-1)
  })

  it('seeds older releases as read on first run while keeping replies, announcements, and current/newer updates unread', () => {
    const items = buildFeedItems(
      {
        currentVersion: '0.3.7',
        replies: [
          { id: 'r1', reportId: 'rep1', reportMessage: 'Баг в Spotify', kind: 'bug', message: 'Починили!', createdAt: 2000 },
        ],
        announcements: [
          { id: 'a1', title: 'Сервис', message: 'Включили фикс', createdAt: 1900 },
        ],
        releases: [
          { version: '0.3.8', title: 'Nocturne 0.3.8', notes: 'Новое', publishedAt: '2026-11-18T10:00:00Z', url: '' },
          { version: '0.3.7', title: 'Nocturne 0.3.7', notes: 'Фикс', publishedAt: '2026-11-17T10:00:00Z', url: '' },
          { version: '0.3.6', title: 'Nocturne 0.3.6', notes: 'Старое', publishedAt: '2026-11-16T10:00:00Z', url: '' },
        ],
      },
      { phase: 'available', version: '0.3.8', notes: 'Новое' },
    )

    const seen = seedInitialSeenIds('0.3.7', items, [])
    expect(seen).toEqual(['rel:0.3.6'])
    expect(unreadNotificationCount(items, seen)).toBe(4) // r1, a1, 0.3.8, 0.3.7
  })

  it('transitions bell unread -> read on openSheet while keeping highlightedIds, then flags new replies unread again', async () => {
    const now = Date.now()
    h.invokeImpl.mockResolvedValueOnce({
      currentVersion: '0.3.7',
      inboxOk: true,
      releasesOk: true,
      replies: [
        { id: 'rep_1', reportId: 'r_1', reportMessage: 'Текст отстаёт', kind: 'bug', message: 'Починили таймер Spotify!', createdAt: now - 5000 },
      ],
      announcements: [],
      releases: [
        { version: '0.3.7', title: 'Nocturne 0.3.7', notes: 'Исправлено', publishedAt: new Date(now - 60_000).toISOString(), url: '' },
      ],
      sentReports: [{ id: 'r_1', kind: 'bug', preview: 'Текст отстаёт', createdAt: now - 10_000 }],
    })

    await useNotifications.getState().refresh(true)
    const beforeOpen = useNotifications.getState()
    expect(unreadNotificationCount(beforeOpen.items, beforeOpen.seenIds)).toBe(2)

    beforeOpen.openSheet()
    const afterOpen = useNotifications.getState()
    expect(h.sheetOpenCalls).toEqual([{ kind: 'notifications' }])
    // Bell turns read right away while open modal still highlights which items were unread
    expect(unreadNotificationCount(afterOpen.items, afterOpen.seenIds)).toBe(0)
    expect(afterOpen.highlightedIds).toEqual(['reply:rep_1', 'rel:0.3.7'])

    // User closes sheet and later a second reply arrives
    h.sheetKind = null
    h.invokeImpl.mockResolvedValueOnce({
      currentVersion: '0.3.7',
      inboxOk: true,
      releasesOk: true,
      replies: [
        { id: 'rep_2', reportId: 'r_2', reportMessage: 'Плейлист', kind: 'bug', message: 'И это готово', createdAt: now + 5000 },
        { id: 'rep_1', reportId: 'r_1', reportMessage: 'Текст отстаёт', kind: 'bug', message: 'Починили таймер Spotify!', createdAt: now - 5000 },
      ],
      announcements: [],
      releases: [
        { version: '0.3.7', title: 'Nocturne 0.3.7', notes: 'Исправлено', publishedAt: new Date(now - 60_000).toISOString(), url: '' },
      ],
      sentReports: [],
    })

    await useNotifications.getState().refresh(true)
    const nextState = useNotifications.getState()
    expect(unreadNotificationCount(nextState.items, nextState.seenIds)).toBe(1)
    expect(h.toastCalls.some((t) => t.text.includes('Ответ от разработчика'))).toBe(true)
  })

  it('orders replies, available updates, and other items with a transitive comparator invariant to input order', () => {
    const replies = [
      { id: 'r_old', reportId: 'rep1', reportMessage: 'A', kind: 'bug', message: 'Old reply', createdAt: 1000 },
      { id: 'r_new', reportId: 'rep2', reportMessage: 'B', kind: 'bug', message: 'New reply', createdAt: 5000 },
    ]
    const announcements = [
      { id: 'a_mid', title: 'News', message: 'Mid', createdAt: 3000 },
    ]
    const releases = [
      { version: '0.3.6', title: '0.3.6', notes: '', publishedAt: new Date(2000).toISOString(), url: '' },
      { version: '0.3.8', title: '0.3.8', notes: '', publishedAt: new Date(1500).toISOString(), url: '' },
      { version: '0.3.7', title: '0.3.7', notes: '', publishedAt: new Date(4000).toISOString(), url: '' },
    ]
    const update = { phase: 'available', version: '0.3.8', notes: '' }

    const forward = buildFeedItems({ currentVersion: '0.3.7', replies, announcements, releases }, update)
    const reversed = buildFeedItems(
      { currentVersion: '0.3.7', replies: [...replies].reverse(), announcements, releases: [...releases].reverse() },
      update,
    )

    const expected = ['reply:r_new', 'reply:r_old', 'rel:0.3.8', 'rel:0.3.7', 'ann:a_mid', 'rel:0.3.6']
    expect(forward.map((i) => i.itemId)).toEqual(expected)
    expect(reversed.map((i) => i.itemId)).toEqual(expected)
  })
})
