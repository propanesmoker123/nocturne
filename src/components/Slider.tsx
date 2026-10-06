import { useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import s from './Slider.module.css'

interface SliderProps {
  /** 0..1 */
  value: number
  buffered?: number
  onChange?: (v: number) => void
  onCommit?: (v: number) => void
  label: string
  valueText?: (v: number) => string
  step?: number
  wheelStep?: number
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
  tone?: 'light' | 'accent'
  className?: string
}

const clamp = (v: number) => Math.min(1, Math.max(0, v))

export function Slider({
  value,
  buffered,
  onChange,
  onCommit,
  label,
  valueText,
  step = 0.05,
  wheelStep,
  disabled,
  size = 'md',
  tone = 'light',
  className,
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = clamp(drag ?? value)

  const fromEvent = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return clamp((e.clientX - r.left) / r.width)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const v = fromEvent(e)
    setDrag(v)
    onChange?.(v)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return
    const v = fromEvent(e)
    setDrag(v)
    onChange?.(v)
  }
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return
    const v = fromEvent(e)
    setDrag(null)
    onCommit?.(v)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      PageUp: value + step * 4,
      PageDown: value - step * 4,
      Home: 0,
      End: 1,
    }
    if (!(e.key in map)) return
    e.preventDefault()
    e.stopPropagation()
    onCommit?.(clamp(map[e.key]))
  }

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!wheelStep || disabled) return
    onCommit?.(clamp(value + (e.deltaY < 0 ? wheelStep : -wheelStep)))
  }

  return (
    <div
      ref={ref}
      className={[s.slider, className].filter(Boolean).join(' ')}
      data-size={size}
      data-tone={tone}
      data-dragging={drag !== null || undefined}
      data-disabled={disabled || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={valueText?.(shown)}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      <div className={s.track}>
        {buffered !== undefined && <div className={s.buffered} style={{ width: `${clamp(buffered) * 100}%` }} />}
        <div className={s.fill} style={{ width: `${shown * 100}%` }} />
      </div>
    </div>
  )
}
