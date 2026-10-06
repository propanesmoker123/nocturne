// Browser-only demo backend: lets the UI run without Tauri (`npm run dev` in a normal
// browser). All names, covers and lyrics lines are invented placeholders.

import type { RawAudio, RawCatalogResponse, RawPlaylist, RawUser } from './types'

const ME = 1000
const ARTISTS = ['Полярная ночь', 'Кварц', 'Тихий город', 'Мята', 'Северный ветер', 'Нео Ритм', 'Облака', 'Ледокол', 'Сирень', 'Стеклянный сад', 'Пульс', 'Лунный свет']
const TITLES = [
  'Огни трассы', 'Медленный рассвет', 'Невесомость', 'Синие провода', 'Тёплый асфальт', 'Не спи', 'Поздний троллейбус', 'Кометы',
  'Шёпот', 'Неон', 'Холодный чай', 'Дым над рекой', 'Ночные окна', 'Белый шум', 'Пять утра', 'Сквозь стекло', 'Июльский дождь',
  'Карусель', 'Мосты', 'Мятный воздух', 'Электричка', 'Фонари', 'Снег в августе', 'Радиоволны', 'Часы без стрелок', 'Маяк',
  'Город спит', 'Под водой', 'Северное сияние', 'Последний автобус', 'Магниты', 'Космонавт',
]
const PALETTE = ['#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#0a84ff', '#40cbe0', '#ffd60a', '#ff453a', '#64d2ff']

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function cover(seed: number): string {
  const r = rng(seed * 97 + 13)
  const a = PALETTE[Math.floor(r() * PALETTE.length)]
  const b = PALETTE[Math.floor(r() * PALETTE.length)]
  const c = PALETTE[Math.floor(r() * PALETTE.length)]
  const cx = Math.round(r() * 600)
  const cy = Math.round(r() * 600)
  const rad = Math.round(150 + r() * 260)
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient><filter id='b'><feGaussianBlur stdDeviation='40'/></filter></defs><rect width='600' height='600' fill='url(#g)'/><circle cx='${cx}' cy='${cy}' r='${rad}' fill='${c}' opacity='0.75' filter='url(#b)'/><circle cx='${600 - cx}' cy='${600 - cy}' r='${Math.round(rad / 2)}' fill='#000' opacity='0.25' filter='url(#b)'/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function avatar(seed: number, initials: string): string {
  const r = rng(seed * 31 + 7)
  const a = PALETTE[Math.floor(r() * PALETTE.length)]
  const b = PALETTE[Math.floor(r() * PALETTE.length)]
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/><text x='50' y='62' font-family='Segoe UI, sans-serif' font-size='36' font-weight='600' fill='white' text-anchor='middle'>${initials}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const thumb = (seed: number) => {
  const u = cover(seed)
  return { photo_68: u, photo_135: u, photo_300: u, photo_600: u, photo_1200: u }
}

let toneUrl: string | null = null

/** A soft 40-second synth pad rendered to WAV, used as every demo track's audio. */
function demoAudio(): string {
  if (toneUrl) return toneUrl
  const rate = 22050
  const seconds = 40
  const n = rate * seconds
  const data = new Int16Array(n)
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 311.13],
  ]
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const chord = chords[Math.floor(t / 5) % chords.length]
    const env = Math.min(1, t / 1.5, (seconds - t) / 1.5)
    let v = 0
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t) * 0.18 + Math.sin(2 * Math.PI * f * 2 * t) * 0.04
    v *= env * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * t))
    data[i] = Math.max(-1, Math.min(1, v)) * 32767
  }
  const buf = new ArrayBuffer(44 + data.byteLength)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => [...s].forEach((ch, k) => dv.setUint8(o + k, ch.charCodeAt(0)))
  w(0, 'RIFF')
  dv.setUint32(4, 36 + data.byteLength, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  w(36, 'data')
  dv.setUint32(40, data.byteLength, true)
  new Int16Array(buf, 44).set(data)
  toneUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
  return toneUrl
}

function track(i: number, owner = -2000): RawAudio {
  const r = rng(i + 1)
  const artist = ARTISTS[i % ARTISTS.length]
  const feat = r() > 0.8 ? ARTISTS[(i + 5) % ARTISTS.length] : null
  return {
    id: 5000 + i,
    owner_id: owner,
    artist: feat ? `${artist} feat. ${feat}` : artist,
    title: TITLES[i % TITLES.length] + (i >= TITLES.length ? ` (${['Remix', 'Live', 'Acoustic', 'Night Version'][i % 4]})` : ''),
    duration: Math.round(150 + r() * 130),
    access_key: `k${i}`,
    url: i % 17 === 9 ? '' : 'demo',
    is_explicit: r() > 0.85,
    has_lyrics: i % 3 === 0,
    main_artists: [{ id: `art${i % ARTISTS.length}`, name: artist }],
    featured_artists: feat ? [{ id: `art${(i + 5) % ARTISTS.length}`, name: feat }] : undefined,
    album: { id: 300 + (i % 9), owner_id: -2000, title: `Альбом ${(i % 9) + 1}`, thumb: thumb(i % 23) },
  }
}

