import { describe, expect, test } from 'vitest'
import { MAX_MESSAGE_BYTES, parseHandshake, parseMessage } from './protocol'

const track = { owner: -2001, id: 5123, accessKey: 'a1b2c3', title: 'Ночной город', artist: 'Северный ветер', duration: 214 }
const state = { v: 1, type: 'state', seq: 3, track, position: 42.5, playing: true, at: 1_790_000_000_000 }

describe('messages between participants', () => {
  test('every kind of valid message gets through, without fields nobody asked for', () => {
    expect(parseMessage({ v: 1, type: 'hello', name: 'Саша', avatar: 'x' })).toEqual({ v: 1, type: 'hello', name: 'Саша' })
    expect(parseMessage({ v: 1, type: 'welcome', host: 'Дима', listeners: 2 })).toEqual({ v: 1, type: 'welcome', host: 'Дима', listeners: 2 })
    expect(parseMessage({ ...state, extra: 1, track: { ...track, url: 'https://cs1.vk/x.m3u8' } })).toEqual(state)
    expect(parseMessage({ ...state, track: null, playing: false })).toEqual({ ...state, track: null, playing: false })
    expect(parseMessage({ ...state, track: { ...track, accessKey: 'k5_Ab-9' } })).toEqual({ ...state, track: { ...track, accessKey: 'k5_Ab-9' } })
    expect(parseMessage({ v: 1, type: 'status', state: 'paused' })).toEqual({ v: 1, type: 'status', state: 'paused' })
    expect(parseMessage({ v: 1, type: 'ping', t0: 10 })).toEqual({ v: 1, type: 'ping', t0: 10 })
    expect(parseMessage({ v: 1, type: 'pong', t0: 10, t1: 20 })).toEqual({ v: 1, type: 'pong', t0: 10, t1: 20 })
    expect(parseMessage({ v: 1, type: 'bye' })).toEqual({ v: 1, type: 'bye' })
  })

  test('long names and titles are cut, an empty name gets a placeholder', () => {
    const long = parseMessage({ ...state, track: { ...track, title: 'я'.repeat(500) } })
    expect(long?.type === 'state' && long.track?.title.length).toBe(200)
    expect(parseMessage({ v: 1, type: 'hello', name: 'x'.repeat(100) })).toEqual({ v: 1, type: 'hello', name: 'x'.repeat(40) })
    expect(parseMessage({ v: 1, type: 'hello', name: '   ' })).toEqual({ v: 1, type: 'hello', name: 'Слушатель' })
  })

  test('anything malformed, out of range or too big is dropped', () => {
    const bad: unknown[] = [
      null,
      'state',
      [state],
      { ...state, v: 2 },
      { ...state, type: 'reboot' },
      { ...state, seq: -1 },
      { ...state, seq: 1.5 },
      { ...state, position: -3 },
      { ...state, position: Number.NaN },
      { ...state, playing: 'yes' },
      { ...state, at: Infinity },
      { ...state, track: { ...track, id: 'x' } },
      { ...state, track: { ...track, accessKey: 'zz&owner_id=1' } },
      { ...state, track: { ...track, accessKey: 'k'.repeat(65) } },
      { ...state, track: { ...track, duration: 999_999 } },
      { ...state, track: { ...track, title: 42 } },
      { v: 1, type: 'status', state: 'hacking' },
      { v: 1, type: 'welcome', host: 'Дима', listeners: 99 },
      { v: 1, type: 'ping' },
      { ...state, padding: 'x'.repeat(MAX_MESSAGE_BYTES) },
    ]
    for (const raw of bad) expect(parseMessage(raw)).toBe(null)
  })
})

describe('handshake', () => {
  test('a peer says which role it takes; the host may say the room is full', () => {
    expect(parseHandshake({ v: 1, role: 'listener' })).toEqual({ role: 'listener', full: false })
    expect(parseHandshake({ v: 1, role: 'host', full: true })).toEqual({ role: 'host', full: true })
    expect(parseHandshake({ v: 1, role: 'admin' })).toBe(null)
    expect(parseHandshake({ role: 'host' })).toBe(null)
  })
})
