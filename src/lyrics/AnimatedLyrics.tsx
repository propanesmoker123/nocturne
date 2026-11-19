import '@fontsource-variable/onest/wght.css'
import '@fontsource-variable/playfair-display/wght.css'
import '@fontsource-variable/playfair-display/wght-italic.css'
import '@fontsource-variable/unbounded/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { scrollWithin } from '../lib/scrollWithin'
import { useSettings } from '../lib/settings'
import { useWindowVisibility } from '../lib/windowVisibility'
import { engine } from '../player/engine'
import { isEngineAttachedTo, livePlaybackPositionMs, usePlayer } from '../player/store'
import { useWaveform } from '../player/waveformStore'
import type { Lyrics, Track } from '../vk/models'
import s from './AnimatedLyrics.module.css'
import { sampleBeatAt, stepBeatEnvelope } from './beats'
import { analyzeLyricsOffline } from './effects'
import { ParticlesCanvas, type WordBurst } from './ParticlesCanvas'
import { buildLyricsWords, computeWordProgress, findActiveLineIndex, lineSeekSeconds } from './timing'

/** Compensate OS/decoder audio pipeline latency so karaoke wipes hit on real ear arrival. */
const AUDIO_LEAD_MS = -155
const SPOTIFY_LEAD_MS = -210

interface Props {
  track: Track
  lyrics: Lyrics
  fromVk?: boolean
  theater?: boolean
  footer?: ReactNode
}

