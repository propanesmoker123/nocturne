import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ tauri: true, asked: [] as [string, unknown][] }))
vi.mock('../lib/tauri', () => ({
  isTauri: () => h.tauri,
  invoke: async (cmd: string, args: unknown) => {
    h.asked.push([cmd, args])
    return new ArrayBuffer(8)
  },
}))
vi.mock('../lib/journal', () => ({ journal: () => {} }))

const { readWhole } = await import('./waveform')

beforeEach(() => {
  h.asked.length = 0
  h.tauri = true
})

describe('the waveform of a plain file', () => {
  test('in the app a whole file (a VK mp3) is read through the app, not by the page', async () => {
    const url = 'https://cs1-2v4.vkuseraudio.ru/s/v1/acmp/x.mp3?siren=1'
    const bytes = await readWhole(url)
    expect(bytes.byteLength).toBe(8)
    expect(h.asked).toEqual([['proxy_fetch', { url }]])
  })
})
