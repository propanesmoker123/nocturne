import type { HlsConfig } from 'hls.js'

/** Per-stream license authorization, never part of a persisted Track. Account OAuth stays in Rust. */
export interface ScDrm {
  licenseToken: string
  appId: string
}

export interface ScPlaybackSource {
  url: string
  drm?: ScDrm
  waveformUrl?: string
}

const LICENSE_ORIGIN = 'https://license.media-streaming.soundcloud.cloud'
const LICENSE_PATHS = ['/playback/widevine', '/playback/playready']

/** hls.js lets the browser CDM request and consume SoundCloud's normal playback license. */
export function drmConfig(drm: ScDrm): Partial<HlsConfig> {
  return {
    emeEnabled: true,
    drmSystems: {
      'com.widevine.alpha': { licenseUrl: `${LICENSE_ORIGIN}/playback/widevine` },
      'com.microsoft.playready': { licenseUrl: `${LICENSE_ORIGIN}/playback/playready` },
    },
    licenseXhrSetup(xhr, url) {
      const target = new URL(url)
      if (target.origin !== LICENSE_ORIGIN || !LICENSE_PATHS.includes(target.pathname)) throw new Error('Unexpected license endpoint')
      target.searchParams.set('license_token', drm.licenseToken)
      xhr.open('POST', target.href, true)
      // PlayReady's request is SOAP: hls.js sets its own type after this (two would be joined into one bad header)
      if (target.pathname === '/playback/widevine') xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('X-SC-Application-Id', drm.appId)
    },
    // Edge's engine (WebView2) answers PlayReady by its longer name
    requestMediaKeySystemAccessFunc: (keySystem, configs) =>
      navigator.requestMediaKeySystemAccess(keySystem, configs).catch((e: unknown) => {
        if (keySystem !== 'com.microsoft.playready') throw e
        return navigator.requestMediaKeySystemAccess(PLAYREADY_EDGE, configs)
      }),
  }
}

const PLAYREADY_EDGE = 'com.microsoft.playready.recommendation'
/** What a protected SoundCloud stream needs from the browser: AAC in MP4 through a CDM. */
const PROBE: MediaKeySystemConfiguration[] = [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]

/**
 * Whether this computer can play SoundCloud's protected tracks (Widevine or PlayReady through the
 * browser). Without it they stay grey, as before, instead of failing one after another.
 */
export async function probeDrm(): Promise<boolean> {
  const ask = typeof navigator !== 'undefined' ? navigator.requestMediaKeySystemAccess?.bind(navigator) : undefined
  if (!ask) return false
  for (const ks of ['com.widevine.alpha', 'com.microsoft.playready', PLAYREADY_EDGE]) {
    try {
      await ask(ks, PROBE)
      return true
    } catch {
      // the next one
    }
  }
  return false
}

/** SoundCloud's own public waveform metadata: protected audio never goes through decodeAudioData. */
export function providerPeaks(raw: unknown): Float32Array | null {
  if (!raw || typeof raw !== 'object') return null
  const { height, samples } = raw as { height?: unknown; samples?: unknown }
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || !Array.isArray(samples) || !samples.length || samples.length > 100_000) return null
  if (!samples.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  return Float32Array.from(samples as number[], (x) => Math.max(0, Math.min(1, x / height)))
}