const withUrl = (a: RawAudio): RawAudio => (a.url ? { ...a, url: demoAudio() } : a)

const MY = Array.from({ length: 64 }, (_, i) => ({ ...track(i, ME), id: 9000 + i }))
const CATALOG = Array.from({ length: 48 }, (_, i) => track(i + 64))
const removed = new Set<string>()

function playlist(i: number, owner: number, title: string, count: number, extra: Partial<RawPlaylist> = {}): RawPlaylist {
  return {
    id: 100 + i,
    owner_id: owner,
    title,
    description: i % 2 ? 'Демо-плейлист Nocturne' : '',
    count,
    photo: i % 3 === 2 ? undefined : thumb(40 + i),
    thumbs: [thumb(50 + i), thumb(51 + i), thumb(52 + i), thumb(53 + i)],
    access_key: `pk${i}`,
    permissions: { play: true, edit: owner === ME, delete: owner === ME, follow: owner !== ME },
    ...extra,
  }
}

const MY_PLAYLISTS: RawPlaylist[] = [
  playlist(0, ME, 'В дорогу', 18),
  playlist(1, ME, 'Для работы', 24),
  playlist(2, ME, 'Ночные', 12),
  playlist(3, -2000, 'Чарт недели', 50, { original: { playlist_id: 900, owner_id: -2000 }, is_following: true }),
]
const REC_PLAYLISTS: RawPlaylist[] = Array.from({ length: 8 }, (_, i) =>
  playlist(10 + i, -2000, ['Плейлист дня', 'Открытия', 'Новинки для вас', 'Тише', 'Энергия', 'Вечер', 'Фокус', 'Утро'][i], 30 + i * 5, { type: i === 2 ? 1 : 0 }),
)

