import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../lib/settings'
import { usePlayer } from '../player/store'
import { getComments } from '../sc/api'
import type { ScComment } from '../sc/normalize'
import { scKeys } from '../sc/queries'
import { useScSession } from '../sc/session'
import { commentsOf, passing, placeComments, type CommentSlot } from '../sc/waveComments'
import { serviceOf } from '../vk/models'
import s from './WaveComments.module.css'

/** How far a plate may hang past its avatar before it is turned to the inside. */
const PLATE_HALF = 140

/**
 * SoundCloud comments of the playing track as small avatars along the waveform (`size` px):
 * a hover shows who said what, an avatar lights up while the track plays through it. Nothing
 * at all for a VK track, while signed out, offline, or with the setting off.
 */
export function WaveComments({ size }: { size: number }) {
  const current = usePlayer((p) => p.current)
  const durationS = usePlayer((p) => p.duration || p.current?.duration || 0)
  const positionMs = usePlayer((p) => p.position * 1000)
  const on = useSettings((x) => x.waveComments)
  const signedIn = useScSession((x) => x.phase === 'signed-in')
  const trackId = current && serviceOf(current) === 'sc' ? current.id : undefined
  const q = useQuery({
    queryKey: scKeys.comments(trackId ?? 0),
    queryFn: () => getComments(trackId!),
    enabled: on && signedIn && trackId !== undefined,
    staleTime: 10 * 60_000,
    retry: false,
  })
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  // another track: no plate left open from the last one
  useEffect(() => setOpen(null), [trackId])

  useEffect(() => {
    const el = box.current
    if (!el) return
    // measured at once too: the observer only reports with the next drawn frame
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [trackId, on])

  if (!on || trackId === undefined) return null
  const slots = placeComments(commentsOf(q.data, trackId), durationS * 1000, width, size)
  return (
    <div ref={box} className={s.layer} style={{ ['--size' as string]: `${size}px` }}>
      {slots.map((slot) => (
        <Avatar
          key={`${trackId}:${slot.x}`}
          slot={slot}
          align={slot.x < PLATE_HALF ? 'start' : slot.x > width - PLATE_HALF ? 'end' : 'middle'}
          lit={passing(slot, positionMs)}
          open={open === slot.x}
          onOpen={() => setOpen(slot.x)}
          onClose={() => setOpen((x) => (x === slot.x ? null : x))}
        />
      ))}
    </div>
  )
}

function Face({ c }: { c: ScComment }) {
  const [broken, setBroken] = useState(false)
  if (c.user.avatar && !broken) return <img className={s.face} src={c.user.avatar} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  return <span className={`${s.face} ${s.letter}`}>{(c.user.name.trim()[0] ?? '?').toUpperCase()}</span>
}

function Avatar({ slot, align, lit, open, onOpen, onClose }: { slot: CommentSlot; align: 'start' | 'middle' | 'end'; lit: boolean; open: boolean; onOpen(): void; onClose(): void }) {
  const [first] = slot.comments
  const more = slot.comments.length - 3
  return (
    <div className={s.slot} style={{ left: slot.x }} data-lit={lit || undefined} data-open={open || undefined} onPointerEnter={onOpen} onPointerLeave={onClose}>
      <Face c={first} />
      {open && (
        <div className={s.plate} data-align={align} role="tooltip">
          {slot.comments.slice(0, 3).map((c) => (
            <p key={c.id} className={s.line}>
              <b>{c.user.name || 'SoundCloud'}:</b> {c.body}
            </p>
          ))}
          {more > 0 && <p className={s.more}>и ещё {more}</p>}
        </div>
      )}
    </div>
  )
}
