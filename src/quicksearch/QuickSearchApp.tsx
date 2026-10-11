import { ListPlus, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Artwork } from '../components/Artwork'
import { EqualizerBars, Spinner } from '../components/controls'
import { IconCheck, IconPause } from '../components/Icons'
import { EV, type QuickPlay, type QuickQuery, type QuickResults, type QuickTrack } from '../lib/events'
import { formatTime } from '../lib/format'
import { emitTo, invoke, isTauri, listen } from '../lib/tauri'
import { buildRows, firstTrack, indexOfKey, keyIntent, step } from './model'
import s from './quicksearch.module.css'

/** How the panel talks to the main window; the browser demo swaps in a fake one. */
export interface QuickTransport {
  query(q: QuickQuery): void
  play(p: QuickPlay): void
  hide(): void
}

const tauriTransport: QuickTransport = {
  query: (q) => void emitTo('main', EV.quickQuery, q),
  play: (p) => void emitTo('main', EV.quickPlay, p),
  hide: () => void invoke('search_hide').catch(() => {}),
}

const DEBOUNCE = 140
const MIN_QUERY = 2

function TrackRow({
  track,
  id,
  selected,
  current,
  playing,
  queued,
  onHover,
  onPlay,
  onNext,
}: {
  track: QuickTrack
  id: string
  selected: boolean
  current: boolean
  playing: boolean
  queued: boolean
  onHover(): void
  onPlay(): void
  onNext(): void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={!track.playable || undefined}
      className={s.row}
      data-selected={selected || undefined}
      data-disabled={!track.playable || undefined}
      onMouseMove={onHover}
      onClick={() => track.playable && onPlay()}
    >
      <span className={s.cover}>
        <Artwork src={track.cover} size={40} radius={9} seed={track.key} />
        {current && (
          <span className={s.current} aria-label={playing ? 'Сейчас играет' : 'На паузе'}>
            {playing ? <EqualizerBars playing height={13} width={2.5} color="#fff" /> : <IconPause size={15} />}
          </span>
        )}
      </span>
      <span className={s.text}>
        <span className={s.title}>
          <span className={s.trunc}>
            {track.title}
            {track.subtitle && <span className={s.subtitle}> {track.subtitle}</span>}
          </span>
          {track.explicit && <span className={s.explicit}>E</span>}
        </span>
        <span className={`${s.artist} ${s.trunc}`}>{track.artist}</span>
      </span>
      {queued ? (
        <span className={s.queued}>
          <IconCheck size={13} /> Следующим
        </span>
      ) : selected && track.playable ? (
        <button
          type="button"
          className={s.nextBtn}
          title="Включить после текущего (Shift+Enter)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onNext()
          }}
        >
          <ListPlus size={14} strokeWidth={2.2} /> Следующим
        </button>
      ) : (
        <span />
      )}
      <span className={s.duration}>{formatTime(track.duration)}</span>
    </div>
  )
}

/**
 * Quick search over every app (Ctrl+Alt+F): type, pick with the arrows, Enter plays,
 * Shift+Enter puts the track next, Esc or a click elsewhere closes the panel.
 */
