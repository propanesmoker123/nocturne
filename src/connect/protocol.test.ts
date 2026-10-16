import { describe, expect, test } from 'vitest'
import { MAX_PLAY_TRACKS, parseConnectMessage } from './protocol'

const w = (id: number) => ({ owner: 1, id, title: `T${id}`, artist: 'A', duration: 120 })
const presence = { name: '  Компьютер  ', platform: 'desktop', track: w(1), position: 12.5, duration: 120, playing: true, since: 1_790_000_000_000, volume: 0.8, shuffle: false, repeat: 'all', queue: { pos: 3, total: 20 } }

describe('what devices may say to each other', () => {
  test('presence comes through cleaned', () => {
    const m = parseConnectMessage({ type: 'presence', presence })
    expect(m).toMatchObject({ type: 'presence', presence: { name: 'Компьютер', track: { owner: 1, id: 1 }, repeat: 'all' } })
    expect(parseConnectMessage({ type: 'presence', presence: { ...presence, track: null, playing: false, since: 0 } })).not.toBeNull()
  })

  test('presence out of range or of the wrong shape is dropped', () => {
    for (const bad of [{ volume: 2 }, { platform: 'ios' }, { repeat: 'twice' }, { position: -1 }, { name: '' }, { queue: { pos: -1, total: 0 } }, { track: { owner: 1 } }]) {
      expect(parseConnectMessage({ type: 'presence', presence: { ...presence, ...bad } })).toBeNull()
    }
  })

  test('commands: only known actions; seek and volume need a value in range, others carry none', () => {
    expect(parseConnectMessage({ type: 'command', action: 'next', value: 99 })).toEqual({ type: 'command', action: 'next' })
    expect(parseConnectMessage({ type: 'command', action: 'seek', value: 30 })).toEqual({ type: 'command', action: 'seek', value: 30 })
    expect(parseConnectMessage({ type: 'command', action: 'seek' })).toBeNull()
    expect(parseConnectMessage({ type: 'command', action: 'volume', value: 1.5 })).toBeNull()
    expect(parseConnectMessage({ type: 'command', action: 'reboot' })).toBeNull()
  })

  test('«play this»: a window of tracks, an index inside it, nothing longer than the limit', () => {
    const order = { type: 'play', tracks: [w(1), w(2)], index: 1, position: 30, playing: true, shuffle: false, repeat: 'off', label: ' Моя музыка ' }
    expect(parseConnectMessage(order)).toMatchObject({ type: 'play', index: 1, label: 'Моя музыка' })
    expect(parseConnectMessage({ ...order, index: 2 })).toBeNull()
    expect(parseConnectMessage({ ...order, tracks: [] })).toBeNull()
    expect(parseConnectMessage({ ...order, tracks: Array.from({ length: MAX_PLAY_TRACKS + 1 }, (_, i) => w(i)) })).toBeNull()
    expect(parseConnectMessage({ ...order, tracks: [w(1), { id: 2 }] })).toBeNull()
  })

  test('pull, move to a device, bye; junk is dropped', () => {
    expect(parseConnectMessage({ type: 'pull' })).toEqual({ type: 'pull' })
    expect(parseConnectMessage({ type: 'move', target: 'abcdef0123456789' })).toEqual({ type: 'move', target: 'abcdef0123456789' })
    expect(parseConnectMessage({ type: 'move', target: '../etc' })).toBeNull()
    expect(parseConnectMessage({ type: 'bye' })).toEqual({ type: 'bye' })
    expect(parseConnectMessage({ type: 'state' })).toBeNull()
    expect(parseConnectMessage('presence')).toBeNull()
    expect(parseConnectMessage(null)).toBeNull()
  })

  test('an order says whether it is VK Mix and whether to start anywhere (shuffle play)', () => {
    const order = { type: 'play', tracks: [w(1)], index: 0, position: 0, playing: true, shuffle: true, repeat: 'off' }
    expect(parseConnectMessage({ ...order, mix: true, randomStart: true })).toMatchObject({ mix: true, randomStart: true })
    expect(parseConnectMessage(order)).not.toHaveProperty('mix')
    expect(parseConnectMessage({ ...order, mix: 'yes' })).toBeNull()
  })
})
