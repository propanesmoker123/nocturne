import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { Bell, Megaphone, MessageCircle, RefreshCw, Sparkles } from 'lucide-react'
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, IconButton, Segmented, Spinner, Switch } from '../components/controls'
import { sendFeedback, type FeedbackKind } from '../lib/feedback'
import { journalTail } from '../lib/journal'
import { compareSemver, formatNotificationDate, useNotifications } from '../lib/notifications'
import { useUpdates } from '../lib/updates'
import * as vk from '../vk/api'
import { LinkDevice } from '../connect/DevicesPanel'
import { describeError, VkError } from '../vk/errors'
import type { Friend } from '../vk/models'
import { friendMatches, useFriends } from './friends'
import { queryClient } from './queryClient'
import s from './overlays.module.css'
import { useRouter } from './router'
import { useSheet, type SheetRequest } from './sheetStore'
import { toast } from './toast'
import { addTracksToPlaylist, copyTrackLink, myPlaylistsKey } from './trackActions'
import { splitNotes } from '../lib/whatsNew'
import { AlbumJoinBody, AlbumNameForm, AlbumShareBody } from '../albums/AlbumSheets'

function PlaylistForm({ req }: { req: Extract<SheetRequest, { kind: 'playlist-create' | 'playlist-edit' }> }) {
  const editing = req.kind === 'playlist-edit' ? req.playlist : null
  const [title, setTitle] = useState(editing?.title ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = useSheet((x) => x.close)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) {
      setError('Придумайте название')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (editing) {
        await vk.editPlaylist(editing, t, description.trim())
        toast('Плейлист сохранён', 'info')
        void queryClient.invalidateQueries({ queryKey: ['playlist', editing.ownerId, editing.id] })
      } else {
        const created = await vk.createPlaylist(t, description.trim())
        if (req.kind === 'playlist-create' && req.addTracks?.length) await addTracksToPlaylist(created, req.addTracks)
        else toast('Плейлист создан', 'added')
        useRouter.getState().push({ name: 'playlist', ownerId: created.ownerId, id: created.id, accessKey: created.accessKey })
      }
      void queryClient.invalidateQueries({ queryKey: myPlaylistsKey() })
      close()
    } catch (err) {
      setError(describeError(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className={s.sheetTitle}>{editing ? 'Изменить плейлист' : 'Новый плейлист'}</h2>
      <p className={s.sheetText}>{editing ? 'Название и описание видны всем, кому доступен плейлист.' : 'Плейлист появится в VK и на всех ваших устройствах.'}</p>
      <label className={s.field}>
        <span className={s.fieldLabel}>Название</span>
        <input className={s.input} value={title} maxLength={128} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Например, «Ночной город»" />
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>Описание</span>
        <textarea className={s.textarea} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} placeholder="Необязательно" />
      </label>
      {error && <p className={s.error}>{error}</p>}
      <div className={s.sheetActions}>
        <Button onClick={close}>Отмена</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? <Spinner size={16} /> : editing ? 'Сохранить' : 'Создать'}
        </Button>
      </div>
    </form>
  )
}

function NotesBody({ req }: { req: Extract<SheetRequest, { kind: 'notes' }> }) {
  const close = useSheet((x) => x.close)
  return (
    <>
      <h2 className={s.sheetTitle}>{req.title}</h2>
      <ul className={s.notes}>
        {splitNotes(req.notes).map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className={s.sheetActions}>
        <Button onClick={close}>{req.action ? 'Позже' : 'Понятно'}</Button>
        {req.action && (
          <Button
            variant="primary"
            onClick={() => {
              close()
              req.action!.run()
            }}
          >
            {req.action.label}
          </Button>
        )}
      </div>
    </>
  )
}

function ConfirmBody({ req }: { req: Extract<SheetRequest, { kind: 'confirm' }> }) {
  const [busy, setBusy] = useState(false)
  const close = useSheet((x) => x.close)
  return (
    <>
      <h2 className={s.sheetTitle}>{req.title}</h2>
      <p className={s.sheetText}>{req.message}</p>
      <div className={s.sheetActions}>
        <Button onClick={close}>Отмена</Button>
        <Button
          variant={req.danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await req.onConfirm()
              // an action that opened another sheet (a new album code) keeps that one
              if (useSheet.getState().sheet === req) close()
            } catch (e) {
              toast(describeError(e), 'error')
              setBusy(false)
            }
          }}
        >
          {busy ? <Spinner size={16} /> : req.confirmLabel}
        </Button>
      </div>
    </>
  )
}

