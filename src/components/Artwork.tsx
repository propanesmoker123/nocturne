import { useState, type CSSProperties } from 'react'
import { IconNote } from './Icons'
import s from './controls.module.css'

const PALETTES: [string, string][] = [
  ['#5e5ce6', '#bf5af2'],
  ['#ff375f', '#ff9f0a'],
  ['#0a84ff', '#40cbe0'],
  ['#30d158', '#0a84ff'],
  ['#bf5af2', '#ff375f'],
  ['#ff9f0a', '#ffd60a'],
  ['#64d2ff', '#5e5ce6'],
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function fallbackGradient(seed: string): string {
  const [a, b] = PALETTES[hash(seed) % PALETTES.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

interface ArtworkProps {
  src?: string
  mosaic?: string[]
  size: number | string
  radius?: number | string
  seed?: string
  alt?: string
  className?: string
  style?: CSSProperties
}

export function Artwork({ src, mosaic, size, radius, seed = '', alt = '', className, style }: ArtworkProps) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const dim = typeof size === 'number' ? `${size}px` : size
  const rad = radius === undefined ? undefined : typeof radius === 'number' ? `${radius}px` : radius
  const showImg = !!src && failed !== src
  const mosaicFallback = !showImg && mosaic && mosaic.length > 0 && mosaic.length < 4 && failed !== mosaic[0] ? mosaic[0] : undefined
  const activeSrc = showImg ? src : mosaicFallback
  const tiles = !activeSrc && mosaic && mosaic.length >= 4 ? mosaic.slice(0, 4) : null

  return (
    <div
      className={[s.art, className].filter(Boolean).join(' ')}
      style={{ ...style, ['--size' as string]: dim, ...(rad ? { ['--radius' as string]: rad } : null) }}
    >
      {activeSrc ? (
        <img
          src={activeSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          data-loaded={loaded === activeSrc || undefined}
          onLoad={() => setLoaded(activeSrc)}
          onError={() => setFailed(activeSrc)}
        />
      ) : tiles ? (
        <div className={s.artMosaic}>
          {tiles.map((t, idx) => (
            <img key={`${t}-${idx}`} src={t} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} />
          ))}
        </div>
      ) : (
        <div className={s.artFallback} style={{ background: fallbackGradient(seed || alt) }}>
          <IconNote />
        </div>
      )}
    </div>
  )
}
