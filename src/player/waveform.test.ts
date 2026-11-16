import Hls from 'hls.js'
import { afterEach, expect, test, vi } from 'vitest'
import { beginWaveform, captureSource, isMp4InitOnly, readWhole } from './waveform'
import { useWaveform } from './waveformStore'

const h = vi.hoisted(() => ({ invoke: vi.fn(), blobBytes: new Map<string, ArrayBuffer>() }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, invoke: h.invoke }))
vi.mock('../lib/journal', () => ({ journal: vi.fn() }))
vi.mock('./preload', () => ({
  takePreloadedBlobBytes: (url: string) => {
    const b = h.blobBytes.get(url) ?? null
    if (b) h.blobBytes.delete(url)
    return b
  },
}))

const mp4Box = (type: string, bodyLen = 8, fill = 0x11) => {
  const out = new Uint8Array(8 + bodyLen)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.fill(fill, 8)
  return out
}

const concatBytes = (...parts: Uint8Array[]) => {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const metadata = () => new TextEncoder().encode(JSON.stringify({ height: 100, samples: [0, 50, 100] })).buffer
const drm = { licenseToken: 'temporary', appId: '46941' }

afterEach(() => {
  h.invoke.mockReset()
  h.blobBytes.clear()
  vi.unstubAllGlobals()
})

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
  expect(useWaveform.getState()).toEqual({ key: 'new-protected-waveform', peaks: null, beats: null, vocal: null })
})

test('a protected source without waveform metadata never tries to decode the media URL', () => {
  beginWaveform('protected-without-waveform', 120)
  captureSource({ url: 'https://stream/playlist.m3u8', hls: null, drm })
  expect(h.invoke).not.toHaveBeenCalled()
})