function CaptchaBody({ req }: { req: Extract<SheetRequest, { kind: 'captcha' }> }) {
  const [key, setKey] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim()) req.resolve(key.trim())
      }}
    >
      <h2 className={s.sheetTitle}>VK просит подтвердить, что вы не робот</h2>
      <p className={s.sheetText}>Введите символы с картинки — действие выполнится сразу после этого.</p>
      <img className={s.captcha} src={req.img} alt="Код с картинки" referrerPolicy="no-referrer" />
      <input className={s.input} value={key} autoFocus onChange={(e) => setKey(e.target.value)} placeholder="Символы с картинки" />
      <div className={s.sheetActions} style={{ marginTop: 16 }}>
        <Button onClick={() => req.resolve(null)}>Отмена</Button>
        <Button variant="primary" type="submit" disabled={!key.trim()}>
          Отправить
        </Button>
      </div>
    </form>
  )
}

/** Many friends render slowly; the search narrows the rest. */
const FRIENDS_SHOWN = 200

function SendTrackBody({ req }: { req: Extract<SheetRequest, { kind: 'send-track' }> }) {
  const friends = useFriends()
  const [query, setQuery] = useState('')
  const [sending, setSending] = useState<number | null>(null)
  const close = useSheet((x) => x.close)
  const t = req.track
  const found = (friends.data ?? []).filter((f) => friendMatches(f.name, query))

  const send = async (f: Friend) => {
    setSending(f.id)
    try {
      await vk.sendTrack(f.id, t)
      toast(`Отправлено: ${f.name}`, 'added')
      close()
    } catch (e) {
      const err = VkError.from(e)
      // 7/15 (or an auth refusal on this one method): this VK sign-in may not send messages at all — hand over the link instead
      if (err.kind === 'auth' || (err.kind === 'vk' && (err.code === 7 || err.code === 15))) {
        await copyTrackLink(t).catch(() => {})
        toast('VK не дал отправить из Nocturne — ссылка на трек скопирована', 'info')
        close()
        return
      }
      toast(err.kind === 'vk' && (err.code === 900 || err.code === 902) ? `${f.name} принимает сообщения не от всех` : describeError(err), 'error')
      setSending(null)
    }
  }

  return (
    <>
      <h2 className={s.sheetTitle}>Поделиться треком</h2>
      <p className={s.sheetText}>
        «{t.title}» — {t.artist}. Выберите друга — трек придёт ему в личные сообщения VK.
      </p>
      <input className={s.input} value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder="Найти друга" aria-label="Найти друга" />
      <div className={s.friendList}>
        {friends.isLoading ? (
          <div className={s.friendNote}>
            <Spinner />
          </div>
        ) : friends.isError ? (
          <p className={s.friendNote}>{describeError(friends.error)}</p>
        ) : found.length === 0 ? (
          <p className={s.friendNote}>{query.trim() ? 'Никого не нашли' : 'Друзей пока нет'}</p>
        ) : (
          found.slice(0, FRIENDS_SHOWN).map((f) => (
            <button key={f.id} type="button" className={s.friendRow} disabled={sending !== null} onClick={() => void send(f)}>
              {f.photo ? <img className={s.friendPhoto} src={f.photo} alt="" referrerPolicy="no-referrer" loading="lazy" /> : <span className={s.friendPhoto} />}
              <span className={`${s.friendName} truncate`}>{f.name}</span>
              {sending === f.id && <Spinner size={16} />}
            </button>
          ))
        )}
      </div>
      <div className={s.sheetActions}>
        <Button
          onClick={() => {
            void copyTrackLink(t).then(() => toast('Ссылка скопирована', 'info'))
            close()
          }}
        >
          Скопировать ссылку
        </Button>
        <Button onClick={close}>Отмена</Button>
      </div>
    </>
  )
}

function LinkDeviceBody() {
  const close = useSheet((x) => x.close)
  return (
    <>
      <h2 className={s.sheetTitle}>Связать устройство</h2>
      <p className={s.sheetText}>Музыка будет переезжать между связанными устройствами, а одно станет пультом для другого.</p>
      <LinkDevice onLinked={close} />
      <div className={s.sheetActions}>
        <Button onClick={close}>Готово</Button>
      </div>
    </>
  )
}

