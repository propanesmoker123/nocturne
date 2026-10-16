import { beforeEach, describe, expect, test, vi } from 'vitest'

/** What latest.json says right now (and a check that hangs until let go), and what got installed. */
const feed = { version: '0.2.10', hold: null as Promise<void> | null }
const installed: string[] = []
const release = (version: string) => ({
  version,
  body: `notes ${version}`,
  downloadAndInstall: async () => void installed.push(version),
  close: async () => {},
})

vi.mock('./tauri', () => ({ isTauri: () => true }))
vi.mock('./journal', () => ({ journal: () => {} }))
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: async () => {
    const at = feed.version
    if (feed.hold) await feed.hold
    return at ? release(at) : null
  },
}))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }))

const { useUpdates } = await import('./updates')

beforeEach(() => {
  installed.length = 0
  feed.version = '0.2.10'
  feed.hold = null
  useUpdates.setState({ phase: 'idle', version: undefined, progress: 0 })
})

describe('the update on offer', () => {
  test('a release that comes out while an older one is on offer replaces it', async () => {
    await useUpdates.getState().check(true)
    expect(useUpdates.getState()).toMatchObject({ phase: 'available', version: '0.2.10' })
    feed.version = '0.2.11'
    await useUpdates.getState().check(false, 0)
    expect(useUpdates.getState()).toMatchObject({ phase: 'available', version: '0.2.11', notes: 'notes 0.2.11' })
  })

  test('a background check that ends while the update downloads leaves the download on screen', async () => {
    await useUpdates.getState().check(true)
    let release!: () => void
    feed.hold = new Promise((r) => (release = r))
    const background = useUpdates.getState().check(false, 0)
    feed.hold = null
    const installing = useUpdates.getState().install()
    await Promise.resolve()
    expect(useUpdates.getState().phase).toBe('downloading')
    release()
    await background
    expect(useUpdates.getState().phase).toBe('downloading')
    await installing
  })

  test('installing takes the newest release, not the one found earlier', async () => {
    await useUpdates.getState().check(true)
    feed.version = '0.2.12'
    await useUpdates.getState().install()
    expect(installed).toEqual(['0.2.12'])
  })
})
