import { describe, expect, test, vi } from 'vitest'

vi.mock('../vk/api', () => ({ call: vi.fn() }))
vi.mock('./journal', () => ({ journal: vi.fn() }))

const { serverNow, syncServerTime } = await import('./serverTime')

const answer = (shiftMs: number) => () => Promise.resolve(Math.floor((Date.now() + shiftMs) / 1000))

describe('VK time', () => {
  test('a clock minutes off goes by VK', async () => {
    expect(await syncServerTime(answer(-5 * 60_000))).toBe(true)
    expect(Math.abs(serverNow() - (Date.now() - 5 * 60_000))).toBeLessThan(1500)
  })

  test('a second or so off is the local clock', async () => {
    await syncServerTime(answer(-5 * 60_000))
    await syncServerTime(answer(800))
    expect(serverNow() - Date.now()).toBe(0)
  })

  test('no answer, or nonsense, keeps what it had', async () => {
    await syncServerTime(answer(3 * 60_000))
    const had = serverNow() - Date.now()
    expect(await syncServerTime(() => Promise.reject(new Error('offline')))).toBe(false)
    expect(await syncServerTime(() => Promise.resolve('soon' as never))).toBe(false)
    expect(serverNow() - Date.now()).toBe(had)
  })
})