function FeedbackBody({ req }: { req: Extract<SheetRequest, { kind: 'feedback' }> }) {
  const initialKind = req.defaultKind ?? 'bug'
  const [kind, setKind] = useState<FeedbackKind>(initialKind)
  const [message, setMessage] = useState('')
  const [contact, setContact] = useState('')
  const [includeLog, setIncludeLog] = useState(initialKind === 'bug')
  const [logTouched, setLogTouched] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = useSheet((x) => x.close)

  const changeKind = (next: FeedbackKind) => {
    setKind(next)
    if (!logTouched) setIncludeLog(next === 'bug')
  }

  const togglePreview = async () => {
    if (preview !== null) {
      setPreview(null)
      return
    }
    const raw = (await journalTail().catch(() => '')) || ''
    setPreview(raw.trim() ? raw.slice(-8000) : 'Журнал пока пуст')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed) {
      setError(kind === 'bug' ? 'Опишите, что пошло не так' : 'Напишите вашу идею или отзыв')
      return
    }
    setBusy(true)
    setError('')
    try {
      await sendFeedback({ kind, message: trimmed, contact, includeLog })
      toast('Спасибо! Отчёт отправлен разработчику', 'added')
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className={s.sheetTitle}>Обратная связь</h2>
      <p className={s.sheetText}>Отправляется напрямую разработчику в Telegram. Ни ваш аккаунт, ни пароли или треки не передаются.</p>
      <div className={s.feedbackSwitch}>
        <Segmented
          id="feedback-kind"
          value={kind}
          onChange={changeKind}
          options={[
            { value: 'bug', label: 'Ошибка (баг)' },
            { value: 'idea', label: 'Идея / отзыв' },
          ]}
        />
      </div>
      <label className={s.field}>
        <span className={s.fieldLabel}>{kind === 'bug' ? 'Что случилось и как повторить' : 'Описание идеи или пожелания'}</span>
        <textarea
          className={s.textarea}
          value={message}
          maxLength={4000}
          autoFocus
          onChange={(e) => setMessage(e.target.value)}
          placeholder={kind === 'bug' ? 'Например: при входе в SoundCloud через Google открывается белое окно…' : 'Например: хочется видеть…'}
        />
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>Контакт для ответа (необязательно)</span>
        <input
          className={s.input}
          value={contact}
          maxLength={160}
          onChange={(e) => setContact(e.target.value)}
          placeholder="@telegram или почта, если нужен ответ"
        />
      </label>
      <div className={s.feedbackLogRow}>
        <div className={s.feedbackLogMeta}>
          <span className={s.feedbackLogTitle}>Прикрепить журнал работы</span>
          <button type="button" className={s.feedbackPreviewBtn} onClick={() => void togglePreview()}>
            {preview !== null ? 'Скрыть лог' : 'Посмотреть что внутри'}
          </button>
        </div>
        <Switch
          label="Прикрепить журнал работы"
          checked={includeLog}
          onChange={(v) => {
            setLogTouched(true)
            setIncludeLog(v)
          }}
        />
      </div>
      {preview !== null && <pre className={s.feedbackLogBox}>{preview}</pre>}
      {error && <p className={s.error}>{error}</p>}
      <div className={s.sheetActions}>
        <Button onClick={close}>Отмена</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? <Spinner size={16} /> : 'Отправить'}
        </Button>
      </div>
    </form>
  )
}

