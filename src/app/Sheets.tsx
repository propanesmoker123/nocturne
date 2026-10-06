import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Spinner } from '../components/controls'
import * as vk from '../vk/api'
import { describeError } from '../vk/errors'
import { queryClient } from './queryClient'
import s from './overlays.module.css'
import { useRouter } from './router'
import { useSheet, type SheetRequest } from './sheetStore'
import { toast } from './toast'
import { addTracksToPlaylist, myPlaylistsKey } from './trackActions'

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
              close()
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
            className={s.sheet}
            initial={{ y: 24, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 12, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            {sheet.kind === 'confirm' ? <ConfirmBody req={sheet} /> : sheet.kind === 'captcha' ? <CaptchaBody req={sheet} /> : <PlaylistForm req={sheet} />}
          </motion.div>
        </Layer>
      )}
    </AnimatePresence>
  )
}
