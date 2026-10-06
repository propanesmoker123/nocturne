import type { SVGProps } from 'react'

// Filled transport glyphs drawn after SF Symbols proportions (24×24 grid).
// Generic UI icons come from lucide-react with a matching 1.9 stroke.

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path fill="currentColor" d="M7 4.9v14.2c0 1 1.1 1.6 1.9 1.1L20 13.1c.8-.5.8-1.7 0-2.2L8.9 3.8C8.1 3.3 7 3.9 7 4.9z" />
    </Svg>
  )
}

export function IconPause(p: IconProps) {
  return (
    <Svg {...p}>
      <rect fill="currentColor" x="5.5" y="4" width="4.6" height="16" rx="1.4" />
      <rect fill="currentColor" x="13.9" y="4" width="4.6" height="16" rx="1.4" />
    </Svg>
  )
}

const FORWARD = 'M2.4 6.3v11.4c0 .9 1 1.4 1.7.9l8.2-5.7c.6-.4.6-1.4 0-1.8L4.1 5.4c-.7-.5-1.7 0-1.7.9zM12 6.3v11.4c0 .9 1 1.4 1.7.9l8.2-5.7c.6-.4.6-1.4 0-1.8l-8.2-5.7c-.7-.5-1.7 0-1.7.9z'

export function IconForward(p: IconProps) {
  return (
    <Svg {...p}>
      <path fill="currentColor" d={FORWARD} />
    </Svg>
  )
}

export function IconBackward(p: IconProps) {
  return (
    <Svg {...p}>
      <path fill="currentColor" d={FORWARD} transform="matrix(-1 0 0 1 24 0)" />
    </Svg>
  )
}

export function IconShuffle(p: IconProps) {
  return (
    <Svg {...p}>
      <g {...stroke}>
        <path d="M3 7h3.2c1.7 0 3.2.9 4.1 2.3l3.4 5.4c.9 1.4 2.4 2.3 4.1 2.3H21" />
        <path d="M3 17h3.2c1.7 0 3.2-.9 4.1-2.3l.3-.5M13.4 9.8l.3-.5C14.6 7.9 16.1 7 17.8 7H21" />
        <path d="M18.6 4.6 21 7l-2.4 2.4M18.6 14.6 21 17l-2.4 2.4" />
      </g>
    </Svg>
  )
}

export function IconRepeat(p: IconProps & { one?: boolean }) {
  const { one, ...rest } = p
  return (
    <Svg {...rest}>
      <g {...stroke}>
        <path d="M4 11.5V10a3.8 3.8 0 0 1 3.8-3.8H20" />
        <path d="M17.3 3.5 20 6.2l-2.7 2.7" />
        <path d="M20 12.5V14a3.8 3.8 0 0 1-3.8 3.8H4" />
        <path d="M6.7 20.5 4 17.8l2.7-2.7" />
        {one && <path d="M11 10.6l1.5-1v5" strokeWidth={1.8} />}
      </g>
    </Svg>
  )
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} strokeWidth={2.2} d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path {...stroke} strokeWidth={2.3} d="M5 12.6l4.4 4.4L19 7.4" />
    </Svg>
  )
}

export function IconMore(p: IconProps) {
  return (
    <Svg {...p}>
      <circle fill="currentColor" cx="5.5" cy="12" r="1.9" />
      <circle fill="currentColor" cx="12" cy="12" r="1.9" />
      <circle fill="currentColor" cx="18.5" cy="12" r="1.9" />
    </Svg>
  )
}

const SPEAKER = 'M3.4 9.3v5.4c0 .7.5 1.2 1.2 1.2h2.5l4 3.5c.8.7 2 .1 2-.9V5.5c0-1-1.2-1.6-2-.9l-4 3.5H4.6c-.7 0-1.2.5-1.2 1.2z'

export function IconSpeaker({ level = 3, ...p }: IconProps & { level?: 0 | 1 | 2 | 3 }) {
  return (
    <Svg {...p}>
      <path fill="currentColor" d={SPEAKER} />
      {level === 0 ? (
        <path {...stroke} strokeWidth={1.9} d="M16.4 9.6l4.8 4.8M21.2 9.6l-4.8 4.8" />
      ) : (
        <g {...stroke} strokeWidth={1.9}>
          <path d="M15.8 9.6c.7.6 1.1 1.5 1.1 2.4s-.4 1.8-1.1 2.4" />
          {level >= 2 && <path d="M18.2 7.4c1.3 1.2 2 2.8 2 4.6s-.7 3.4-2 4.6" opacity={level >= 2 ? 1 : 0.3} />}
          {level >= 3 && <path d="M20.5 5.2c1.8 1.8 2.8 4.2 2.8 6.8s-1 5-2.8 6.8" opacity={0.9} />}
        </g>
      )}
    </Svg>
  )
}

export function IconQueue(p: IconProps) {
  return (
    <Svg {...p}>
      <g {...stroke} strokeWidth={1.9}>
        <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      </g>
      <circle fill="currentColor" cx="4.6" cy="6.5" r="1.4" />
      <circle fill="currentColor" cx="4.6" cy="12" r="1.4" />
      <circle fill="currentColor" cx="4.6" cy="17.5" r="1.4" />
    </Svg>
  )
}

export function IconLyrics(p: IconProps) {
  return (
    <Svg {...p}>
      <g {...stroke} strokeWidth={1.9}>
        <path d="M5.2 4.8h13.6a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2h-5.6L8.6 20.6v-3.2H5.2A2.2 2.2 0 0 1 3 15.2V7a2.2 2.2 0 0 1 2.2-2.2z" />
        <path d="M7.4 9.4h9.2M7.4 12.8h6" />
      </g>
    </Svg>
  )
}

export function IconNote(p: IconProps) {
  return (
    <Svg {...p}>
      <path
        fill="currentColor"
        d="M18.9 3.6v11.6a2.9 2.9 0 1 1-2-2.8V8.2l-7.5 1.6v8a2.9 2.9 0 1 1-2-2.8V6.5c0-.6.4-1.1 1-1.2l9.1-2c.8-.2 1.4.4 1.4 1.1z"
      />
    </Svg>
  )
}

export function IconIsland(p: IconProps) {
  return (
    <Svg {...p}>
      <rect {...stroke} strokeWidth={1.9} x="2.5" y="4" width="19" height="16" rx="3.5" />
      <rect fill="currentColor" x="7.5" y="6.6" width="9" height="3" rx="1.5" />
    </Svg>
  )
}
