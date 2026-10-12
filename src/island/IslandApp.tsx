import { LocateFixed, Minus, Pin, PinOff, Users } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react'
import { Artwork } from '../components/Artwork'
import { EqualizerBars, IconButton, Spinner } from '../components/controls'
import { IconBackward, IconCheck, IconForward, IconPause, IconPlay, IconPlus, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { WaveformScrubber } from '../components/Waveform'
import { EV, type IslandWave, type PlayerCommand, type PlayerSnapshot } from '../lib/events'
import { formatTime } from '../lib/format'
import { DEFAULT_SETTINGS, type IslandProgress, type IslandSettings } from '../lib/settings'
import { emitTo, invoke, isTauri, listen } from '../lib/tauri'
import { useWaveform } from '../player/waveformStore'
import { COLLAPSE_DELAY, SHAPES, VOLUME_HUD_MS, hitRect, isInteractive, pickShape, volumeChanged } from './geometry'
import { roundedPath } from './shapes'
import s from './island.module.css'

const spring = { type: 'spring', stiffness: 420, damping: 32, mass: 0.85 } as const
const fade = { initial: { opacity: 0, filter: 'blur(6px)' }, animate: { opacity: 1, filter: 'blur(0px)' }, exit: { opacity: 0, filter: 'blur(6px)' }, transition: { duration: 0.18 } }

const send = (cmd: PlayerCommand) => void emitTo('main', EV.playerCommand, cmd)
const setIsland = (patch: Partial<IslandSettings>) => void emitTo('main', EV.islandSet, patch)

let dragArmed = false
let moveTimer: ReturnType<typeof setTimeout> | undefined

/** Drag the island by any empty spot; the new place is saved once the window stops moving. */
async function startDrag() {
  if (!isTauri()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  dragArmed = true
  await getCurrentWindow().startDragging().catch(() => (dragArmed = false))
}

async function watchMoves() {
  if (!isTauri()) return () => {}
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow().onMoved(({ payload }) => {
    if (!dragArmed) return
    clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      dragArmed = false
      setIsland({ position: { x: payload.x, y: payload.y } })
    }, 350)
  })
}

/** What the player is doing right now: loading, playing (live bars) or paused. */
function StatusGlyph({ st, accent, size }: { st: PlayerSnapshot; accent: string; size: number }) {
  if (st.isLoading && st.isPlaying) return <Spinner size={size} />
  if (st.isPlaying) return <EqualizerBars playing height={size} width={size > 15 ? 3.5 : 3} color={accent} />
  return (
    <span className={s.paused} aria-label="Пауза">
      <IconPause size={size} />
    </span>
  )
}

const isControl = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest('button, [role="slider"], input')

/** Position interpolated from the last snapshot so the scrubber moves smoothly between events. */
function useLivePosition(st: PlayerSnapshot | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !st?.isPlaying) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [active, st?.isPlaying])
  if (!st) return 0
  const extra = st.isPlaying ? Math.max(0, now - st.at) / 1000 : 0
  return Math.min(st.duration || Infinity, st.position + extra)
}

const PILL = SHAPES.compact
const PILL_PATH = roundedPath(0.75, 0.75, PILL.w - 1.5, PILL.h - 1.5, PILL.h / 2 - 0.75)
const RING_PATH = roundedPath(1, 1, 26, 26, 9)

