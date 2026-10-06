import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { resample } from '../player/peaks'
import { useWaveform } from '../player/waveform'
import s from './Waveform.module.css'

interface WaveformProps {
  /** Key of the track on screen: peaks of another track are never drawn. */
  trackKey: string | undefined
  /** 0..1 */
  value: number
  buffered: number
  height: number
  label: string
  valueText?: (v: number) => string
  step?: number
  disabled?: boolean
  onChange?: (v: number) => void
  onCommit?: (v: number) => void
}

const BAR = 2
const GAP = 1
/** Upper bars take this share of the height; the rest is the soft reflection below. */
const UPPER = 0.68
const clamp = (v: number) => Math.min(1, Math.max(0, v))

/** Seek bar drawn as the track's real waveform, SoundCloud-style, in the app accent. */
export function WaveformScrubber({ trackKey, value, buffered, height, label, valueText, step = 0.02, disabled, onChange, onCommit }: WaveformProps) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const peaks = useWaveform((w) => (w.key === trackKey ? w.peaks : null))
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const shown = clamp(drag ?? value)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(width * dpr)
    c.height = Math.round(height * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)

    const css = getComputedStyle(c)
    const accent = css.getPropertyValue('--accent').trim() || '#ff375f'
    const bars = Math.max(1, Math.floor((width + GAP) / (BAR + GAP)))
    const levels = resample(peaks, bars)
    const upperH = Math.round(height * UPPER)
    const lowerH = height - upperH - 1

    for (let i = 0; i < bars; i++) {
      const at = (i + 0.5) / bars
      const lv = levels[i] < 0 ? 0.05 : 0.07 + 0.93 * levels[i]
      const played = at <= shown
      const hovered = hover !== null && at <= hover
      g.fillStyle = played ? accent : '#fff'
      g.globalAlpha = played ? 1 : hovered ? 0.62 : at <= buffered ? 0.4 : 0.2
      const x = i * (BAR + GAP)
      const up = Math.max(1, lv * upperH)
      g.fillRect(x, upperH - up, BAR, up)
      g.globalAlpha *= 0.42
      g.fillRect(x, upperH + 1, BAR, Math.max(1, lv * lowerH))
    }
    g.globalAlpha = 1
  }, [peaks, width, height, shown, buffered, hover])

  const fromEvent = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return clamp((e.clientX - r.left) / r.width)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, number> = { ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step, Home: 0, End: 1 }
    if (!(e.key in map)) return
    e.preventDefault()
    e.stopPropagation()
    onCommit?.(clamp(map[e.key]))
  }

  return (
    <div
      ref={box}
      className={s.wave}
      style={{ height }}
      data-disabled={disabled || undefined}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={valueText?.(shown)}
      aria-disabled={disabled || undefined}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const v = fromEvent(e)
        setDrag(v)
        onChange?.(v)
      }}
      onPointerMove={(e) => {
        const v = fromEvent(e)
        if (!disabled) setHover(v)
        if (drag === null) return
        setDrag(v)
        onChange?.(v)
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(e) => {
        if (drag === null) return
        const v = fromEvent(e)
        setDrag(null)
        onCommit?.(v)
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} className={s.canvas} style={{ width, height }} aria-hidden="true" />
    </div>
  )
}
