import type { IslandProgress } from '../lib/settings'
import { roundedPath } from '../island/shapes'
import s from './IslandProgressPicker.module.css'

const OPTIONS: { value: IslandProgress; label: string }[] = [
  { value: 'ring', label: 'Рамка' },
  { value: 'outline', label: 'Контур' },
  { value: 'fill', label: 'Заливка' },
  { value: 'bar', label: 'Полоска' },
  { value: 'off', label: 'Выкл' },
]

/** Mini island used in the tiles, same proportions as the real compact pill (200 × 36). */
const W = 78
const H = 22
const PILL = roundedPath(0.6, 0.6, W - 1.2, H - 1.2, H / 2 - 0.6)
const RING = roundedPath(2.2, 2.2, 17.6, 17.6, 5.5)
const SHOWN = 62

function MiniIsland({ style }: { style: IslandProgress }) {
  const ring = style === 'ring'
  const art = ring ? { x: 5, y: 5, size: 12, r: 3.4 } : { x: 3.5, y: 3.5, size: 15, r: 4.2 }
  return (
    <svg className={s.mini} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs>
        <linearGradient id={`art-${style}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#bf5af2" />
          <stop offset="1" stopColor="#ff375f" />
        </linearGradient>
        <clipPath id={`pill-${style}`}>
          <path d={PILL} />
        </clipPath>
      </defs>
      <path d={PILL} fill="#000" stroke="rgba(255,255,255,.12)" strokeWidth=".6" />
      {style === 'fill' && (
        <g clipPath={`url(#pill-${style})`}>
          <rect className={s.fill} x="0" y="0" width={W} height={H} style={{ transform: `scaleX(${SHOWN / 100})` }} />
        </g>
      )}
      {style === 'outline' && <path className={s.stroke} d={PILL} pathLength={100} strokeWidth="1.2" strokeDasharray={`${SHOWN} 100`} />}
      {ring && (
        <>
          <path d={RING} fill="none" stroke="rgba(255,255,255,.16)" strokeWidth="1.1" />
          <path className={s.stroke} d={RING} pathLength={100} strokeWidth="1.1" strokeDasharray={`${SHOWN} 100`} />
        </>
      )}
      <rect x={art.x} y={art.y} width={art.size} height={art.size} rx={art.r} fill={`url(#art-${style})`} />
      {style === 'bar' && (
        <>
          <path className={s.stroke} d="M 24 11 H 56" pathLength={100} strokeWidth="1.8" strokeDasharray={`${SHOWN} 100`} />
          <circle className={s.dot} cx={24 + (32 * SHOWN) / 100} cy="11" r="1.7" />
        </>
      )}
      <g className={s.eq}>
        <rect x="64" y="8" width="2" height="7" rx=".6" />
        <rect x="67.5" y="6" width="2" height="9" rx=".6" />
        <rect x="71" y="9.5" width="2" height="5.5" rx=".6" />
      </g>
    </svg>
  )
}

/** Choice of how the compact island shows the track position, as little islands rather than words. */
export function IslandProgressPicker({ value, onChange }: { value: IslandProgress; onChange(v: IslandProgress): void }) {
  return (
    <div className={s.tiles} role="radiogroup" aria-label="Прогресс трека">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={s.tile} onClick={() => onChange(o.value)}>
          <MiniIsland style={o.value} />
          <span className={s.label}>{o.label}</span>
        </button>
      ))}
    </div>
  )
}
