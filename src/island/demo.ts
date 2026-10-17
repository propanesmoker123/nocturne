import type { PlayerSnapshot } from '../lib/events'
import { DEFAULT_SETTINGS, type IslandSettings } from '../lib/settings'
import { useWaveform } from '../player/waveformStore'
import { cover } from '../vk/mock'

interface DemoApi {
  state: (st: PlayerSnapshot) => void
  settings: (s: IslandSettings) => void
  hover: (inside: boolean) => void
  wave: (color: string | null) => void
}

/**
 * Browser dev only (`island.html#demo`): stands in for the main window so the island can be seen
 * and poked without Tauri. `window.islandDemo` changes the volume, hover, settings and so on.
 */
export function startIslandDemo(api: DemoApi): () => void {
  document.documentElement.style.setProperty('background', 'linear-gradient(135deg, #3a4a6b, #8a6f8f 55%, #d9a77a)', 'important')
  const duration = 214
  let snap: PlayerSnapshot = {
    track: { key: 'demo_1', title: 'Ночной город', artist: 'Северный ветер', cover: cover(7), coverLarge: cover(7), explicit: false, liked: true, duration },
    isPlaying: true,
    isLoading: false,
    position: 42,
    at: Date.now(),
    duration,
    volume: 0.6,
    muted: false,
    shuffle: false,
    repeat: 'off',
    accent: '#ff375f',
    together: null,
  }
  let settings: IslandSettings = { ...DEFAULT_SETTINGS.island }
  const position = () => (snap.isPlaying ? snap.position + (Date.now() - snap.at) / 1000 : snap.position)
  const push = (patch: Partial<PlayerSnapshot>) => {
    snap = { ...snap, position: position(), at: Date.now(), ...patch }
    api.state(snap)
  }

  // A plausible song shape: quiet intro, verses, louder choruses, fade-out.
  const peaks = Array.from({ length: 240 }, (_, i) => {
    const t = i / 239
    const body = t < 0.06 ? t / 0.06 : t > 0.93 ? (1 - t) / 0.07 : 0.62 + 0.3 * Math.max(0, Math.sin(t * Math.PI * 5))
    return Math.max(0.04, Math.min(1, body * (0.78 + 0.22 * Math.sin(i * 12.9898) ** 2)))
  })
  useWaveform.setState({ key: 'demo_1', peaks: Float32Array.from(peaks) })

  api.settings(settings)
  api.state(snap)
  if (location.hash === '#demo-open') setTimeout(() => api.hover(true), 100)
  ;(window as unknown as { islandDemo: unknown }).islandDemo = {
    volume: (v: number) => push({ volume: v, muted: false }),
    mute: () => push({ muted: !snap.muted }),
    playing: (on: boolean) => push({ isPlaying: on }),
    seek: (sec: number) => push({ position: sec }),
    together: (t: PlayerSnapshot['together']) => push({ together: t }),
    track: (patch: Partial<NonNullable<PlayerSnapshot['track']>>) => push({ track: { ...snap.track!, ...patch } }),
    hover: api.hover,
    waveColor: api.wave,
    settings: (patch: Partial<IslandSettings>) => {
      settings = { ...settings, ...patch }
      api.settings(settings)
    },
  }
  return () => document.documentElement.style.removeProperty('background')
}
