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