test('isMp4InitOnly distinguishes init boxes (ftyp+moov) from media fragments (moof+mdat)', () => {
  const init = concatBytes(mp4Box('ftyp', 12), mp4Box('moov', 24))
  const frag = concatBytes(mp4Box('moof', 16), mp4Box('mdat', 32))
  expect(isMp4InitOnly(init)).toBe(true)
  expect(isMp4InitOnly(frag)).toBe(false)
  expect(isMp4InitOnly(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe(false)
})

test('preloaded blob URL uses cached preloaded bytes or falls back to rawUrl via proxy_fetch on fetch failure', async () => {
  const preloaded = new Uint8Array([1, 2, 3, 4]).buffer
  h.blobBytes.set('blob:http://tauri.localhost/vk-preloaded', preloaded)
  expect((await readWhole('blob:http://tauri.localhost/vk-preloaded', 'https://cdn.vk/a.mp3')).byteLength).toBe(4)

  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  h.invoke.mockResolvedValue(new ArrayBuffer(12))
  const fallback = await readWhole('blob:http://tauri.localhost/missing', 'https://cdn.vk/fallback.mp3')
  expect(fallback.byteLength).toBe(12)
  expect(h.invoke).toHaveBeenCalledWith('proxy_fetch', { url: 'https://cdn.vk/fallback.mp3' })
})

test('HLS initSegment emitted on BUFFER_APPENDING (0:0) never fails or drops the real 0:0 media chunk', async () => {
  const decodedInputs: Uint8Array[] = []
  const sampleBuf = {
    numberOfChannels: 1,
    sampleRate: 8000,
    duration: 5,
    getChannelData: () => new Float32Array(8000).fill(0.5),
  }
  class FakeOfflineCtx {
    decodeAudioData = vi.fn(async (buf: ArrayBuffer) => {
      const u8 = new Uint8Array(buf)
      decodedInputs.push(u8)
      return sampleBuf
    })
  }
  vi.stubGlobal('OfflineAudioContext', FakeOfflineCtx)

  const handlers = new Map<string, ((ev: string, data: unknown) => void)[]>()
  const stream = {
    on: vi.fn((ev: string, fn: (ev: string, data: unknown) => void) => {
      const list = handlers.get(ev) ?? []
      list.push(fn)
      handlers.set(ev, list)
    }),
  }

  const initSeg = concatBytes(mp4Box('ftyp', 12, 0x01), mp4Box('moov', 24, 0x02))
  const mediaFrag = concatBytes(mp4Box('moof', 16, 0x03), mp4Box('mdat', 64, 0x04))

  beginWaveform('vk-hls-init-test', 20)
  captureSource({ url: 'https://cdn.vk/index.m3u8', hls: stream as unknown as Hls })

  // hls.js emits BUFFER_APPENDING for initSegment (cc:0, sn:0) BEFORE FRAG_PARSING_INIT_SEGMENT,
  // followed by BUFFER_APPENDING for the real media segment (also cc:0, sn:0).
  handlers.get(Hls.Events.BUFFER_APPENDING)?.forEach((fn) =>
    fn(Hls.Events.BUFFER_APPENDING, { type: 'audio', frag: { cc: 0, sn: 0, start: 0 }, data: initSeg }),
  )
  handlers.get(Hls.Events.FRAG_PARSING_INIT_SEGMENT)?.forEach((fn) =>
    fn(Hls.Events.FRAG_PARSING_INIT_SEGMENT, { tracks: { audio: { initSegment: initSeg, container: 'audio/mp4' } } }),
  )
  handlers.get(Hls.Events.BUFFER_APPENDING)?.forEach((fn) =>
    fn(Hls.Events.BUFFER_APPENDING, { type: 'audio', frag: { cc: 0, sn: 0, start: 0 }, data: mediaFrag }),
  )

  await vi.waitFor(() => expect(useWaveform.getState().peaks).not.toBeNull())
  expect(decodedInputs).toHaveLength(1)
  expect(decodedInputs[0]!.byteLength).toBe(initSeg.length + mediaFrag.length)
  expect(useWaveform.getState().peaks![0]).toBeGreaterThan(0.5)
})

test('HLS decode recovers via cumulative segments when an isolated middle fragment fails decodeAudioData', async () => {
  const initSeg = concatBytes(mp4Box('ftyp', 12, 0x01), mp4Box('moov', 24, 0x02))
  const frag0 = concatBytes(mp4Box('moof', 16, 0x03), mp4Box('mdat', 40, 0x04))
  const frag1 = concatBytes(mp4Box('moof', 16, 0x05), mp4Box('mdat', 40, 0x06))

  class SelectiveOfflineCtx {
    decodeAudioData = vi.fn(async (buf: ArrayBuffer) => {
      const len = buf.byteLength
      // Fail only when initSeg + frag1 is decoded in isolation; succeed on cumulative [initSeg, frag0, frag1]
      if (len === initSeg.length + frag1.length && new Uint8Array(buf)[initSeg.length + 10] === 0x05) {
        throw new DOMException('Unable to decode audio data', 'EncodingError')
      }
      const isCumulative = len >= initSeg.length + frag0.length + frag1.length
      return {
        numberOfChannels: 1,
        sampleRate: 8000,
        duration: isCumulative ? 10 : 5,
        getChannelData: () => new Float32Array(isCumulative ? 80000 : 40000).fill(0.4),
      }
    })
  }
  vi.stubGlobal('OfflineAudioContext', SelectiveOfflineCtx)

  const handlers = new Map<string, ((ev: string, data: unknown) => void)[]>()
  const stream = {
    on: vi.fn((ev: string, fn: (ev: string, data: unknown) => void) => {
      const list = handlers.get(ev) ?? []
      list.push(fn)
      handlers.set(ev, list)
    }),
  }

  beginWaveform('vk-hls-cumulative-test', 10)
  captureSource({ url: 'https://cdn.vk/index.m3u8', hls: stream as unknown as Hls })
  handlers.get(Hls.Events.FRAG_PARSING_INIT_SEGMENT)?.forEach((fn) =>
    fn(Hls.Events.FRAG_PARSING_INIT_SEGMENT, { tracks: { audio: { initSegment: initSeg, container: 'audio/mp4' } } }),
  )
  handlers.get(Hls.Events.BUFFER_APPENDING)?.forEach((fn) =>
    fn(Hls.Events.BUFFER_APPENDING, { type: 'audio', frag: { cc: 0, sn: 0, start: 0 }, data: frag0 }),
  )
  handlers.get(Hls.Events.BUFFER_APPENDING)?.forEach((fn) =>
    fn(Hls.Events.BUFFER_APPENDING, { type: 'audio', frag: { cc: 0, sn: 1, start: 5 }, data: frag1 }),
  )

  await vi.waitFor(() => {
    const peaks = useWaveform.getState().peaks
    expect(peaks).not.toBeNull()
    expect(peaks![200]).toBeGreaterThan(0.5)
  })
})
