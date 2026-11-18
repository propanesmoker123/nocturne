import { useEffect, useRef, type RefObject } from 'react'
import { parseCssRgb } from '../lib/color'
import { useWindowVisibility } from '../lib/windowVisibility'
import { engine } from '../player/engine'
import { useWaveform } from '../player/waveformStore'
import { sampleBeatAt, stepBeatEnvelope } from './beats'
import type { FxVariant, WordFx } from './effects'

export interface WordBurst {
  x: number
  y: number
  fx: WordFx
  variant: FxVariant
}

export type ParticlesMode = 'ambient' | 'sparks'

interface Props {
  enabled: boolean
  playing: boolean
  mode?: ParticlesMode
  trackKey?: string | null
  duration?: number
  burstsRef?: RefObject<WordBurst[]>
  className?: string
}

interface BokehOrb {
  nx: number
  ny: number
  r: number
  vx: number
  vy: number
  alpha: number
  phase: number
  warm: boolean
}

interface Ember {
  nx: number
  ny: number
  r: number
  vy: number
  sway: number
  alpha: number
  phase: number
  accented: boolean
}

interface WordSpark {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  life: number
  maxLife: number
  rgb: readonly [number, number, number]
  kind: 'orb' | 'star' | 'drop'
  gravity: number
  drag: number
  spin: number
}

const FX_RGB: Record<WordFx, readonly [number, number, number]> = {
  flash: [255, 250, 210],
  glow: [253, 224, 71],
  metal: [226, 232, 240],
  neon: [232, 121, 249],
  rush: [56, 189, 248],
  ripple: [165, 180, 252],
  big: [254, 240, 138],
  fire: [255, 118, 28],
  ice: [147, 229, 255],
  rain: [96, 165, 250],
  heart: [251, 113, 133],
  shake: [248, 113, 113],
  glitch: [34, 211, 238],
  cash: [52, 211, 153],
  smoke: [226, 232, 240],
  slash: [251, 113, 133],
  orbit: [192, 132, 252],
  bounce: [250, 204, 21],
  fade: [203, 213, 225],
  poison: [163, 230, 53],
}

const FX_ALT_RGB: Partial<Record<WordFx, readonly [number, number, number]>> = {
  cash: [253, 224, 71],
  neon: [56, 189, 248],
  glitch: [244, 114, 182],
  poison: [168, 85, 247],
  fire: [255, 214, 102],
  orbit: [56, 189, 248],
  heart: [254, 205, 211],
}

const STAR_FX = new Set<WordFx>(['cash', 'flash', 'glow', 'ice', 'metal', 'big', 'orbit'])

function readAccentRgb(el: HTMLElement): [number, number, number] {
  const parsed = parseCssRgb(getComputedStyle(el).getPropertyValue('--accent'))
  return parsed ? [parsed.r, parsed.g, parsed.b] : [255, 84, 118]
}

