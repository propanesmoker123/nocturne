export function formatTime(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function compact(value: number, suffix: string): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rounded).replace('.', ',')}${suffix}`
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return compact(n / 1_000_000, 'M')
  if (n >= 1000) return compact(n / 1000, 'K')
  return String(n)
}

/** Plays on a card: «345», «1,5 тыс.», «1,2 млн». */
export function formatPlaysShort(n: number): string {
  if (n >= 1_000_000_000) return compact(n / 1_000_000_000, ' млрд')
  if (n >= 1_000_000) return compact(n / 1_000_000, ' млн')
  if (n >= 1000) return compact(n / 1000, ' тыс.')
  return String(n)
}

/** Plays on an album page: «1 прослушивание», «1,2 млн прослушиваний». */
export function formatPlays(n: number): string {
  if (n >= 1000) return `${formatPlaysShort(n)} прослушиваний`
  return `${n} ${pluralRu(n, 'прослушивание', 'прослушивания', 'прослушиваний')}`
}

/** «Исполнитель — Название (подзаголовок VK)»: what a click on a track title copies. */
export function fullTrackName(t: { artist: string; title: string; subtitle?: string }): string {
  return `${t.artist} — ${t.title}${t.subtitle ? ` (${t.subtitle})` : ''}`
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return many
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

export function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

export function filterTracks<T extends { title: string; artist: string }>(list: T[], q: string): T[] {
  const words = normalizeSearch(q).split(' ').filter(Boolean)
  if (words.length === 0) return list
  return list.filter((t) => {
    const hay = normalizeSearch(`${t.title} ${t.artist}`)
    return words.every((w) => hay.includes(w))
  })
}

/** Total running time for list headers: "42 мин", "1 ч 12 мин", "2 ч". */
export function formatLongDuration(sec: number): string {
  const minutes = Math.floor(Math.max(0, sec) / 60)
  if (minutes < 60) return `${minutes} мин`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} ч ${m} мин` : `${h} ч`
}
