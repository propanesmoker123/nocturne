import { describe, expect, test, vi } from 'vitest'
import { drmConfig, probeDrm, providerPeaks } from './playback'

describe('authorized SoundCloud DRM playback', () => {
  test('uses EME and the service license endpoints without putting tokens in the config URLs', () => {
    const cfg = drmConfig({ licenseToken: 'temporary', appId: '46941' })
    expect(cfg.emeEnabled).toBe(true)
    expect(cfg.drmSystems?.['com.widevine.alpha']?.licenseUrl).toBe('https://license.media-streaming.soundcloud.cloud/playback/widevine')
    expect(cfg.drmSystems?.['com.microsoft.playready']?.licenseUrl).toBe('https://license.media-streaming.soundcloud.cloud/playback/playready')
  })

  test('sends the per-stream authorization only to the fixed license endpoint', () => {
    const xhr = { open: vi.fn(), setRequestHeader: vi.fn() }
    const cfg = drmConfig({ licenseToken: 'temporary+token', appId: '46941' })
    const setup = cfg.licenseXhrSetup as unknown as (request: typeof xhr, url: string) => void
    setup(xhr, 'https://license.media-streaming.soundcloud.cloud/playback/widevine')
    const [method, url] = xhr.open.mock.calls[0]
    expect(method).toBe('POST')
    expect(new URL(url).searchParams.get('license_token')).toBe('temporary+token')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-SC-Application-Id', '46941')
    xhr.open.mockClear()
    expect(() => setup(xhr, 'https://example.com/playback/widevine')).toThrow()
    expect(() => setup(xhr, 'https://license.media-streaming.soundcloud.cloud/other')).toThrow()
    expect(xhr.open).not.toHaveBeenCalled()
  })
})

test('provider waveform metadata supplies normalized peaks without decoding protected audio', () => {
  expect(Array.from(providerPeaks({ height: 100, samples: [0, 25, 100, 50] })!)).toEqual([0, 0.25, 1, 0.5])
  for (const bad of [null, {}, { height: 0, samples: [1] }, { height: 100, samples: [] }, { height: 100, samples: [NaN] }]) {
    expect(providerPeaks(bad)).toBeNull()
  }
})

test("PlayReady's request keeps the type hls.js gives it; Widevine's is raw bytes", () => {
  const setup = drmConfig({ licenseToken: 't', appId: '1' }).licenseXhrSetup as unknown as (x: unknown, u: string) => void
  const pr = { open: vi.fn(), setRequestHeader: vi.fn() }
  setup(pr, 'https://license.media-streaming.soundcloud.cloud/playback/playready')
  expect(pr.setRequestHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything())
  expect(pr.setRequestHeader).toHaveBeenCalledWith('X-SC-Application-Id', '1')
  const wv = { open: vi.fn(), setRequestHeader: vi.fn() }
  setup(wv, 'https://license.media-streaming.soundcloud.cloud/playback/widevine')
  expect(wv.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
})

describe('which DRM this computer has', () => {
  const nav = (ok: string[]) => {
    const asked: string[] = []
    vi.stubGlobal('navigator', { requestMediaKeySystemAccess: (ks: string) => (asked.push(ks), ok.includes(ks) ? Promise.resolve({ keySystem: ks }) : Promise.reject(new Error('no'))) })
    return asked
  }

  test("Edge's engine calls PlayReady by its longer name: asked for the short one, the long one is tried", async () => {
    const asked = nav(['com.microsoft.playready.recommendation'])
    const access = drmConfig({ licenseToken: 't', appId: '1' }).requestMediaKeySystemAccessFunc!
    await expect(access('com.microsoft.playready' as never, [])).resolves.toBeTruthy()
    expect(asked).toEqual(['com.microsoft.playready', 'com.microsoft.playready.recommendation'])
    await expect(access('com.widevine.alpha' as never, [])).rejects.toThrow()
    vi.unstubAllGlobals()
  })

  test('protected tracks play only where Widevine or PlayReady answers', async () => {
    nav(['com.widevine.alpha'])
    expect(await probeDrm()).toBe(true)
    nav(['com.microsoft.playready.recommendation'])
    expect(await probeDrm()).toBe(true)
    nav([])
    expect(await probeDrm()).toBe(false)
    vi.stubGlobal('navigator', {})
    expect(await probeDrm()).toBe(false)
    vi.unstubAllGlobals()
  })
})
