import { describe, expect, test } from 'vitest'
import confText from '../../src-tauri/tauri.conf.json?raw'
import { RELAYS } from './transport'

describe('relays', () => {
  test('the window may open exactly the relays listening together uses, and no other websocket', () => {
    const conf = JSON.parse(confText)
    const connect = String(conf.app.security.csp).match(/connect-src ([^;]*)/)![1].split(/\s+/)
    const sockets = connect.filter((src) => src.startsWith('wss:') || src.startsWith('ws:'))
    expect(sockets.sort()).toEqual([...RELAYS].sort())
    expect(RELAYS.length).toBeGreaterThanOrEqual(5)
  })
})
