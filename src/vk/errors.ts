export type VkErrorKind = 'vk' | 'auth' | 'network' | 'invalid'

interface Payload {
  kind?: string
  code?: number
  message?: string
  captchaSid?: string
  captchaImg?: string
  redirectUri?: string
}

const ACCESS_DENIED = new Set([15, 18, 30, 201, 203])

export class VkError extends Error {
  readonly kind: VkErrorKind
  readonly code?: number
  readonly captchaSid?: string
  readonly captchaImg?: string
  readonly redirectUri?: string

  constructor(kind: VkErrorKind, message: string, code?: number, extra: Pick<Payload, 'captchaSid' | 'captchaImg' | 'redirectUri'> = {}) {
    super(message)
    this.name = 'VkError'
    this.kind = kind
    this.code = code
    this.captchaSid = extra.captchaSid
    this.captchaImg = extra.captchaImg
    this.redirectUri = extra.redirectUri
  }

  static from(e: unknown): VkError {
    if (e instanceof VkError) return e
    if (e instanceof Error) return new VkError('network', e.message)
    if (typeof e === 'string') return new VkError('network', e)
    if (e && typeof e === 'object') {
      const p = e as Payload
      const kind = (['vk', 'auth', 'network', 'invalid'] as const).find((k) => k === p.kind) ?? 'network'
      return new VkError(kind, p.message ?? 'Неизвестная ошибка', p.code, p)
    }
    return new VkError('network', String(e))
  }

  get isCaptcha(): boolean {
    return this.kind === 'vk' && this.code === 14
  }

  get isAuth(): boolean {
    return this.kind === 'auth'
  }

  get isAccessDenied(): boolean {
    return this.kind === 'vk' && this.code !== undefined && ACCESS_DENIED.has(this.code)
  }
}

export function describeError(e: unknown): string {
  const err = VkError.from(e)
  if (err.kind === 'auth') return 'Сессия VK закончилась — войдите снова'
  if (err.kind === 'network') return 'Нет связи с VK. Проверьте интернет и повторите'
  if (err.kind === 'invalid') return 'Приложение отправило неверный запрос'
  if (err.isAccessDenied) return 'Пользователь скрыл свои аудиозаписи'
  switch (err.code) {
    case 9:
      return 'VK просит передохнуть: слишком много действий подряд'
    case 14:
      return 'VK попросил подтвердить, что вы не робот'
    case 3:
    case 1:
      return 'VK временно не даёт выполнить это действие'
    case 6:
    case 10:
      return 'VK перегружен, попробуйте чуть позже'
    default:
      return `VK ответил ошибкой: ${err.message}`
  }
}
