export type HotkeyAction =
  | 'playPause'
  | 'next'
  | 'prev'
  | 'volUp'
  | 'volDown'
  | 'toggleLike'
  | 'seekFwd'
  | 'seekBack'
  | 'shuffle'
  | 'repeat'
  | 'toggleIsland'
  | 'toggleWindow'

export type HotkeyMap = Record<HotkeyAction, string>

export const DEFAULT_HOTKEYS: HotkeyMap = {
  playPause: 'Ctrl+Alt+Space',
  next: 'Ctrl+Alt+Right',
  prev: 'Ctrl+Alt+Left',
  volUp: 'Ctrl+Alt+Up',
  volDown: 'Ctrl+Alt+Down',
  toggleLike: 'Ctrl+Alt+L',
  seekFwd: 'Ctrl+Alt+Shift+Right',
  seekBack: 'Ctrl+Alt+Shift+Left',
  shuffle: 'Ctrl+Alt+S',
  repeat: 'Ctrl+Alt+R',
  toggleIsland: 'Ctrl+Alt+I',
  toggleWindow: 'Ctrl+Alt+M',
}

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  playPause: 'Пауза / воспроизведение',
  next: 'Следующий трек',
  prev: 'Предыдущий трек',
  volUp: 'Громче',
  volDown: 'Тише',
  toggleLike: 'В мои аудио / убрать',
  seekFwd: 'Перемотка вперёд на 10 с',
  seekBack: 'Перемотка назад на 10 с',
  shuffle: 'Перемешать',
  repeat: 'Повтор',
  toggleIsland: 'Показать / скрыть остров',
  toggleWindow: 'Показать / скрыть приложение',
}

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
])

const NAMED_CODES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: 'Minus',
  Equal: 'Equal',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Backquote',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
}

const MEDIA_CODES = new Set(['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'])

function keyName(code: string): { name: string; standalone: boolean } | null {
  if (/^Key[A-Z]$/.test(code)) return { name: code.slice(3), standalone: false }
  if (/^Digit[0-9]$/.test(code)) return { name: code.slice(5), standalone: false }
  if (/^Numpad[0-9]$/.test(code)) return { name: code, standalone: false }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return { name: code, standalone: true }
  if (MEDIA_CODES.has(code)) return { name: code, standalone: true }
  if (code in NAMED_CODES) return { name: NAMED_CODES[code], standalone: false }
  return null
}

/** Converts a keydown event into a Tauri accelerator string, or null if it is not a usable global hotkey. */
export function eventToAccelerator(e: KeyLike): string | null {
  if (MODIFIER_CODES.has(e.code)) return null
  const key = keyName(e.code)
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (mods.length === 0 && !key.standalone) return null
  return [...mods, key.name].join('+')
}

const PRETTY: Record<string, string> = { Right: '→', Left: '←', Up: '↑', Down: '↓', Super: 'Win' }

export function prettyAccelerator(acc: string): string {
  return acc
    .split('+')
    .filter(Boolean)
    .map((part) => PRETTY[part] ?? part)
    .join(' ')
}

export function findDuplicateHotkeys(map: HotkeyMap): HotkeyAction[] {
  const byAcc = new Map<string, HotkeyAction[]>()
  for (const [action, acc] of Object.entries(map) as [HotkeyAction, string][]) {
    if (!acc) continue
    const key = acc.toLowerCase()
    byAcc.set(key, [...(byAcc.get(key) ?? []), action])
  }
  return [...byAcc.values()].filter((actions) => actions.length > 1).flat()
}
