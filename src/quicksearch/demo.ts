import type { QuickResults, QuickTrack } from '../lib/events'
import { cover } from '../vk/mock'
import type { QuickTransport } from './QuickSearchApp'

const t = (key: string, title: string, artist: string, duration: number, extra: Partial<QuickTrack> = {}): QuickTrack => ({
  key,
  title,
  artist,
  duration,
  explicit: false,
  playable: true,
  cover: cover(key.length * 7 + key.charCodeAt(key.length - 1)),
  ...extra,
})

const OWN = [
  t('own_1', 'Ночной город', 'Северный ветер', 214),
  t('own_2', 'Ночной трамвай', 'Огни', 187, { explicit: true }),
  t('own_3', 'Night Drive', 'Neon Coast', 243),
]
const VK = [
  t('vk_1', 'Ночной город', 'Северный ветер', 215, { subtitle: 'Live' }),
  t('vk_2', 'Ночной экспресс', 'Полярная звезда', 201),
  t('vk_3', 'Night City Lights', 'Midnight Avenue', 232),
  t('vk_4', 'Ночные окна', 'Кассета', 176),
  t('vk_5', 'Ночная смена', 'Бульвар', 199, { playable: false }),
  t('vk_6', 'Night Swim', 'Lagoon', 205),
  t('vk_7', 'Ночной разговор', 'Тихий час', 248),
  t('vk_8', 'Nightfall', 'Aurora Lane', 221),
]

/** Browser dev only (`search.html#demo`): answers like the main window would, from a fake library. */
export function demoTransport(deliver: (r: QuickResults) => void): QuickTransport {
  document.documentElement.style.setProperty('background', 'linear-gradient(135deg, #24324d, #5d4a6b 55%, #b07f63)', 'important')
  return {
    query: ({ seq, q }) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean)
      const match = (x: QuickTrack) => words.every((w) => `${x.title} ${x.artist}`.toLowerCase().includes(w))
      const base = { seq, error: null, accent: '#ff375f', playingKey: 'own_2', playing: true }
      if (q.trim().length < 2) return deliver({ ...base, own: [], others: [], loading: false })
      deliver({ ...base, own: OWN.filter(match), others: [], loading: true })
      setTimeout(() => deliver({ ...base, own: OWN.filter(match), others: VK.filter(match), loading: false }), 450)
    },
    play: (p) => console.info('[quick search demo] play', p),
    hide: () => console.info('[quick search demo] hide'),
  }
}
