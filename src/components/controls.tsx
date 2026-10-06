import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { motion } from 'motion/react'
import s from './controls.module.css'

type Btn = ButtonHTMLAttributes<HTMLButtonElement>

export function IconButton({
  size = 34,
  plain,
  active,
  label,
  className,
  style,
  children,
  ...rest
}: Btn & { size?: number; plain?: boolean; active?: boolean; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[s.iconButton, className].filter(Boolean).join(' ')}
      data-plain={plain || undefined}
      data-active={active || undefined}
      style={{ ...style, ['--size' as string]: `${size}px` }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Button({
  variant = 'gray',
  size,
  className,
  children,
  ...rest
}: Btn & { variant?: 'primary' | 'tinted' | 'gray' | 'danger'; size?: 'lg'; children: ReactNode }) {
  return (
    <button type="button" className={[s.button, className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} {...rest}>
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={s.switch}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  id: string
}) {
  return (
    <div className={s.segmented} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={s.segment} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className={s.segmentThumb} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 20, style }: { size?: number; style?: CSSProperties }) {
  return (
    <span className={s.spinner} style={{ ...style, ['--size' as string]: `${size}px` }} role="progressbar" aria-label="Загрузка">
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${-0.9 + i * 0.1125}s` }} />
      ))}
    </span>
  )
}

export function EqualizerBars({
  playing,
  bars = 3,
  height = 14,
  width = 3,
  gap = 2,
  color,
}: {
  playing: boolean
  bars?: number
  height?: number
  width?: number
  gap?: number
  color?: string
}) {
  return (
    <span
      className={s.eq}
      data-playing={playing || undefined}
      aria-hidden="true"
      style={{
        ['--h' as string]: `${height}px`,
        ['--w' as string]: `${width}px`,
        ['--gap' as string]: `${gap}px`,
        ...(color ? { ['--eq-color' as string]: color } : null),
      }}
    >
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}