function spawnWordSparks(out: WordSpark[], burst: WordBurst): void {
  if (out.length >= 68) out.splice(0, out.length - 56)
  const count = burst.variant === 3 ? 7 : 4
  const primary = FX_RGB[burst.fx] ?? [255, 255, 255]
  const alt = FX_ALT_RGB[burst.fx] ?? primary
  const isDrop = burst.fx === 'rain'
  const isStar = STAR_FX.has(burst.fx)
  const isRise = burst.fx === 'fire' || burst.fx === 'cash' || burst.fx === 'smoke' || burst.fx === 'heart' || burst.fx === 'poison'

  for (let i = 0; i < count; i++) {
    const spread = (Math.random() - 0.5) * 64
    const baseAngle = isDrop
      ? Math.PI * 0.5 + (Math.random() - 0.5) * 0.65
      : isRise
        ? -Math.PI * 0.5 + (Math.random() - 0.5) * 1.15
        : (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.45
    const speed = isDrop ? 28 + Math.random() * 26 : 18 + Math.random() * 44
    out.push({
      x: burst.x + spread * 0.45,
      y: burst.y + (Math.random() - 0.5) * 10,
      vx: Math.cos(baseAngle) * speed,
      vy: Math.sin(baseAngle) * speed - (isRise ? 14 : 0),
      size: isStar ? 2.4 + Math.random() * 2.4 : 1.6 + Math.random() * 1.8,
      life: 0,
      maxLife: 0.58 + Math.random() * 0.42,
      rgb: i % 2 === 0 ? primary : alt,
      kind: isDrop ? 'drop' : isStar ? 'star' : 'orb',
      gravity: isDrop ? 42 : isRise ? -12 : 6,
      drag: isDrop ? 0.99 : 0.96,
      spin: Math.random() * Math.PI,
    })
  }
}

function drawWordSparks(ctx: CanvasRenderingContext2D, sparks: WordSpark[], dt: number): void {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i]!
    sp.life += dt
    if (sp.life >= sp.maxLife) {
      sparks.splice(i, 1)
      continue
    }
    const damp = Math.pow(sp.drag, dt * 60)
    sp.vx *= damp
    sp.vy = sp.vy * damp + sp.gravity * dt
    sp.x += sp.vx * dt
    sp.y += sp.vy * dt
    sp.spin += dt * 2.2

    const u = sp.life / sp.maxLife
    const fade = u < 0.2 ? u / 0.2 : Math.pow(1 - (u - 0.2) / 0.8, 1.5)
    const a = Math.max(0, Math.min(0.92, fade * 0.85))
    const [r, g, b] = sp.rgb

    if (sp.kind === 'drop') {
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
      ctx.lineWidth = 1.4
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(sp.x, sp.y - 3)
      ctx.lineTo(sp.x + sp.vx * 0.04, sp.y + 4)
      ctx.stroke()
    } else if (sp.kind === 'star') {
      const rad = sp.size * (0.75 + 0.45 * (1 - u))
      const glow = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rad * 2.8)
      glow.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`)
      glow.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(a * 0.72).toFixed(3)})`)
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, rad * 2.8, 0, Math.PI * 2)
      ctx.fill()

      ctx.save()
      ctx.translate(sp.x, sp.y)
      ctx.rotate(sp.spin)
      ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.92).toFixed(3)})`
      ctx.beginPath()
      const arm = rad * 1.75
      const waist = rad * 0.36
      ctx.moveTo(0, -arm)
      ctx.lineTo(waist, -waist)
      ctx.lineTo(arm, 0)
      ctx.lineTo(waist, waist)
      ctx.lineTo(0, arm)
      ctx.lineTo(-waist, waist)
      ctx.lineTo(-arm, 0)
      ctx.lineTo(-waist, -waist)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    } else {
      const rad = sp.size * 3.1
      const glow = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rad)
      glow.addColorStop(0, `rgba(255, 255, 255, ${(a * 0.85).toFixed(3)})`)
      glow.addColorStop(0.38, `rgba(${r}, ${g}, ${b}, ${(a * 0.68).toFixed(3)})`)
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, rad, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/** Layered atmosphere: fullscreen drifting bokeh & embers (`ambient`) or word-synced burst sparks (`sparks`). */
export function ParticlesCanvas({
  enabled,
  playing,
  mode = 'ambient',
  trackKey = null,
  duration = 0,
  burstsRef,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visible = useWindowVisibility((x) => x.visible)
  const waveKey = useWaveform((w) => w.key)
  const wavePeaks = useWaveform((w) => w.peaks)
  const waveBeats = useWaveform((w) => w.beats)
  const orbsRef = useRef<BokehOrb[] | null>(null)
  const embersRef = useRef<Ember[] | null>(null)
  const sparksRef = useRef<WordSpark[]>([])
  const beatRef = useRef({ kick: 0, energy: 0 })

  const liveRef = useRef<{
    playing: boolean
    duration: number
    beats: Float32Array | null
    peaks: Float32Array | null
  }>({
    playing,
    duration,
    beats: waveKey === trackKey ? waveBeats : null,
    peaks: waveKey === trackKey ? wavePeaks : null,
  })
  liveRef.current = {
    playing,
    duration,
    beats: waveKey === trackKey ? waveBeats : null,
    peaks: waveKey === trackKey ? wavePeaks : null,
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!enabled) return
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (!visible) return

    const isSparks = mode === 'sparks'
    let width = Math.max(1, canvas.clientWidth)
    let height = Math.max(1, canvas.clientHeight)
    let dpr = Math.min(window.devicePixelRatio || 1, isSparks ? 2 : 1.5)

    if (!isSparks) {
      orbsRef.current ??= Array.from({ length: 34 }, (_, i) => ({
        nx: Math.random(),
        ny: Math.random(),
        r: 26 + Math.random() * 44,
        vx: (Math.random() - 0.5) * 9,
        vy: -4 - Math.random() * 9,
        alpha: 0.042 + Math.random() * 0.068,
        phase: i * 1.37,
        warm: i % 3 !== 1,
      }))
      embersRef.current ??= Array.from({ length: 64 }, (_, i) => ({
        nx: Math.random(),
        ny: Math.random(),
        r: 1.45 + Math.random() * 2.1,
        vy: 13 + Math.random() * 21,
        sway: 6 + Math.random() * 13,
        alpha: 0.14 + Math.random() * 0.22,
        phase: i * 0.93,
        accented: i % 3 !== 0,
      }))
    }

    const orbs = orbsRef.current ?? []
    const embers = embersRef.current ?? []
    const sparks = sparksRef.current
    const beatState = beatRef.current
    const accentRgb: [number, number, number] = readAccentRgb(canvas)
    let targetAccentRgb: [number, number, number] = [...accentRgb]
    let accentTick = 0
    let raf = 0
    let last = performance.now()
    let disposed = false

    const frame = (now: number) => {
      if (disposed) return
      const dtMs = Math.max(1, Math.min(64, now - last))
      const dt = Math.min(0.05, dtMs / 1000)
      last = now
      const t = now * 0.001
      const { playing: live, duration: dur, beats, peaks } = liveRef.current

      if (isSparks) {
        const queue = burstsRef?.current
        if (queue?.length) {
          while (queue.length > 0) {
            const item = queue.shift()
            if (item) spawnWordSparks(sparks, item)
          }
        }
        ctx.clearRect(0, 0, width, height)
        if (sparks.length) drawWordSparks(ctx, sparks, dt)
        if (live || sparks.length > 0) {
          raf = requestAnimationFrame(frame)
        } else {
          raf = 0
        }
        return
      }

      if (++accentTick % 12 === 0) {
        targetAccentRgb = readAccentRgb(canvas)
      }
      const colorStep = 1 - Math.exp(-dt * 5.2)
      accentRgb[0] += (targetAccentRgb[0] - accentRgb[0]) * colorStep
      accentRgb[1] += (targetAccentRgb[1] - accentRgb[1]) * colorStep
      accentRgb[2] += (targetAccentRgb[2] - accentRgb[2]) * colorStep

      let targetKick = 0
      let targetEnergy = 0
      if (live) {
        const sampled = sampleBeatAt(beats, peaks, dur, Math.max(0, engine.getPlaybackPositionMs()))
        targetEnergy = sampled.energy
        targetKick = sampled.kick < 0.04 ? 0 : Math.min(1, sampled.kick)
      }
      stepBeatEnvelope(beatState, targetKick, targetEnergy, dtMs)
      const beat = beatState
      const settling = beat.kick > 0.002 || beat.energy > 0.002
      const speedScale = live ? 1 + beat.energy * 0.55 + beat.kick * 1.15 : settling ? 0.25 : 0
      const area = width * height
      const activeOrbs = Math.min(orbs.length, Math.max(14, Math.round(area / 48000)))
      const activeEmbers = Math.min(embers.length, Math.max(24, Math.round(area / 25000)))
      const orbScale = Math.min(1.85, Math.max(1, Math.hypot(width, height) / 980))

      ctx.clearRect(0, 0, width, height)

      const [ar, ag, ab] = [Math.round(accentRgb[0]), Math.round(accentRgb[1]), Math.round(accentRgb[2])]

      // Soft studio bokeh layer
      for (let i = 0; i < activeOrbs; i++) {
        const orb = orbs[i]!
        const radius = orb.r * orbScale * (1 + beat.energy * 0.16 + beat.kick * 0.16)
        if (speedScale > 0) {
          orb.ny += (orb.vy * dt * speedScale) / height
          orb.nx += ((orb.vx + Math.sin(t * 0.55 + orb.phase) * 7) * dt * speedScale) / width
        }
        const padY = (radius * 1.3) / height
        const padX = (radius * 1.1) / width
        if (orb.ny < -padY) {
          orb.ny = 1 + padY
          orb.nx = Math.random()
        }
        if (orb.nx < -padX) orb.nx = 1 + padX
        else if (orb.nx > 1 + padX) orb.nx = -padX

        const ox = orb.nx * width
        const oy = orb.ny * height
        const alpha = orb.alpha * (0.86 + Math.sin(t * 1.1 + orb.phase) * 0.14) + beat.kick * 0.055
        const [r, g, b] = orb.warm ? [ar, ag, ab] : [255, 255, 255]
        const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius)
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`)
        grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.36).toFixed(3)})`)
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(ox, oy, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Ambient drifting embers
      for (let i = 0; i < activeEmbers; i++) {
        const p = embers[i]!
        if (speedScale > 0) {
          p.ny -= (p.vy * dt * speedScale) / height
          p.nx += (Math.sin(t * 1.05 + p.phase) * p.sway * dt * speedScale) / width
        }
        const padY = 14 / height
        const padX = 14 / width
        if (p.ny < -padY) {
          p.ny = 1 + padY
          p.nx = Math.random()
        }
        if (p.nx < -padX) p.nx = 1 + padX
        else if (p.nx > 1 + padX) p.nx = -padX

        const px = p.nx * width
        const py = p.ny * height
        const pulse = 0.74 + 0.26 * Math.sin(t * 2.1 + p.phase)
        const alpha = Math.min(0.44, p.alpha * pulse + beat.kick * 0.12)
        const haloR = p.r * (4.1 + beat.kick * 1.9)
        const [cr, cg, cb] = p.accented ? [Math.min(255, ar + 55), Math.min(255, ag + 55), Math.min(255, ab + 55)] : [255, 255, 255]

        const halo = ctx.createRadialGradient(px, py, 0, px, py, haloR)
        halo.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`)
        halo.addColorStop(0.45, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.42).toFixed(3)})`)
        halo.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`)
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(px, py, haloR, 0, Math.PI * 2)
        ctx.fill()
      }

      if (live || settling) {
        raf = requestAnimationFrame(frame)
      } else {
        beatState.kick = 0
        beatState.energy = 0
        raf = 0
      }
    }

    const resize = () => {
      if (!canvas) return
      width = Math.max(1, canvas.clientWidth)
      height = Math.max(1, canvas.clientHeight)
      dpr = Math.min(window.devicePixelRatio || 1, isSparks ? 2 : 1.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!raf) raf = requestAnimationFrame(frame)
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(canvas)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [enabled, mode, burstsRef, playing, visible])

  if (!enabled) return null
  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
