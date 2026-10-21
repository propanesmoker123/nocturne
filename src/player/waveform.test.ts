import type Hls from 'hls.js'
import { afterEach, expect, test, vi } from 'vitest'
import { beginWaveform, captureSource, readWhole } from './waveform'
import { useWaveform } from './waveformStore'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, invoke: h.invoke }))
vi.mock('../lib/journal', () => ({ journal: vi.fn() }))

const metadata = () => new TextEncoder().encode(JSON.stringify({ height: 100, samples: [0, 50, 100] })).buffer
const drm = { licenseToken: 'temporary', appId: '46941' }

afterEach(() => { h.invoke.mockReset(); vi.unstubAllGlobals() })

test('in the app a whole file (a VK mp3) is read through the app, not by the page', async () => {
  h.invoke.mockResolvedValue(new ArrayBuffer(8))
  const url = 'https://cs1-2v4.vkuseraudio.ru/s/v1/acmp/x.mp3?siren=1'
  const bytes = await readWhole(url)
  expect(bytes.byteLength).toBe(8)
  expect(h.invoke).toHaveBeenCalledWith('proxy_fetch', { url })
})

test('protected audio uses provider waveform metadata and never registers audio capture', async () => {
  const decoder = vi.fn()
  vi.stubGlobal('OfflineAudioContext', decoder)
  h.invoke.mockResolvedValue(metadata())
  const stream = { on: vi.fn() }
  beginWaveform('protected-waveform', 120)
  captureSource({ url: 'https://stream/playlist.m3u8', hls: stream as unknown as Hls, drm, waveformUrl: 'https://wave.sndcdn.com/track.json' })
  await vi.waitFor(() => expect(useWaveform.getState().peaks?.length).toBe(3))
  expect(h.invoke).toHaveBeenCalledWith('proxy_fetch', { url: 'https://wave.sndcdn.com/track.json' })
  expect(stream.on).not.toHaveBeenCalled()
  expect(decoder).not.toHaveBeenCalled()
})

test('metadata finishing after a track switch cannot replace the current waveform', async () => {
  let finish!: (data: ArrayBuffer) => void
  h.invoke.mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finish = resolve }))
  beginWaveform('old-protected-waveform', 120)
  captureSource({ url: 'https://stream/playlist.m3u8', hls: null, drm, waveformUrl: 'https://wave.sndcdn.com/old.json' })
  beginWaveform('new-protected-waveform', 120)
  finish(metadata())
  await Promise.resolve()
  await Promise.resolve()
  expect(useWaveform.getState()).toEqual({ key: 'new-protected-waveform', peaks: null })
})

test('a protected source without waveform metadata never tries to decode the media URL', () => {
  beginWaveform('protected-without-waveform', 120)
  captureSource({ url: 'https://stream/playlist.m3u8', hls: null, drm })
  expect(h.invoke).not.toHaveBeenCalled()
})
