import type { WallpaperConfig, WallpaperPreset } from '../lib/settings'
import { wallpaperUrl } from '../lib/wallpaper'
import { usePlayer } from '../player/store'
import { useEffect, useRef } from 'react'
import s from './Wallpaper.module.css'

export const PRESETS: Record<WallpaperPreset, { name: string; colors: [string, string, string] }> = {
  aurora: { name: 'Северное сияние', colors: ['#1fd1a5', '#5e5ce6', '#0a84ff'] },
  dusk: { name: 'Сумерки', colors: ['#ff375f', '#bf5af2', '#ff9f0a'] },
  ocean: { name: 'Глубина', colors: ['#0a84ff', '#40cbe0', '#1c3faa'] },
  ember: { name: 'Угли', colors: ['#ff453a', '#ff9f0a', '#7a1fa2'] },
}

export interface WallpaperLook {
  blur: number
  dim: number
}

function DynamicArt() {
  const src = usePlayer((p) => p.current?.cover?.m)
  if (!src) return <PresetLayer preset="dusk" />
  return (
    <div className={s.dynamic} aria-hidden="true">
      <img key={`a-${src}`} src={src} alt="" referrerPolicy="no-referrer" />
      <img key={`b-${src}`} src={src} alt="" referrerPolicy="no-referrer" />
    </div>
  )
}

export function PresetLayer({ preset }: { preset: WallpaperPreset }) {
  const [a, b, c] = PRESETS[preset].colors
  return (
    <div className={s.preset} aria-hidden="true">
      <i style={{ background: a }} />
      <i style={{ background: b }} />
      <i style={{ background: c }} />
    </div>
  )
}

/** Muted looping video that pauses while the window is hidden (saves GPU). */
function WallpaperVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const sync = () => (document.hidden ? v.pause() : void v.play().catch(() => {}))
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return <video ref={ref} className={s.media} src={src} autoPlay loop muted playsInline disablePictureInPicture />
}

export function Wallpaper({ config, look }: { config: WallpaperConfig; look: WallpaperLook }) {
  const vars = { ['--wp-blur' as string]: `${look.blur}px`, ['--wp-dim' as string]: String(look.dim) }
  return (
    <div className={s.layer} style={vars} aria-hidden="true">
      {config.kind === 'dynamic' && <DynamicArt />}
      {config.kind === 'preset' && <PresetLayer preset={config.preset} />}
      {config.kind === 'image' && <img className={s.media} src={wallpaperUrl(config.src)} alt="" />}
      {config.kind === 'video' && <WallpaperVideo src={wallpaperUrl(config.src)} />}
      {config.kind !== 'none' && <div className={s.dim} />}
      <div className={s.vignette} />
    </div>
  )
}