/** The compact pill: cover, status and the track position in the chosen style; ticks on its own so the island stays still. */
function CompactBody({ st, accent, style, duration }: { st: PlayerSnapshot; accent: string; style: IslandProgress; duration: number }) {
  const t = st.track!
  const live = useLivePosition(st, style !== 'off')
  const p = duration ? Math.min(1, live / duration) : 0
  const dash = { strokeDasharray: `${(p * 100).toFixed(2)} 100`, opacity: p > 0 ? 1 : 0 }
  const ring = style === 'ring'
  const art = <Artwork className={s.compactArt} src={t.cover} size={ring ? 20 : 24} radius={ring ? 6 : 7} seed={t.key} />
  return (
    <>
      {style === 'fill' && <span className={s.progressFill} style={{ transform: `scaleX(${p})` }} aria-hidden="true" />}
      {style === 'outline' && (
        <svg className={s.progressOutline} viewBox={`0 0 ${PILL.w} ${PILL.h}`} aria-hidden="true">
          <path d={PILL_PATH} pathLength={100} style={dash} />
        </svg>
      )}
      {ring ? (
        <span className={s.ring}>
          <svg viewBox="0 0 28 28" aria-hidden="true">
            <path className={s.ringTrack} d={RING_PATH} />
            <path className={s.ringValue} d={RING_PATH} pathLength={100} style={dash} />
          </svg>
          {art}
        </span>
      ) : (
        art
      )}
      {style === 'bar' && (
        <span className={s.progressBar} aria-hidden="true">
          <i style={{ width: `${p * 100}%`, opacity: p > 0 ? 1 : 0 }} />
        </span>
      )}
      <span className={s.compactEnd}>
        {st.together && <Users size={13} strokeWidth={2.4} className={s.togetherIcon} aria-label="Слушаете вместе" />}
        <StatusGlyph st={st} accent={accent} size={14} />
      </span>
    </>
  )
}

function Expanded({ st, accent, locked, moved, waveColor }: { st: PlayerSnapshot; accent: string; locked: boolean; moved: boolean; waveColor: string | null }) {
  const t = st.track!
  const live = useLivePosition(st, true)
  const [drag, setDrag] = useState<number | null>(null)
  const pos = drag ?? live
  const d = st.duration || t.duration
  return (
    <motion.div
      className={s.expanded}
      data-draggable={!locked || undefined}
      {...fade}
      onMouseDown={(e) => {
        if (e.button === 0 && !locked && !isControl(e.target)) void startDrag()
      }}
    >
      <div className={s.top}>
        <button type="button" aria-label="Открыть Nocturne" onClick={() => send({ type: 'showWindow' })}>
          <Artwork src={t.coverLarge ?? t.cover} size={56} radius={13} seed={t.key} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className={s.title}>
            <span className="truncate">{t.title}</span>
            {t.explicit && <span className={s.explicit}>E</span>}
          </div>
          <div className={`${s.artist} truncate`}>{t.artist}</div>
          {st.together && (
            <div className={`${s.together} truncate`}>
              <Users size={12} strokeWidth={2.4} aria-hidden="true" />
              {st.together.role === 'listener' ? `Вместе с ${st.together.hostName ?? 'ведущим'}` : `Слушают вместе: ${st.together.listeners}`}
            </div>
          )}
        </div>
        <div className={s.topActions}>
          <IconButton
            className={s.round}
            size={30}
            active={locked}
            label={locked ? 'Открепить — можно перетаскивать' : 'Закрепить на месте'}
            onClick={() => setIsland({ locked: !locked })}
          >
            {locked ? <Pin size={15} strokeWidth={2.2} /> : <PinOff size={15} strokeWidth={2.2} />}
          </IconButton>
          {moved && (
            <IconButton className={s.round} size={30} label="Вернуть наверх по центру" onClick={() => setIsland({ position: null })}>
              <LocateFixed size={15} strokeWidth={2.2} />
            </IconButton>
          )}
          <IconButton className={s.round} size={30} label={t.liked ? 'Убрать из Моей музыки' : 'Добавить в Мою музыку'} onClick={() => send({ type: 'toggleLike' })}>
            {t.liked ? <IconCheck size={16} /> : <IconPlus size={16} />}
          </IconButton>
          <StatusGlyph st={st} accent={accent} size={16} />
        </div>
      </div>
      <div className={s.time}>
        <span>{formatTime(pos)}</span>
        <WaveformScrubber
          trackKey={t.key}
          height={30}
          label="Позиция трека"
          value={d ? pos / d : 0}
          buffered={1}
          step={5 / Math.max(d, 1)}
          valueText={(v) => formatTime(v * d)}
          color={waveColor ?? accent}
          onChange={(v) => setDrag(v * d)}
          onCommit={(v) => {
            setDrag(null)
            send({ type: 'seek', value: v * d })
          }}
        />
        <span>-{formatTime(Math.max(0, d - pos))}</span>
      </div>
      <div className={s.transport}>
        <IconButton size={30} plain active={st.shuffle} label="Перемешать" onClick={() => send({ type: 'toggleShuffle' })}>
          <IconShuffle size={16} />
        </IconButton>
        <IconButton size={38} plain label="Предыдущий" onClick={() => send({ type: 'prev' })}>
          <IconBackward size={24} />
        </IconButton>
        <IconButton size={44} plain label={st.isPlaying ? 'Пауза' : 'Играть'} onClick={() => send({ type: 'toggle' })}>
          {st.isLoading && st.isPlaying ? <Spinner size={22} /> : st.isPlaying ? <IconPause size={30} /> : <IconPlay size={30} />}
        </IconButton>
        <IconButton size={38} plain label="Следующий" onClick={() => send({ type: 'next' })}>
          <IconForward size={24} />
        </IconButton>
        <IconButton size={30} plain active={st.repeat !== 'off'} label="Повтор" onClick={() => send({ type: 'cycleRepeat' })}>
          <IconRepeat size={16} one={st.repeat === 'one'} />
        </IconButton>
      </div>
      <div className={s.volume}>
        <IconSpeaker size={14} level={0} />
        <Slider size="sm" label="Громкость" value={st.muted ? 0 : st.volume} onChange={(v) => send({ type: 'volume', value: v })} onCommit={(v) => send({ type: 'volume', value: v })} />
        <IconSpeaker size={16} level={3} />
      </div>
    </motion.div>
  )
}

