import { useEffect, useState } from 'react'
import { eventToAccelerator, prettyAccelerator } from '../lib/hotkeys'
import s from '../pages/Settings.module.css'

interface Props {
  value: string
  conflict?: boolean
  failed?: boolean
  onChange(acc: string): void
  label: string
}

/** Click, then press a key combination. Backspace clears, Escape cancels. */
export function HotkeyInput({ value, conflict, failed, onChange, label }: Props) {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setListening(false)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        onChange('')
        setListening(false)
        return
      }
      const acc = eventToAccelerator(e)
      if (acc) {
        onChange(acc)
        setListening(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, onChange])

  return (
    <button
      type="button"
      className={s.kbd}
      aria-label={`${label}: ${value ? prettyAccelerator(value) : 'не назначено'}`}
      data-listening={listening || undefined}
      data-conflict={conflict || failed || undefined}
      title={failed ? 'Сочетание занято другой программой' : conflict ? 'Это сочетание уже назначено другому действию' : 'Нажмите, чтобы изменить'}
      onClick={() => setListening((v) => !v)}
      onBlur={() => setListening(false)}
    >
      {listening ? 'Нажмите сочетание…' : value ? prettyAccelerator(value) : 'Не назначено'}
    </button>
  )
}
