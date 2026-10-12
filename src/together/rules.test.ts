import { describe, expect, test } from 'vitest'
import { MAX_LISTENERS } from './protocol'
import { RateLimit, admit } from './rules'

describe('who gets into the room', () => {
  test('the host lets listeners in until the room is full and never takes another host', () => {
    expect(admit('host', { role: 'listener', full: false }, { listeners: 0, host: null }, 'p1')).toBe('accept')
    expect(admit('host', { role: 'listener', full: false }, { listeners: MAX_LISTENERS - 1, host: null }, 'p5')).toBe('accept')
    expect(admit('host', { role: 'listener', full: false }, { listeners: MAX_LISTENERS, host: null }, 'p6')).toBe('full')
    expect(admit('host', { role: 'host', full: false }, { listeners: 0, host: null }, 'h2')).toBe('reject')
  })

  test('a listener follows one host only and does not talk to other listeners', () => {
    expect(admit('listener', { role: 'host', full: false }, { listeners: 0, host: null }, 'h1')).toBe('accept')
    expect(admit('listener', { role: 'host', full: false }, { listeners: 0, host: 'h1' }, 'h1')).toBe('accept')
    expect(admit('listener', { role: 'host', full: false }, { listeners: 0, host: 'h1' }, 'h2')).toBe('reject')
    expect(admit('listener', { role: 'listener', full: false }, { listeners: 0, host: 'h1' }, 'p2')).toBe('reject')
  })
})

describe('message rate', () => {
  test('up to the limit per second per participant, then refused until the next second', () => {
    const limit = new RateLimit(20)
    for (let i = 0; i < 20; i++) expect(limit.hit('p1', 1000 + i)).toBe(true)
    expect(limit.hit('p1', 1500)).toBe(false)
    expect(limit.hit('p2', 1500)).toBe(true)
    expect(limit.hit('p1', 2001)).toBe(true)
  })
})