const FRIENDS: RawUser[] = ['Аня Соколова', 'Дима Орлов', 'Катя Белова', 'Миша Ким', 'Лера Ветрова', 'Саша Громов', 'Оля Нестерова', 'Ваня Лис', 'Женя Тихонова'].map(
  (n, i) => {
    const [first, last] = n.split(' ')
    return { id: 200 + i, first_name: first, last_name: last, photo_100: avatar(i, first[0] + last[0]), can_see_audio: i % 4 === 3 ? 0 : 1 }
  },
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function page<T>(items: T[], params: Record<string, unknown>) {
  const offset = Number(params.offset ?? 0)
  const count = Number(params.count ?? 100)
  return { count: items.length, items: items.slice(offset, offset + count) }
}

function catalogResponse(): RawCatalogResponse {
  const ids = (list: RawAudio[]) => list.map((a) => `${a.owner_id}_${a.id}`)
  return {
    catalog: {
      default_section: 'home',
      sections: [
        {
          id: 'home',
          title: 'Главная',
          blocks: [
            { id: 'mix', data_type: 'audio_stream_mixes', layout: { name: 'audio_stream_mix_interactive' }, audio_stream_mixes_ids: ['common'] },
            { id: 'h1', data_type: 'none', layout: { name: 'header', title: 'Мои треки' } },
            { id: 'my', data_type: 'music_audios', layout: { name: 'triple_stacked_slider' }, audios_ids: ids(MY.slice(0, 18)) },
            { id: 'h2', data_type: 'none', layout: { name: 'header_extended', title: 'Собрано алгоритмами' } },
            { id: 'recp', data_type: 'music_playlists', layout: { name: 'recomms_slider' }, playlists_ids: REC_PLAYLISTS.map((p) => `${p.owner_id}_${p.id}`) },
            { id: 'h3', data_type: 'none', layout: { name: 'header', title: 'Похоже на «Кварц»' } },
            { id: 'sim', data_type: 'music_audios', layout: { name: 'triple_stacked_slider' }, audios_ids: ids(CATALOG.slice(0, 18)) },
          ],
        },
        { id: 'explore', title: 'Обзор' },
      ],
    },
    audios: [...MY.slice(0, 18), ...CATALOG.slice(0, 18)].map(withUrl),
    playlists: REC_PLAYLISTS,
    audio_stream_mixes: [{ id: 'common', description: 'Бесконечный поток под ваш вкус', stream_mix: { id: 'common', title: 'VK Микс' } }],
  }
}

function exploreResponse(): RawCatalogResponse {
  const ids = (list: RawAudio[]) => list.map((a) => `${a.owner_id}_${a.id}`)
  return {
    section: {
      id: 'explore',
      title: 'Обзор',
      blocks: [
        { id: 'e1', data_type: 'none', layout: { name: 'header_extended', title: 'Новинки' } },
        { id: 'e2', data_type: 'music_audios', layout: { name: 'triple_stacked_slider' }, audios_ids: ids(CATALOG.slice(18, 36)) },
        { id: 'e3', data_type: 'none', layout: { name: 'header_extended', title: 'Выбор редакции' } },
        { id: 'e4', data_type: 'music_playlists', layout: { name: 'large_slider' }, playlists_ids: REC_PLAYLISTS.slice(2).map((p) => `${p.owner_id}_${p.id}`) },
      ],
    },
    audios: CATALOG.slice(18, 36).map(withUrl),
    playlists: REC_PLAYLISTS,
  }
}

export async function mockCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  await sleep(120 + Math.random() * 260)
  const owner = Number(params.owner_id ?? ME)
  switch (method) {
    case 'users.get':
      return [{ id: ME, first_name: 'Демо', last_name: 'Режим', photo_200: avatar(99, 'ДР') }]
    case 'friends.get':
      return { count: FRIENDS.length, items: FRIENDS }
    case 'audio.get': {
      if (params.playlist_id) {
        const n = Number(params.playlist_id)
        return page(CATALOG.slice(n % 7, (n % 7) + 30).map(withUrl), params)
      }
      if (owner === ME) return page(MY.filter((a) => !removed.has(`${a.owner_id}_${a.id}`)).map(withUrl), params)
      const fr = FRIENDS.find((f) => f.id === owner)
      if (fr && !fr.can_see_audio) throw { kind: 'vk', code: 201, message: 'Access denied: no access to audio' }
      return page(CATALOG.slice(owner % 10, (owner % 10) + 25).map(withUrl), params)
    }
    case 'audio.getById': {
      const keys = String(params.audios).split(',').map((k) => k.split('_').slice(0, 2).join('_'))
      return [...MY, ...CATALOG].filter((a) => keys.includes(`${a.owner_id}_${a.id}`)).map(withUrl)
    }
    case 'audio.search': {
      const q = String(params.q ?? '').toLowerCase()
      return page([...CATALOG, ...MY].filter((a) => `${a.artist} ${a.title}`.toLowerCase().includes(q)).map(withUrl), params)
    }
    case 'audio.getStreamMixAudios':
      return CATALOG.slice(0, Number(params.count ?? 20))
        .map((a, i) => CATALOG[(i * 7 + Math.floor(Math.random() * 48)) % 48] ?? a)
        .map(withUrl)
    case 'audio.getAudiosByArtist':
      return page([...CATALOG, ...MY].filter((a) => a.main_artists?.some((m) => m.id === params.artist_id)).map(withUrl), params)
    case 'audio.getLyrics':
      return {
        lyrics: {
          language: 'ru',
          timestamps: Array.from({ length: 16 }, (_, i) => ({ line: `Демонстрационная строка ${i + 1}`, begin: 2000 + i * 2400, end: 4200 + i * 2400 })),
        },
        credits: 'Демо-режим: текст-заглушка',
      }
    case 'audio.getPlaylists':
      return owner === ME ? { count: MY_PLAYLISTS.length, items: MY_PLAYLISTS } : { count: 2, items: REC_PLAYLISTS.slice(0, 2) }
    case 'audio.getPlaylistById':
      return [...MY_PLAYLISTS, ...REC_PLAYLISTS].find((p) => p.id === Number(params.playlist_id)) ?? REC_PLAYLISTS[0]
    case 'audio.searchPlaylists':
    case 'audio.searchAlbums':
      return { count: REC_PLAYLISTS.length, items: REC_PLAYLISTS }
    case 'catalog.getAudio':
      return catalogResponse()
    case 'catalog.getSection':
      return exploreResponse()
    case 'audio.add':
      return 99999
    case 'audio.delete':
      removed.add(`${params.owner_id}_${params.audio_id}`)
      return 1
    case 'audio.restore':
      removed.delete(`${params.owner_id}_${params.audio_id}`)
      return 1
    case 'audio.createPlaylist': {
      const p = playlist(MY_PLAYLISTS.length + 20, ME, String(params.title), 0, { description: String(params.description ?? '') })
      MY_PLAYLISTS.unshift(p)
      return p
    }
    case 'audio.editPlaylist': {
      const p = MY_PLAYLISTS.find((x) => x.id === Number(params.playlist_id))
      if (p) Object.assign(p, { title: params.title, description: params.description })
      return 1
    }
    case 'audio.deletePlaylist': {
      const i = MY_PLAYLISTS.findIndex((x) => x.id === Number(params.playlist_id))
      if (i >= 0) MY_PLAYLISTS.splice(i, 1)
      return 1
    }
    case 'audio.followPlaylist':
      return { playlist_id: 777, owner_id: ME }
    case 'audio.addToPlaylist':
    case 'audio.removeFromPlaylist':
    case 'audio.setBroadcast':
      return 1
    default:
      throw { kind: 'vk', code: 3, message: `Unknown method passed: ${method}` }
  }
}
