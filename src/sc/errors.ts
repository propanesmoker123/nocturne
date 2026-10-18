/** What a SoundCloud request failure says to the person. Rust sends `{ kind, status?, message? }`. */

export const SC_UNREACHABLE = 'SoundCloud не отвечает — без VPN он в России не играет'

export type ScErrorKind = 'signedOut' | 'http' | 'network' | 'invalid'

const KINDS: ScErrorKind[] = ['signedOut', 'http', 'network', 'invalid']

export class ScApiError extends Error {
  readonly kind: ScErrorKind
  readonly status?: number

  constructor(kind: ScErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ScApiError'
    this.kind = kind
    this.status = status
  }

  static from(raw: unknown): ScApiError {
    if (raw instanceof ScApiError) return raw
    if (raw && typeof raw === 'object') {
      const r = raw as { kind?: unknown; status?: unknown; message?: unknown }
      const kind = KINDS.includes(r.kind as ScErrorKind) ? (r.kind as ScErrorKind) : 'invalid'
      const status = typeof r.status === 'number' ? r.status : undefined
      return new ScApiError(kind, typeof r.message === 'string' ? r.message : String(r.kind ?? 'error'), status)
    }
    return new ScApiError('invalid', String(raw))
  }
}

export function describeScError(e: unknown): string {
  const err = ScApiError.from(e)
  switch (err.kind) {
    case 'signedOut':
      return 'Войдите в SoundCloud'
    case 'network':
      return SC_UNREACHABLE
    case 'http':
      if (err.status === 404) return 'Не найдено в SoundCloud'
      if (err.status === 429) return 'SoundCloud просит подождать — попробуйте через минуту'
      return `SoundCloud ответил ошибкой ${err.status ?? ''}`.trim()
    default:
      return 'SoundCloud ответил что-то непонятное'
  }
}
