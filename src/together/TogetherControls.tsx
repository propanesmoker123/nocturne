import { Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { toast } from '../app/toast'
import { Button, IconButton, Spinner } from '../components/controls'
import { findCode, inviteText } from './code'
import type { ListenerState } from './protocol'
import { TOGETHER_ERRORS, clearTogetherError, joinSession, leaveSession, startHosting, useTogether } from './session'
import s from './together.module.css'

const usePanel = create<{ open: boolean; set(open: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }))

/** A listener does not seek or skip: the host does. Null when the player is the person's own. */
export function useControlledBy(): string | null {
  return useTogether((t) => (t.role === 'listener' ? (t.hostName ?? 'ведущий') : null))
}

const STATE_LABEL: Record<ListenerState, string> = {
  connecting: 'подключается',
  listening: 'слушает',
  paused: 'на паузе',
  unavailable: 'трек недоступен',
}

function ErrorLine() {
  const error = useTogether((t) => t.error)
  return error ? (
    <p className={s.error} role="alert">
      {TOGETHER_ERRORS[error]}
    </p>
  ) : null
}

function Start({ onJoin }: { onJoin(): void }) {
  return (
    <>
      <h3 className={s.title}>Слушать вместе</h3>
      <p className={s.text}>Друзья слышат то же, что и вы, с той же секунды. Соединение идёт напрямую между компьютерами.</p>
      <ErrorLine />
      <div className={s.actions}>
        <Button
          variant="primary"
          onClick={() => {
            clearTogetherError()
            void startHosting()
          }}
        >
          Начать
        </Button>
        <Button variant="tinted" onClick={onJoin}>
          Присоединиться
        </Button>
      </div>
    </>
  )
}

function Join({ onBack }: { onBack(): void }) {
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    // A copied invite fills itself in
    navigator.clipboard
      ?.readText()
      .then((text) => {
        const found = findCode(text)
        if (found) setCode((c) => c || found)
      })
      .catch(() => {})
  }, [])
  const submit = () => {
    clearTogetherError()
    void joinSession(code)
  }
  return (
    <>
      <h3 className={s.title}>Присоединиться</h3>
      <input
        ref={input}
        className={s.code}
        value={code}
        placeholder="Код из приглашения"
        spellCheck={false}
        autoComplete="off"
        aria-label="Код из приглашения"
        onChange={(e) => {
          setCode(e.target.value)
          if (useTogether.getState().error) clearTogetherError()
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <ErrorLine />
      <div className={s.actions}>
        <Button variant="primary" onClick={submit} disabled={!code.trim()}>
          Подключиться
        </Button>
        <Button
          onClick={() => {
            clearTogetherError()
            onBack()
          }}
        >
          Назад
        </Button>
      </div>
    </>
  )
}

function Hosting() {
  const { code, listeners, phase, offline } = useTogether()
  const [copied, setCopied] = useState(false)
  if (phase === 'connecting' || !code) {
    return (
      <p className={s.wait}>
        <Spinner size={16} /> Готовим комнату…
      </p>
    )
  }
  const copy = () =>
    void navigator.clipboard.writeText(inviteText(code)).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      },
      () => toast('Не удалось скопировать — перепишите код вручную', 'error'),
    )
  return (
    <>
      <h3 className={s.title}>Вы ведёте</h3>
      <p className={s.label}>Код приглашения</p>
      <p className={s.bigCode}>{code}</p>
      <Button variant="tinted" onClick={copy}>
        {copied ? 'Скопировано' : 'Скопировать приглашение'}
      </Button>
      {offline && <p className={s.error}>Нет связи для поиска собеседников — друзья пока не найдут вас</p>}
      <p className={s.label}>
        Слушатели · {listeners.length} из 5
      </p>
      {listeners.length === 0 ? (
        <p className={s.text}>Пока никого. Отправьте приглашение другу в любом мессенджере.</p>
      ) : (
        <ul className={s.people}>
          {listeners.map((l) => (
            <li key={l.peer}>
              <span className={s.avatar} aria-hidden="true">
                {l.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={s.name}>{l.name}</span>
              <span className={s.state} data-state={l.state}>
                {STATE_LABEL[l.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={s.actions}>
        <Button variant="danger" onClick={leaveSession}>
          Завершить
        </Button>
      </div>
    </>
  )
}

function Listening() {
  const { hostName, phase, unavailable } = useTogether()
  if (phase === 'connecting') {
    return (
      <>
        <p className={s.wait}>
          <Spinner size={16} /> Ищем ведущего…
        </p>
        <div className={s.actions}>
          <Button onClick={leaveSession}>Отменить</Button>
        </div>
      </>
    )
  }
  return (
    <>
      <h3 className={s.title}>Вместе с {hostName ?? 'ведущим'}</h3>
      <p className={s.text}>
        {phase === 'reconnecting'
          ? 'Связь с ведущим потеряна — переподключаемся…'
          : unavailable
            ? 'У вас этот трек недоступен — ждём следующий'
            : 'Играет синхронно с ведущим'}
      </p>
      <p className={s.hint}>Пауза — только у вас. «Играть» — догнать ведущего.</p>
      <div className={s.actions}>
        <Button onClick={leaveSession}>Выйти</Button>
      </div>
    </>
  )
}

/** «Слушать вместе» in the mini player: the button and its card above the bar. */
export function TogetherButton() {
  const { open, set } = usePanel()
  const role = useTogether((t) => t.role)
  const [joining, setJoining] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) set(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, set])
  useEffect(() => {
    if (!open || role) setJoining(false)
  }, [open, role])

  return (
    <div ref={box} className={s.anchor}>
      <IconButton size={32} label="Слушать вместе" active={open || !!role} onClick={() => set(!open)}>
        <Users size={18} strokeWidth={2.1} />
      </IconButton>
      {open && (
        <div className={s.card} role="dialog" aria-label="Слушать вместе">
          {role === 'host' ? <Hosting /> : role === 'listener' ? <Listening /> : joining ? <Join onBack={() => setJoining(false)} /> : <Start onJoin={() => setJoining(true)} />}
        </div>
      )}
    </div>
  )
}

/** A pill above the mini player while a session is on; it opens the card. */
export function TogetherBanner() {
  const { role, phase, hostName, listeners, offline } = useTogether()
  const openPanel = usePanel((p) => p.set)
  if (!role || phase === 'connecting') return null
  const text =
    role === 'host'
      ? `Вы ведёте · слушателей: ${listeners.length}${offline ? ' · нет связи' : ''}`
      : `Вместе с ${hostName ?? 'ведущим'}${phase === 'reconnecting' ? ' · переподключаемся…' : ''}`
  return (
    <div className={s.banner} data-warn={phase === 'reconnecting' || offline || undefined}>
      <button type="button" className={s.bannerText} onClick={() => openPanel(true)}>
        <span className={s.dot} aria-hidden="true" />
        {text}
      </button>
      {role === 'listener' && (
        <button type="button" className={s.bannerAction} onClick={leaveSession}>
          Выйти
        </button>
      )}
    </div>
  )
}