function NotificationsBody() {
  const [tab, setTab] = useState<'all' | 'replies' | 'updates'>('all')
  const items = useNotifications((n) => n.items)
  const sentReports = useNotifications((n) => n.sentReports)
  const highlightedIds = useNotifications((n) => n.highlightedIds)
  const loading = useNotifications((n) => n.loading)
  const error = useNotifications((n) => n.error)
  const refresh = useNotifications((n) => n.refresh)
  const updater = useUpdates()
  const close = useSheet((x) => x.close)
  const openFeedback = () => useSheet.getState().open({ kind: 'feedback', defaultKind: 'bug' })

  const highlighted = new Set(highlightedIds)
  const repliedIds = new Set(
    items.filter((x): x is Extract<(typeof items)[number], { kind: 'reply' }> => x.kind === 'reply').map((x) => x.reply.reportId),
  )
  const waitingReports = sentReports.filter((r) => !repliedIds.has(r.id))
  const visible = items.filter((item) => {
    if (tab === 'replies') return item.kind === 'reply'
    if (tab === 'updates') return item.kind === 'release' || item.kind === 'announcement'
    return true
  })

  return (
    <>
      <div className={s.notifHeader}>
        <h2 className={s.sheetTitle} style={{ margin: 0 }}>
          Уведомления
        </h2>
        <IconButton
          size={30}
          label="Проверить ответы и обновления"
          disabled={loading}
          onClick={() => void refresh(false)}
        >
          <RefreshCw size={15} className={loading ? s.notifSpin : undefined} />
        </IconButton>
      </div>

      <div className={s.notifFilter}>
        <Segmented
          id="notifications-filter"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'replies', label: 'Ответы' },
            { value: 'updates', label: 'Обновления' },
          ]}
        />
      </div>

      <div className={s.notifList}>
        {loading && !visible.length && !(tab === 'replies' && waitingReports.length) ? (
          <div className={s.notifEmpty}>
            <Spinner />
          </div>
        ) : error && !visible.length && !(tab === 'replies' && waitingReports.length) ? (
          <div className={s.notifEmpty}>
            <p className={s.notifEmptyTitle}>{error}</p>
            <Button onClick={() => void refresh(false)}>Повторить</Button>
          </div>
        ) : !visible.length && !(tab === 'replies' && waitingReports.length) ? (
          <div className={s.notifEmpty}>
            <Bell size={22} strokeWidth={1.7} className={s.notifEmptyIcon} />
            <p className={s.notifEmptyTitle}>
              {tab === 'replies' ? 'Ответов от разработчика пока нет' : tab === 'updates' ? 'Список обновлений пуст' : 'Новых уведомлений нет'}
            </p>
            <p className={s.notifEmptySub}>
              {tab === 'replies'
                ? 'Когда вы отправите баг через форму обратной связи, ответ придёт прямо сюда.'
                : 'Здесь появляются релизы Nocturne и личные ответы на ваши обращения.'}
            </p>
          </div>
        ) : (
          <>
            {visible.map((item) => {
              const isNew = highlighted.has(item.itemId)
              if (item.kind === 'reply') {
                const r = item.reply
                return (
                  <div key={item.itemId} className={s.notifItem} data-new={isNew ? 'true' : undefined}>
                    <div className={s.notifMeta}>
                      <span className={s.notifAuthor}>
                        <MessageCircle size={14} />
                        Ответ разработчика
                      </span>
                      <span className={s.notifMetaRight}>
                        {isNew && <span className={s.notifPillNew}>Новое</span>}
                        {r.createdAt > 0 && <span className={s.notifDate}>{formatNotificationDate(r.createdAt)}</span>}
                      </span>
                    </div>
                    {r.reportMessage && <div className={s.notifQuote}>Ваш отчёт: «{r.reportMessage}»</div>}
                    <p className={s.notifBody}>{r.message}</p>
                    <div className={s.notifItemActions}>
                      <button type="button" className={s.feedbackPreviewBtn} onClick={openFeedback}>
                        Написать ещё
                      </button>
                    </div>
                  </div>
                )
              }

              if (item.kind === 'announcement') {
                const a = item.announcement
                return (
                  <div key={item.itemId} className={s.notifItem} data-new={isNew ? 'true' : undefined}>
                    <div className={s.notifMeta}>
                      <span className={s.notifAuthor}>
                        <Megaphone size={14} />
                        {a.title || 'Объявление'}
                      </span>
                      <span className={s.notifMetaRight}>
                        {isNew && <span className={s.notifPillNew}>Новое</span>}
                        {a.createdAt > 0 && <span className={s.notifDate}>{formatNotificationDate(a.createdAt)}</span>}
                      </span>
                    </div>
                    <p className={s.notifBody}>{a.message}</p>
                  </div>
                )
              }

              const rel = item.release
              const points = rel.notes ? splitNotes(rel.notes) : []
              const canInstall =
                item.isAvailable &&
                updater.phase === 'available' &&
                Boolean(updater.version) &&
                compareSemver(updater.version!, rel.version) === 0
              const isDownloading = updater.phase === 'downloading' && Boolean(updater.version) && compareSemver(updater.version!, rel.version) === 0

              return (
                <div key={item.itemId} className={s.notifItem} data-new={isNew ? 'true' : undefined}>
                  <div className={s.notifMeta}>
                    <span className={s.notifAuthor}>
                      <Sparkles size={14} />
                      Nocturne {rel.version}
                    </span>
                    <span className={s.notifMetaRight}>
                      {item.isAvailable && <span className={s.notifPillAvail}>Доступно</span>}
                      {item.isCurrent && !item.isAvailable && <span className={s.notifPillCurrent}>Установлено</span>}
                      {isNew && !item.isAvailable && <span className={s.notifPillNew}>Новое</span>}
                      {rel.publishedAt && <span className={s.notifDate}>{formatNotificationDate(rel.publishedAt)}</span>}
                    </span>
                  </div>
                  {points.length > 0 ? (
                    <ul className={`${s.notes} ${s.notifNotes}`}>
                      {points.map((p, idx) => (
                        <li key={idx}>{p}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className={s.notifBody}>Вышла новая версия Nocturne.</p>
                  )}
                  {(canInstall || isDownloading) && (
                    <div className={s.notifItemActions}>
                      <Button
                        variant="primary"
                        disabled={isDownloading}
                        onClick={() => {
                          void updater.install()
                          close()
                        }}
                      >
                        {isDownloading ? `Загрузка ${Math.round(updater.progress * 100)}%` : 'Установить обновление'}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}

            {tab === 'replies' &&
              waitingReports.map((rep) => (
                <div key={`wait:${rep.id}`} className={s.notifItem}>
                  <div className={s.notifMeta}>
                    <span className={s.notifAuthorMuted}>Отправленное обращение</span>
                    <span className={s.notifMetaRight}>
                      <span className={s.notifPillCurrent}>Ожидает ответа</span>
                      {rep.createdAt > 0 && <span className={s.notifDate}>{formatNotificationDate(rep.createdAt)}</span>}
                    </span>
                  </div>
                  <p className={s.notifBodyMuted}>«{rep.preview}»</p>
                </div>
              ))}
          </>
        )}
      </div>

      <div className={s.notifFooter}>
        <Button variant="tinted" onClick={openFeedback}>
          Сообщить о баге
        </Button>
        <Button onClick={close}>Закрыть</Button>
      </div>
    </>
  )
}

/** The dimming layer stops catching clicks as soon as it starts leaving. */
function Layer({ children, onDismiss }: { children: ReactNode; onDismiss(): void }) {
  const present = useIsPresent()
  return (
    <motion.div
      className={s.sheetLayer}
      style={{ pointerEvents: present ? 'auto' : 'none' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(e) => e.target === e.currentTarget && onDismiss()}
    >
      {children}
    </motion.div>
  )
}

export function Sheets() {
  const sheet = useSheet((x) => x.sheet)
  const seq = useSheet((x) => x.seq)
  const close = useSheet((x) => x.close)

  useEffect(() => {
    if (!sheet) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, close])

  return (
    <AnimatePresence>
      {sheet && (
        <Layer key="sheet" onDismiss={close}>
          <motion.div
            role="dialog"
            aria-modal="true"
            className={sheet.kind === 'notifications' ? `${s.sheet} ${s.sheetWide}` : s.sheet}
            initial={{ y: 24, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 12, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            {/* a new opening is a new body: a form opened again starts empty */}
            <Fragment key={seq}>
              {sheet.kind === 'confirm' ? (
                <ConfirmBody req={sheet} />
              ) : sheet.kind === 'notes' ? (
                <NotesBody req={sheet} />
              ) : sheet.kind === 'captcha' ? (
                <CaptchaBody req={sheet} />
              ) : sheet.kind === 'send-track' ? (
                <SendTrackBody req={sheet} />
              ) : sheet.kind === 'link-device' ? (
                <LinkDeviceBody />
              ) : sheet.kind === 'album-create' || sheet.kind === 'album-rename' ? (
                <AlbumNameForm req={sheet} />
              ) : sheet.kind === 'album-share' ? (
                <AlbumShareBody req={sheet} />
              ) : sheet.kind === 'album-join' ? (
                <AlbumJoinBody />
              ) : sheet.kind === 'feedback' ? (
                <FeedbackBody req={sheet} />
              ) : sheet.kind === 'notifications' ? (
                <NotificationsBody />
              ) : (
                <PlaylistForm req={sheet} />
              )}
            </Fragment>
          </motion.div>
        </Layer>
      )}
    </AnimatePresence>
  )
}
