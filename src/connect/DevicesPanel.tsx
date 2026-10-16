import { Monitor, MonitorSmartphone, Smartphone } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { renderSVG } from 'uqr'
import { Button, IconButton } from '../components/controls'
import { isAndroid } from '../lib/platform'
import { usePlayer } from '../player/store'
import { useTogether } from '../together/session'
import { ensureCode, joinGroup, useDevices } from './devices'
import s from './devices.module.css'
import { linkFor } from './link'
import { onlineDevices } from './logic'
import { playHere, playOn } from './runtime'

/** The code (made on first need) with its QR, and a field for a code from another device. */
export function LinkDevice({ onLinked }: { onLinked?: () => void }) {
  const code = useDevices((d) => d.code)
  const qr = useMemo(() => (code ? renderSVG(linkFor(code), { border: 1, whiteColor: '#ffffff', blackColor: '#000000' }) : ''), [code])
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  // the code is made the first time this device offers to link another (not while rendering)
  useEffect(() => {
    if (!code) ensureCode()
  }, [code])
  if (!code) return null
  return (
    <div className={s.link}>
      <div className={s.qr} aria-label="QR-код для связи устройств" dangerouslySetInnerHTML={{ __html: qr }} />
      <div className={s.code}>{code}</div>
      <p className={s.hint}>Отсканируйте камерой телефона или введите этот код в Nocturne на другом устройстве.</p>
      <form
        className={s.join}
        onSubmit={(e) => {
          e.preventDefault()
          if (!joinGroup(typed)) return setError('Это не код Nocturne — 16 букв и цифр')
          setError('')
          setTyped('')
          onLinked?.()
        }}
      >
        <input className={s.input} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Код с другого устройства" aria-label="Код с другого устройства" spellCheck={false} />
        <Button type="submit" disabled={!typed.trim()}>
          Связать
        </Button>
      </form>
      {error && <p className={s.error}>{error}</p>}
    </div>
  )
}

/** This device and the linked ones online; a tap moves the music there. */
export function DevicesList() {
  const { name, remoteId, devices } = useDevices()
  const playingHere = usePlayer((p) => p.isPlaying && !p.remoteName)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const others = onlineDevices(devices, now)
  return (
    <div className={s.list}>
      <button type="button" className={s.device} data-active={!remoteId || undefined} onClick={() => remoteId && playHere()}>
        {isAndroid ? <Smartphone size={20} /> : <Monitor size={20} />}
        <span className={s.deviceText}>
          <span className={s.deviceName}>{name} · это устройство</span>
          <span className={s.deviceSub}>{remoteId ? 'Нажмите, чтобы играть здесь' : playingHere ? 'Играет здесь' : 'Ничего не играет'}</span>
        </span>
      </button>
      {others.map((d) => (
        <button key={d.id} type="button" className={s.device} data-active={remoteId === d.id || undefined} onClick={() => playOn(d.id)}>
          {d.presence.platform === 'android' ? <Smartphone size={20} /> : <Monitor size={20} />}
          <span className={s.deviceText}>
            <span className={s.deviceName}>{d.presence.name}</span>
            <span className={`${s.deviceSub} truncate`}>{d.presence.track ? `${d.presence.playing ? 'Играет' : 'Пауза'}: ${d.presence.track.artist} — ${d.presence.track.title}` : 'Ничего не играет'}</span>
          </span>
        </button>
      ))}
      {others.length === 0 && <p className={s.hint}>Других устройств сейчас нет в сети. Откройте Nocturne на телефоне или компьютере, связанном с этим.</p>}
    </div>
  )
}

/** The «Устройства» button: lit while another device plays; its card lists the devices or offers to link one. */
export function DevicesButton() {
  const [open, setOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const code = useDevices((d) => d.code)
  const remoteName = usePlayer((p) => p.remoteName)
  const togetherOn = useTogether((t) => !!t.role)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={box} className={s.anchor}>
      <IconButton
        size={32}
        label={remoteName ? `Играет на устройстве «${remoteName}»` : 'Устройства'}
        active={open || !!remoteName}
        onClick={() => {
          // not linked yet: the card opens on the code and QR (its first render makes the code)
          if (!open && !code) setLinking(true)
          setOpen(!open)
        }}
      >
        <MonitorSmartphone size={18} strokeWidth={2} />
      </IconButton>
      {open && (
        <div className={s.card} role="dialog" aria-label="Устройства">
          <div className={s.title}>Устройства</div>
          {togetherOn && <p className={s.hint}>Пока идёт совместное прослушивание, музыку не перенести.</p>}
          {!code || linking ? (
            <>
              {!code && <p className={s.hint}>Свяжите телефон и компьютер: музыка будет переезжать между ними, а одно станет пультом для другого.</p>}
              <LinkDevice onLinked={() => setLinking(false)} />
              {code && (
                <Button onClick={() => setLinking(false)}>
                  Готово
                </Button>
              )}
            </>
          ) : (
            <>
              <DevicesList />
              <button type="button" className={s.more} onClick={() => setLinking(true)}>
                Связать ещё устройство
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
