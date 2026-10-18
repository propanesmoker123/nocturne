import { beforeEach, describe, expect, test, vi } from 'vitest'

const store = vi.hoisted(() => ({ data: null as unknown, saved: [] as unknown[] }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => store.data, saveJSON: async (_: string, d: unknown) => void store.saved.push(d) }))

const { useDevices, loadDevices, ensureCode, joinGroup, renameDevice, unlinkHere, unlinkAll, onUnlink } = await import('./devices')

beforeEach(() => {
  store.data = null
  store.saved = []
  useDevices.setState({ ready: false, deviceId: '', name: 'Компьютер', code: null, devices: {}, remoteId: null })
})

describe('the linked devices of this one', () => {
  test('first start: a device id is made and kept, not linked yet', async () => {
    await loadDevices()
    const s = useDevices.getState()
    expect(s.deviceId).toMatch(/^[0-9a-f]{16}$/)
    expect(s.code).toBeNull()
    expect(store.saved.at(-1)).toMatchObject({ deviceId: s.deviceId, code: null })
  })

  test('what was saved comes back; junk in the file does not', async () => {
    store.data = { deviceId: 'abcdef0123456789', name: '  Ноут ', code: 'k7qm-2xfd-9wra-ht4c' }
    await loadDevices()
    expect(useDevices.getState()).toMatchObject({ deviceId: 'abcdef0123456789', name: 'Ноут', code: 'K7QM-2XFD-9WRA-HT4C' })
    store.data = { deviceId: 'nope', name: 7, code: 'nope' }
    await loadDevices()
    expect(useDevices.getState().deviceId).toMatch(/^[0-9a-f]{16}$/)
    expect(useDevices.getState().deviceId).not.toBe('nope')
    expect(useDevices.getState().code).toBeNull()
  })

  test('the code is made once; joining takes a typed code; a bad one is refused', async () => {
    await loadDevices()
    const code = ensureCode()
    expect(ensureCode()).toBe(code)
    expect(joinGroup('not a code')).toBe(false)
    expect(useDevices.getState().code).toBe(code)
    expect(joinGroup('zzzz 2xfd 9wra ht4c')).toBe(true)
    expect(useDevices.getState().code).toBe('ZZZZ-2XFD-9WRA-HT4C')
  })

  test('rename, unlink here, unlink everyone', async () => {
    await loadDevices()
    renameDevice('  ')
    expect(useDevices.getState().name).toBe('Компьютер')
    renameDevice('Ноутбук в спальне — очень длинное имя, которое обрежется до сорока')
    expect(useDevices.getState().name.length).toBeLessThanOrEqual(40)
    const code = ensureCode()
    unlinkAll()
    expect(useDevices.getState().code).not.toBe(code)
    unlinkHere()
    expect(useDevices.getState().code).toBeNull()
  })
})

describe('unlinking and who listens', () => {
  test('unlinking tells its listeners which kind: all devices, or this one', () => {
    const heard: string[] = []
    const off = onUnlink((kind) => heard.push(kind))
    ensureCode()
    unlinkAll()
    unlinkHere()
    joinGroup('K7QM-2XFD-9WRA-HT4C')
    off()
    unlinkAll()
    expect(heard).toEqual(['all', 'here'])
  })
})