export function AnimatedLyrics({ track, lyrics, fromVk = false, theater = false, footer }: Props) {
  const isPlaying = usePlayer((p) => p.isPlaying)
  const visible = useWindowVisibility((x) => x.visible)
  const duration = usePlayer((p) => p.duration || track.duration)
  const seek = usePlayer((p) => p.seek)
  const lyricCfg = useSettings((st) => st.lyrics)

  const waveKey = useWaveform((w) => w.key)
  const wavePeaks = useWaveform((w) => w.peaks)
  const waveBeats = useWaveform((w) => w.beats)
  const waveVocal = useWaveform((w) => w.vocal)
  const activeBeats = waveKey === track.key ? waveBeats : null
  const activePeaks = waveKey === track.key ? wavePeaks : null
  const activeVocal = waveKey === track.key ? waveVocal : null
  const waveRef = useRef<{ peaks: Float32Array | null; beats: Float32Array | null }>({ peaks: null, beats: null })
  waveRef.current = { peaks: activePeaks, beats: activeBeats }

  const wrapRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const wordRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  const clockRef = useRef<{ baseMs: number; wallMs: number }>({
    baseMs: usePlayer.getState().position * 1000,
    wallMs: performance.now(),
  })
  const activeIdxRef = useRef<number>(-1)
  const prevScrolledIdxRef = useRef<number>(-1)
  const lastSeekWallRef = useRef<number>(0)
  const lastWordIdxRef = useRef<number>(-1)
  const wordPulseRef = useRef<number>(0)
  const linePulseRef = useRef<number>(0)
  const seenSeekSerialRef = useRef<number>(engine.seekSerial)
  const lastSampleMsRef = useRef<number>(-1)
  const seekLockRef = useRef<{
    idx: number
    lineBeginMs: number
    nextBeginMs: number | undefined
    targetMs: number
    startedAt: number
    untilWall: number
    serial: number
  } | null>(null)
  const beatSmoothRef = useRef<{ kick: number; energy: number; lastWall: number }>({
    kick: 0,
    energy: 0,
    lastWall: performance.now(),
  })
  const burstsRef = useRef<WordBurst[]>([])
  const lastBurstWallRef = useRef<number>(0)

  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const effectsOn = lyricCfg.effects && lyrics.synced
  const wordSyncOn = lyricCfg.wordSync && lyrics.synced

  const lineWords = useMemo(() => buildLyricsWords(lyrics.lines, activeVocal), [lyrics.lines, activeVocal])
  const lineWordsRef = useRef(lineWords)
  lineWordsRef.current = lineWords
  const analyzed = useMemo(() => (effectsOn ? analyzeLyricsOffline(lyrics.lines) : null), [effectsOn, lyrics.lines])
  const analyzedRef = useRef(analyzed)
  analyzedRef.current = analyzed
  const particlesOnRef = useRef(lyricCfg.particles)
  particlesOnRef.current = lyricCfg.particles
  const syncNowRef = useRef<((nowMs: number, wallNow: number) => void) | null>(null)

  // Reset per-track and per-lyrics-replacement indices cleanly (e.g. when Whisper AI replaces lyrics in-place)
  useEffect(() => {
    const prevIdx = activeIdxRef.current
    if (prevIdx >= 0) {
      const prevLineEl = lineRefs.current.get(prevIdx)
      if (prevLineEl) {
        prevLineEl.style.removeProperty('--beat')
        prevLineEl.style.removeProperty('--energy')
      }
      for (const [k, el] of wordRefs.current) {
        if (!k.startsWith(`${prevIdx}:`)) continue
        el.style.removeProperty('--wp')
        delete el.dataset.wordActive
        delete el.dataset.wordLit
        const unit = el.parentElement
        if (unit && unit.dataset.fx) delete unit.dataset.lit
      }
    }
    activeIdxRef.current = -1
    lastWordIdxRef.current = -1
    wordPulseRef.current = 0
    linePulseRef.current = 0
    seenSeekSerialRef.current = engine.seekSerial
    prevScrolledIdxRef.current = -1
    lastSeekWallRef.current = 0
    lastSampleMsRef.current = -1
    seekLockRef.current = null
    burstsRef.current.length = 0
    beatSmoothRef.current = { kick: 0, energy: 0, lastWall: performance.now() }
    setActiveIndex(-1)
  }, [track.key, lyrics])

  // Sync clock ref directly from player store without subscribing the React tree to 4Hz position ticks
  useEffect(() => {
    const syncFromPos = (posSec: number, playingNow: boolean) => {
      const baseMs = posSec * 1000
      const now = performance.now()
      clockRef.current = { baseMs, wallMs: now }
      if (!playingNow) {
        syncNowRef.current?.(livePlaybackPositionMs(track.key), now)
      }
    }
    const cur = usePlayer.getState()
    syncFromPos(cur.position, isPlaying)
    return usePlayer.subscribe((state, prev) => {
      if (state.position !== prev.position) {
        syncFromPos(state.position, state.isPlaying)
      }
    })
  }, [track.key, isPlaying])

  useEffect(() => {
    let lastBeatTarget: HTMLElement | null = null
    let lastBeatStr = ''
    let lastEnergyStr = ''

    const clearBeatTarget = () => {
      if (lastBeatTarget) {
        lastBeatTarget.style.removeProperty('--beat')
        lastBeatTarget.style.removeProperty('--energy')
        lastBeatTarget = null
      }
    }

    const clearLineWords = (lineIdx: number) => {
      if (lineIdx < 0) return
      const lineEl = lineRefs.current.get(lineIdx)
      if (lineEl) {
        lineEl.style.removeProperty('--beat')
        lineEl.style.removeProperty('--energy')
      }
      const count = lineWordsRef.current[lineIdx]?.length ?? 0
      for (let w = 0; w < count; w++) {
        const el = wordRefs.current.get(`${lineIdx}:${w}`)
        if (!el) continue
        el.style.removeProperty('--wp')
        delete el.dataset.wordActive
        delete el.dataset.wordLit
        const unit = el.parentElement
        if (unit && unit.dataset.fx) delete unit.dataset.lit
      }
    }

    const syncFrame = (playbackMs: number, wallNow: number) => {
      const dtMs = Math.max(1, Math.min(64, wallNow - beatSmoothRef.current.lastWall))
      beatSmoothRef.current.lastWall = wallNow

      const beatMs = playbackMs
      const serial = engine.seekSerial
      let nowMs = Math.max(0, playbackMs)
      if (serial !== seenSeekSerialRef.current) {
        seenSeekSerialRef.current = serial
        lastSeekWallRef.current = wallNow
        if (!seekLockRef.current || seekLockRef.current.serial !== serial) {
          const extIdx = lyrics.synced ? findActiveLineIndex(lyrics.lines, nowMs) : -1
          const extBegin = extIdx >= 0 ? (lyrics.lines[extIdx]?.begin ?? nowMs) : 0
          seekLockRef.current = {
            idx: extIdx,
            lineBeginMs: extBegin,
            nextBeginMs: extIdx >= 0 ? lyrics.lines[extIdx + 1]?.begin : undefined,
            targetMs: nowMs,
            startedAt: wallNow,
            untilWall: wallNow + 950,
            serial,
          }
        }
        lastSampleMsRef.current = nowMs
      } else {
        const prevMs = lastSampleMsRef.current
        const wrappedTrack = prevMs > 10_000 && nowMs < 2_000
        if (!wrappedTrack && prevMs >= 0 && nowMs < prevMs && prevMs - nowMs <= 950) {
          nowMs = prevMs
        } else {
          lastSampleMsRef.current = nowMs
        }
      }

      const lock = seekLockRef.current
      if (lock) {
        const lockAge = wallNow - lock.startedAt
        if (wallNow > lock.untilWall) {
          seekLockRef.current = null
        } else if (nowMs < lock.lineBeginMs) {
          nowMs = lock.targetMs
          lastSampleMsRef.current = Math.max(lastSampleMsRef.current, nowMs)
        } else if (lockAge >= 120) {
          seekLockRef.current = null
        }
      }

      let idx = lyrics.synced ? findActiveLineIndex(lyrics.lines, nowMs) : -1
      if (seekLockRef.current && idx < seekLockRef.current.idx) {
        idx = seekLockRef.current.idx
      }
      const prevIdx = activeIdxRef.current
      if (idx !== prevIdx) {
        clearLineWords(prevIdx)
        activeIdxRef.current = idx
        lastWordIdxRef.current = -1
        if (idx >= 0) linePulseRef.current = 0.85
        setActiveIndex(idx)
      }

      const canBurst = effectsOn && particlesOnRef.current && isPlaying && !seekLockRef.current
      const pendingBursts: Array<{ el: HTMLElement; fx: WordBurst['fx']; variant: WordBurst['variant'] }> = []

      if (idx >= 0) {
        const words = lineWordsRef.current[idx] ?? []
        const lineData = effectsOn ? analyzedRef.current?.lineFx.get(idx) : undefined

        if (!wordSyncOn) {
          if (!effectsOn) {
            clearLineWords(idx)
          } else {
            for (let w = 0; w < words.length; w++) {
              const el = wordRefs.current.get(`${idx}:${w}`)
              if (!el) continue
              el.style.removeProperty('--wp')
              delete el.dataset.wordActive
              const unit = el.parentElement
              const fx = lineData?.wordFx.get(w)
              if (fx) {
                const wasLit = el.dataset.wordLit === 'true'
                el.dataset.wordLit = 'true'
                if (unit && unit.dataset.fx) unit.dataset.lit = 'true'
                if (!wasLit && canBurst) pendingBursts.push({ el, fx, variant: lineData?.wordVariant.get(w) ?? 0 })
              } else {
                delete el.dataset.wordLit
                if (unit && unit.dataset.fx) delete unit.dataset.lit
              }
            }
          }
        } else {
          const progresses = computeWordProgress(words, nowMs)
          let currentWordIdx = -1

          for (let w = 0; w < words.length; w++) {
            const rawWord = words[w]!
            const durMs = Math.max(1, rawWord.end - rawWord.begin)
            const p = progresses[w] ?? 0
            const sustainAlpha = durMs > 320 ? Math.min(1, (durMs - 320) / 520) : 0
            const easedHold = p <= 0 ? 0 : p >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.pow(p, 1.08))
            const visualP = p <= 0 ? 0 : p >= 1 ? 1 : p * (1 - sustainAlpha * 0.45) + easedHold * (sustainAlpha * 0.45)
            const el = wordRefs.current.get(`${idx}:${w}`)
            if (p > 0.01 && p < 0.995) currentWordIdx = w
            if (!el) continue
            el.style.setProperty('--wp', `${(visualP * 100).toFixed(1)}%`)
            if (p > 0.01 && p < 0.995) el.dataset.wordActive = 'true'
            else delete el.dataset.wordActive

            const wasLit = el.dataset.wordLit === 'true'
            const unit = el.parentElement
            if (visualP >= 0.3) {
              el.dataset.wordLit = 'true'
              if (unit && unit.dataset.fx) unit.dataset.lit = 'true'
              const fx = lineData?.wordFx.get(w)
              if (!wasLit && fx && canBurst) pendingBursts.push({ el, fx, variant: lineData?.wordVariant.get(w) ?? 0 })
            } else {
              delete el.dataset.wordLit
              if (unit && unit.dataset.fx) delete unit.dataset.lit
            }
          }
          if (currentWordIdx >= 0 && currentWordIdx !== lastWordIdxRef.current) {
            lastWordIdxRef.current = currentWordIdx
            wordPulseRef.current = 1
          }
        }
      }

      // Compute punchy yet smooth beat and ambient energy envelopes from real PCM/Spotify beat bins
      wordPulseRef.current *= Math.exp(-dtMs / 105)
      linePulseRef.current *= Math.exp(-dtMs / 135)

      let targetKick = 0
      let targetEnergy = 0
      if (isPlaying && effectsOn) {
        const sampled = sampleBeatAt(waveRef.current.beats, waveRef.current.peaks, duration, beatMs)
        targetEnergy = sampled.energy
        const hasBeatTrack = Boolean(waveRef.current.beats?.length || waveRef.current.peaks?.length)
        const cadenceFallback = hasBeatTrack
          ? Math.max(wordPulseRef.current * 0.22, linePulseRef.current * 0.28)
          : Math.max(wordPulseRef.current * 0.48, linePulseRef.current * 0.52)
        const rawKick = Math.max(sampled.kick, cadenceFallback)
        targetKick = rawKick < 0.04 ? 0 : Math.min(1, rawKick)
      }

      stepBeatEnvelope(beatSmoothRef.current, targetKick, targetEnergy, dtMs)

      // Scope --beat/--energy to only the ambient glow div + single active line when synced
      // to avoid full-subtree style invalidation over 500-1500 inactive word spans at 60 FPS.
      const beatStr = effectsOn ? beatSmoothRef.current.kick.toFixed(3) : '0'
      const energyStr = effectsOn ? beatSmoothRef.current.energy.toFixed(3) : '0'
      const valuesChanged = beatStr !== lastBeatStr || energyStr !== lastEnergyStr
      const targetEl = lyrics.synced ? (idx >= 0 ? lineRefs.current.get(idx) ?? null : null) : wrapRef.current
      const targetChanged = targetEl !== lastBeatTarget

      if (targetChanged) {
        clearBeatTarget()
        lastBeatTarget = targetEl
      }

      if (valuesChanged || targetChanged) {
        lastBeatStr = beatStr
        lastEnergyStr = energyStr
        const glowEl = glowRef.current
        if (glowEl) {
          glowEl.style.setProperty('--beat', beatStr)
          glowEl.style.setProperty('--energy', energyStr)
        }
        if (targetEl) {
          targetEl.style.setProperty('--beat', beatStr)
          targetEl.style.setProperty('--energy', energyStr)
        }
      }

      // Batch DOM geometry reads AFTER all style/dataset writes to eliminate layout thrashing.
      if (pendingBursts.length > 0 && wallNow - lastBurstWallRef.current >= 45) {
        const wrapBox = wrapRef.current?.getBoundingClientRect() ?? null
        if (wrapBox) {
          for (const b of pendingBursts) {
            if (wallNow - lastBurstWallRef.current < 45) break
            const wb = b.el.getBoundingClientRect()
            if (wb.width <= 0 || wb.bottom < wrapBox.top || wb.top > wrapBox.bottom) continue
            lastBurstWallRef.current = wallNow
            burstsRef.current.push({
              x: wb.left - wrapBox.left + wb.width * 0.5,
              y: wb.top - wrapBox.top + wb.height * 0.45,
              fx: b.fx,
              variant: b.variant,
            })
          }
        }
      }
    }

    syncNowRef.current = syncFrame

    const readPlaybackMs = (wallNow: number) => {
      const leadMs = isPlaying ? (engine.isRemoteClock ? SPOTIFY_LEAD_MS : AUDIO_LEAD_MS) : 0
      if (isEngineAttachedTo(track.key)) {
        const engineMs = engine.getPlaybackPositionMs()
        if (engineMs > 0 || engine.playing) {
          return Math.max(0, engineMs + leadMs)
        }
      }
      const elapsed = isPlaying ? Math.min(1150, Math.max(0, wallNow - clockRef.current.wallMs)) : 0
      return Math.max(0, clockRef.current.baseMs + elapsed + leadMs)
    }

    syncFrame(readPlaybackMs(performance.now()), performance.now())
    if (!visible || (!isPlaying && beatSmoothRef.current.kick === 0 && beatSmoothRef.current.energy === 0)) {
      return () => {
        syncNowRef.current = null
        clearBeatTarget()
      }
    }

    let raf = 0
    const tick = (wallNow: number) => {
      syncFrame(readPlaybackMs(wallNow), wallNow)
      if (isPlaying || beatSmoothRef.current.kick > 0 || beatSmoothRef.current.energy > 0) {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      syncNowRef.current = null
      clearBeatTarget()
      cancelAnimationFrame(raf)
    }
  }, [track.key, isPlaying, visible, duration, lyrics, effectsOn, wordSyncOn])

  // Smooth spring scroll on normal playback advances; only snap immediately right after a multi-line seek jump
  useEffect(() => {
    const prevIdx = prevScrolledIdxRef.current
    prevScrolledIdxRef.current = activeIndex
    if (!lyrics.synced || activeIndex < 0) return
    const recentMultiLineSeek = performance.now() - lastSeekWallRef.current < 320 && Math.abs(activeIndex - prevIdx) > 1
    scrollWithin(lineRefs.current.get(activeIndex) ?? null, 'center', !recentMultiLineSeek)
  }, [activeIndex, lyrics.synced])

  return (
    <div
      ref={wrapRef}
      className={s.wrap}
      data-synced={lyrics.synced ? 'true' : 'false'}
      data-word-sync={wordSyncOn ? 'true' : 'false'}
      data-effects={effectsOn ? 'true' : 'false'}
      data-theater={theater ? 'true' : 'false'}
      data-playing={isPlaying ? 'true' : 'false'}
    >
      <div ref={glowRef} className={s.glow} aria-hidden="true" />
      <ParticlesCanvas
        mode="sparks"
        enabled={effectsOn && lyricCfg.particles}
        playing={isPlaying}
        burstsRef={burstsRef}
        className={s.particles}
      />

      <div className={s.scrollHost}>
        <div className={s.list}>
          {lyrics.lines.map((line, i) => {
            const isActive = lyrics.synced && i === activeIndex
            const isPast = lyrics.synced && activeIndex >= 0 && i < activeIndex
            const dist = !lyrics.synced
              ? 0
              : activeIndex >= 0
                ? Math.min(4, Math.abs(i - activeIndex))
                : Math.min(4, i + 1)
            const lineAnalysis = effectsOn ? analyzed?.lineFx.get(i) : undefined
            const words = lineWords[i] ?? []
            const canSeek = lyrics.synced && line.begin !== undefined

            return (
              <button
                key={`${track.key}:${i}:${line.begin ?? 'u'}`}
                ref={(el) => {
                  if (el) lineRefs.current.set(i, el)
                  else lineRefs.current.delete(i)
                }}
                type="button"
                className={s.line}
                disabled={!canSeek}
                data-active={isActive ? 'true' : undefined}
                data-past={isPast ? 'true' : undefined}
                data-dist={dist}
                data-text-fx={effectsOn ? lineAnalysis?.textFx : undefined}
                onClick={() => {
                  if (!canSeek || line.begin === undefined) return
                  const nextBegin = lyrics.lines[i + 1]?.begin
                  const playbackSec = lineSeekSeconds(line.begin, nextBegin)
                  const nowWall = performance.now()
                  seek(playbackSec)
                  seekLockRef.current = {
                    idx: i,
                    lineBeginMs: line.begin,
                    nextBeginMs: nextBegin,
                    targetMs: line.begin,
                    startedAt: nowWall,
                    untilWall: nowWall + 1450,
                    serial: engine.seekSerial,
                  }
                  lastSampleMsRef.current = line.begin
                  syncNowRef.current?.(line.begin, nowWall)
                }}
              >
                <span className={s.lineInner}>
                  {words.length > 0
                    ? words.map((w, wi) => {
                        const k = `${i}:${wi}`
                        const fx = effectsOn ? lineAnalysis?.wordFx.get(wi) : undefined
                        const variant = fx ? lineAnalysis?.wordVariant.get(wi) ?? 0 : undefined
                        const emoji = effectsOn ? lineAnalysis?.wordEmoji.get(wi) : undefined
                        const wordEl = (
                          <span
                            ref={(el) => {
                              if (el) wordRefs.current.set(k, el)
                              else wordRefs.current.delete(k)
                            }}
                            className={s.word}
                            data-fx={fx}
                            data-var={variant}
                            data-text={fx ? w.text : undefined}
                          >
                            {w.text}
                          </span>
                        )
                        return (
                          <Fragment key={k}>
                            {fx ? (
                              <span className={s.wordUnit} data-fx={fx} data-var={variant} data-text={w.text}>
                                {wordEl}
                                {emoji && (
                                  <span className={s.wordEmoji} data-fx={fx} aria-hidden="true">
                                    {emoji}
                                  </span>
                                )}
                              </span>
                            ) : (
                              wordEl
                            )}
                            {wi < words.length - 1 ? ' ' : ''}
                          </Fragment>
                        )
                      })
                    : line.text}
                </span>
              </button>
            )
          })}

          <div className={s.metaBar}>
            {lyrics.credits && <span>{lyrics.credits}</span>}
            {fromVk && (!lyrics.source || lyrics.source === 'vk') && !lyrics.credits?.includes('ВКонтакте') && (
              <span>Подобрано по базе ВКонтакте</span>
            )}
            {footer}
          </div>
        </div>
      </div>
    </div>
  )
}