export function QuickSearchApp() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<QuickResults | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set())
  const transport = useRef(tauriTransport)
  const sent = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => (res ? buildRows(res.own, res.others) : []), [res])
  const at = indexOfKey(rows, selKey)
  const sel = at >= 0 ? at : firstTrack(rows)

  const sendQuery = useCallback((value: string) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => transport.current.query({ seq: ++sent.current, q: value }),
      value.trim().length < MIN_QUERY ? 0 : DEBOUNCE,
    )
  }, [])

  const onResults = useCallback((r: QuickResults) => {
    if (r.seq !== sent.current) return
    if (r.accent) document.documentElement.style.setProperty('--accent', r.accent)
    setRes(r)
  }, [])

  // Shown again: keep the last query but select it, so typing starts a new one
  const onOpen = useCallback(() => {
    setQueued(new Set())
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
    if (el.value.trim().length >= MIN_QUERY) sendQuery(el.value)
    panel.current?.animate(
      [
        { opacity: 0, transform: 'translateY(-8px) scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  }, [sendQuery])

  useEffect(() => {
    const offs = [listen<QuickResults>(EV.quickResults, (e) => onResults(e.payload)), listen(EV.quickOpen, onOpen)]
    const refocus = () => input.current?.focus()
    window.addEventListener('focus', refocus)
    return () => {
      offs.forEach((p) => void p.then((off) => off()))
      window.removeEventListener('focus', refocus)
    }
  }, [onResults, onOpen])

  // Browser dev only: search.html#demo answers from a fake library, #demo=query types it in (dropped from release builds)
  useEffect(() => {
    if (!import.meta.env.DEV || isTauri() || !location.hash.startsWith('#demo')) return
    void import('./demo').then((m) => {
      transport.current = m.demoTransport(onResults)
      onOpen()
      const typed = decodeURIComponent(location.hash.split('=')[1] ?? '')
      if (typed) {
        setQ(typed)
        sendQuery(typed)
      }
    })
  }, [onResults, onOpen, sendQuery])

  useEffect(() => {
    list.current?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const act = (key: string, next: boolean) => {
    transport.current.play({ key, next })
    if (next) setQueued((prev) => new Set(prev).add(key))
    else transport.current.hide()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const intent = keyIntent(e)
    if (!intent) return
    e.preventDefault()
    if (intent === 'close') return transport.current.hide()
    if (intent === 'up' || intent === 'down') {
      const i = step(rows, sel, intent === 'up' ? -1 : 1)
      const row = rows[i]
      if (row?.kind === 'track') setSelKey(row.track.key)
      return
    }
    const row = rows[sel]
    if (row?.kind === 'track' && row.track.playable) act(row.track.key, intent === 'next')
  }

  const searching = q.trim().length >= MIN_QUERY
  const loading = searching && (!res || res.loading)
  const selected = rows[sel]

  return (
    <div
      className={s.stage}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) transport.current.hide()
      }}
    >
      <div ref={panel} className={s.panel} role="dialog" aria-label="Быстрый поиск">
        <div className={s.field}>
          <Search size={20} strokeWidth={2.2} className={s.fieldIcon} aria-hidden="true" />
          <input
            ref={input}
            className={s.input}
            value={q}
            placeholder="Трек или исполнитель"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-label="Найти трек"
            aria-expanded={searching && rows.length > 0}
            aria-controls="quick-results"
            aria-activedescendant={selected?.kind === 'track' ? selected.id : undefined}
            onChange={(e) => {
              setQ(e.target.value)
              setSelKey(null)
              sendQuery(e.target.value)
            }}
            onKeyDown={onKeyDown}
          />
          {loading ? <Spinner size={16} /> : <span />}
        </div>

        {searching && rows.length > 0 && (
          <div ref={list} id="quick-results" className={s.list} role="listbox" aria-label="Найденные треки">
            {rows.map((r, i) =>
              r.kind === 'header' ? (
                <div key={r.id} className={s.header} role="presentation">
                  {r.label}
                </div>
              ) : (
                <TrackRow
                  key={r.id}
                  id={r.id}
                  track={r.track}
                  selected={i === sel}
                  current={r.track.key === res?.playingKey}
                  playing={!!res?.playing}
                  queued={queued.has(r.track.key)}
                  onHover={() => i !== sel && r.track.playable && setSelKey(r.track.key)}
                  onPlay={() => act(r.track.key, false)}
                  onNext={() => act(r.track.key, true)}
                />
              ),
            )}
            {res?.error && <div className={s.note}>{res.error}</div>}
          </div>
        )}
        {searching && !loading && rows.length === 0 && <div className={s.empty}>{res?.error ?? 'Ничего не нашлось'}</div>}

        <div className={s.footer} aria-hidden="true">
          <span>
            <kbd className={s.kbd}>↑</kbd>
            <kbd className={s.kbd}>↓</kbd> выбрать
          </span>
          <span>
            <kbd className={s.kbd}>Enter</kbd> играть
          </span>
          <span>
            <kbd className={s.kbd}>Shift</kbd>+<kbd className={s.kbd}>Enter</kbd> следующим
          </span>
          <span className={s.footerEnd}>
            <kbd className={s.kbd}>Esc</kbd> закрыть
          </span>
        </div>
      </div>
    </div>
  )
}
