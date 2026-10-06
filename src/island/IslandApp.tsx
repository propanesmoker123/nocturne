import { LocateFixed, Minus, Pin, PinOff } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react'
import { Artwork } from '../components/Artwork'
import { EqualizerBars, IconButton, Spinner } from '../components/controls'
import { IconBackward, IconCheck, IconForward, IconPause, IconPlay, IconPlus, IconRepeat, IconShuffle, IconSpeaker } from '../components/Icons'
import { Slider } from '../components/Slider'
import { EV, type PlayerCommand, type PlayerSnapshot } from '../lib/events'
import { formatTime } from '../lib/format'
import { DEFAULT_SETTINGS, type IslandSettings } from '../lib/settings'
import { emitTo, invoke, isTauri, listen } from '../lib/tauri'
import { COLLAPSE_DELAY, SHAPES, hitRect, isInteractive, type IslandShape } from './geometry'
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

function Expanded({ st, accent, locked, moved }: { st: PlayerSnapshot; accent: string; locked: boolean; moved: boolean }) {
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
          <EqualizerBars playing={st.isPlaying} height={16} color={accent} />
        </div>
      </div>
      <div className={s.time}>
        <span>{formatTime(pos)}</span>
        <Slider
          size="sm"
          label="Позиция трека"
          value={d ? pos / d : 0}
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
    ]
    offs.push(watchMoves())
    void emitTo('main', EV.requestState)
    return () => offs.forEach((p) => void p.then((off) => off()))
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

  const hasTrack = !!st?.track
  const shape: IslandShape = expanded && hasTrack ? 'expanded' : (peek || flash) && hasTrack ? 'peek' : 'compact'

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

  const onWheel = (e: WheelEvent) => send({ type: 'volumeBy', value: e.deltaY < 0 ? 0.05 : -0.05 })

  return (
    <div className={s.stage}>
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
              <Artwork className={s.compactArt} src={t.cover} size={24} radius={7} seed={t.key} />
              {st.isLoading && st.isPlaying ? <Spinner size={14} /> : <EqualizerBars playing={st.isPlaying} height={14} color={accent} />}
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
                <EqualizerBars playing={st.isPlaying} height={18} width={3.5} color={accent} />
              )}
            </motion.div>
          )}
          {shape === 'expanded' && <Expanded key="expanded" st={st} accent={accent} locked={settings.locked} moved={!!settings.position} />}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