export function IslandApp() {
  const [st, setSt] = useState<PlayerSnapshot | null>(null)
  const [settings, setSettings] = useState<IslandSettings>(DEFAULT_SETTINGS.island)
  const [expanded, setExpanded] = useState(false)
  const [peek, setPeek] = useState(false)
  const [flash, setFlash] = useState<'added' | 'removed' | null>(null)
  const [volumeHud, setVolumeHud] = useState(false)
  const [waveColor, setWaveColor] = useState<string | null>(null)
  const volumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const prevVolume = useRef<{ volume: number; muted: boolean } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const prevKey = useRef<string | null>(null)
  const prevLiked = useRef<boolean | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const onHover = useCallback((inside: boolean) => {
    clearTimeout(hoverTimer.current)
    clearTimeout(leaveTimer.current)
    if (inside) {
      if (settingsRef.current.expandOn === 'hover') hoverTimer.current = setTimeout(() => setExpanded(true), 220)
    } else {
      leaveTimer.current = setTimeout(() => setExpanded(false), COLLAPSE_DELAY)
    }
  }, [])

  useEffect(() => {
    const offs = [
      listen<PlayerSnapshot>(EV.playerState, (e) => setSt(e.payload)),
      listen<IslandSettings>(EV.islandSettings, (e) => setSettings(e.payload)),
      listen<{ inside: boolean }>(EV.islandHover, (e) => onHover(e.payload.inside)),
      listen<IslandWave>(EV.islandWave, (e) => {
        const { key, peaks, color } = e.payload
        useWaveform.setState({ key, peaks: peaks ? Float32Array.from(peaks) : null })
        setWaveColor(color)
      }),
    ]
    offs.push(watchMoves())
    void emitTo('main', EV.requestState)
    return () => offs.forEach((p) => void p.then((off) => off()))
  }, [onHover])

  // Browser dev only: island.html#demo plays a fake track, #demo-open shows it expanded (dropped from release builds)
  useEffect(() => {
    if (!import.meta.env.DEV || isTauri() || !location.hash.startsWith('#demo')) return
    let stop = () => {}
    void import('./demo').then((m) => (stop = m.startIslandDemo({ state: setSt, settings: setSettings, hover: onHover, wave: setWaveColor })))
    return () => stop()
  }, [onHover])

  // Peek for a moment when the track changes; flash a badge when it is added/removed.
  useEffect(() => {
    const key = st?.track?.key ?? null
    const liked = st?.track?.liked ?? null
    if (key && prevKey.current && key !== prevKey.current && settings.showOnTrackChange) {
      setPeek(true)
      clearTimeout(peekTimer.current)
      peekTimer.current = setTimeout(() => setPeek(false), 3200)
    } else if (key && key === prevKey.current && liked !== null && prevLiked.current !== null && liked !== prevLiked.current) {
      setFlash(liked ? 'added' : 'removed')
      clearTimeout(peekTimer.current)
      peekTimer.current = setTimeout(() => setFlash(null), 1800)
    }
    prevKey.current = key
    prevLiked.current = liked
  }, [st?.track?.key, st?.track?.liked, settings.showOnTrackChange])

  // Volume HUD: a moment of «🔊 ▬▬▬▭ 60 %» whenever the volume or mute changes (hotkeys, wheel, slider)
  useEffect(() => {
    if (!st) return
    const next = { volume: st.volume, muted: st.muted }
    if (volumeChanged(prevVolume.current, next)) {
      setVolumeHud(true)
      clearTimeout(volumeTimer.current)
      volumeTimer.current = setTimeout(() => setVolumeHud(false), VOLUME_HUD_MS)
    }
    prevVolume.current = next
  }, [st?.volume, st?.muted])

  const hasTrack = !!st?.track
  const shape = pickShape({ hasTrack, expanded, peek: !!(peek || flash), volume: volumeHud })

  useEffect(() => {
    void invoke('island_configure', {
      config: {
        wantVisible: settings.enabled && hasTrack,
        mode: settings.visibility,
        monitor: settings.monitor,
        hideInFullscreen: settings.hideInFullscreen,
        position: settings.position,
      },
    }).catch(() => {})
  }, [settings.enabled, settings.visibility, settings.monitor, settings.hideInFullscreen, settings.position, hasTrack])

  useEffect(() => {
    void invoke('island_set_hit_rect', { ...hitRect(shape), interactive: isInteractive(shape, settings.expandOn) }).catch(() => {})
  }, [shape, settings.expandOn])

  useEffect(() => {
    if (st?.accent) document.documentElement.style.setProperty('--accent', st.accent)
  }, [st?.accent])

  if (!st?.track) return null
  const t = st.track
  const accent = st.accent ?? '#ff375f'
  const size = SHAPES[shape]
  const duration = st.duration || t.duration
  const volumePct = Math.round((st.muted ? 0 : st.volume) * 100)

  const onWheel = (e: WheelEvent) => send({ type: 'volumeBy', value: e.deltaY < 0 ? 0.05 : -0.05 })

  return (
    <div className={s.stage} style={{ ['--island-clear' as string]: settings.transparency }}>
      <motion.div
        className={s.island}
        initial={false}
        animate={{ width: size.w, height: size.h, borderRadius: size.r }}
        transition={spring}
        onWheel={onWheel}
        onClick={() => shape !== 'expanded' && settings.expandOn === 'click' && setExpanded(true)}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {shape === 'compact' && (
            <motion.div key="compact" className={s.compact} {...fade}>
              <CompactBody st={st} accent={accent} style={settings.progress} duration={duration} />
            </motion.div>
          )}
          {shape === 'volume' && (
            <motion.div key="volume" className={s.volumeHud} {...fade} role="status" aria-label={`Громкость ${volumePct} %`}>
              <IconSpeaker size={16} level={st.muted || st.volume === 0 ? 0 : st.volume < 0.34 ? 1 : st.volume < 0.67 ? 2 : 3} />
              <span className={s.volumeBar}>
                <i style={{ transform: `scaleX(${st.muted ? 0 : st.volume})` }} />
              </span>
              <span className={s.volumePct}>{st.muted ? 'без звука' : `${volumePct} %`}</span>
            </motion.div>
          )}
          {shape === 'peek' && (
            <motion.div key="peek" className={s.peek} {...fade}>
              <Artwork src={t.cover} size={44} radius={10} seed={t.key} />
              <div style={{ minWidth: 0 }}>
                <div className={`${s.peekTitle} truncate`}>{flash === 'added' ? 'Добавлено в Мою музыку' : flash === 'removed' ? 'Убрано из Моей музыки' : t.title}</div>
                <div className={`${s.peekSub} truncate`}>{flash ? t.title : t.artist}</div>
              </div>
              {flash ? (
                <span className={s.badge} data-kind={flash}>
                  {flash === 'added' ? <IconCheck size={15} /> : <Minus size={15} strokeWidth={2.6} />}
                </span>
              ) : (
                <StatusGlyph st={st} accent={accent} size={18} />
              )}
            </motion.div>
          )}
          {shape === 'expanded' && <Expanded key="expanded" st={st} accent={accent} locked={settings.locked} moved={!!settings.position} waveColor={waveColor} />}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
