import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { renderSVG } from 'uqr'
import { useRouter } from '../app/router'
import { useSheet, type SheetRequest } from '../app/sheetStore'
import { toast } from '../app/toast'
import { useUi } from '../app/ui'
import s from '../app/overlays.module.css'
import { Button, Spinner } from '../components/controls'
import d from '../connect/devices.module.css'
import { pluralRu } from '../lib/format'
import { liveEntries, type AlbumDoc } from './model'
import { albumCodeFromLink, albumLink } from './records'
import { useAlbums } from './store'
import { readAlbum } from './sync'

/** «Новый альбом» and «Переименовать». */
export function AlbumNameForm({ req }: { req: Extract<SheetRequest, { kind: 'album-create' | 'album-rename' }> }) {
  const editing = req.kind === 'album-rename' ? req.id : null
  const [name, setName] = useState(editing ? (useAlbums.getState().docs[editing]?.meta.name ?? '') : '')
  const [error, setError] = useState('')
  const close = useSheet((x) => x.close)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return setError('Придумайте название')
    const albums = useAlbums.getState()
    if (editing) {
      albums.rename(editing, n)
      close()
      return
    }
    const id = albums.create(n)
    if (req.kind === 'album-create' && req.addTracks?.length) {
      albums.add(id, req.addTracks)
      toast(`Добавлено в «${n}»`, 'added')
    }
    close()
    // made from «Сейчас играет»: the new album is shown, not hidden under it
    useUi.getState().closeNowPlaying()
    useRouter.getState().push({ name: 'album', id })
  }
  return (
    <form onSubmit={submit}>
      <h2 className={s.sheetTitle}>{editing ? 'Переименовать альбом' : 'Новый альбом'}</h2>
      <p className={s.sheetText}>{editing ? 'Новое имя увидят все, у кого есть этот альбом.' : 'Альбом Nocturne: в нём можно смешивать треки VK и SoundCloud. Он будет на всех ваших связанных устройствах.'}</p>
      <label className={s.field}>
        <span className={s.fieldLabel}>Название</span>
        <input className={s.input} value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Например, «Ночная дорога»" />
      </label>
      {error && <p className={s.error}>{error}</p>}
      <div className={s.sheetActions}>
        <Button onClick={close}>Отмена</Button>
        <Button variant="primary" type="submit">
          {editing ? 'Сохранить' : 'Создать'}
        </Button>
      </div>
    </form>
  )
}

/** The album's code, its QR and link: whoever gets them can listen and edit. */
export function AlbumShareBody({ req }: { req: Extract<SheetRequest, { kind: 'album-share' }> }) {
  const close = useSheet((x) => x.close)
  const code = useAlbums((x) => x.list.find((e) => e.id === req.id)?.code)
  useEffect(() => useAlbums.getState().markShared(req.id), [req.id])
  const qr = useMemo(() => (code ? renderSVG(albumLink(code), { border: 1, whiteColor: '#ffffff', blackColor: '#000000' }) : ''), [code])
  if (!code) return null
  return (
    <>
      <h2 className={s.sheetTitle}>Поделиться альбомом</h2>
      <p className={s.sheetText}>Тот, кому вы дадите код или ссылку, сможет слушать и редактировать альбом. Отозвать доступ — «Сменить код доступа».</p>
      <div className={d.link}>
        <div className={d.qr} aria-label="QR-код альбома" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className={d.code}>{code}</div>
        <p className={d.hint}>На телефоне ссылка открывает Nocturne. На компьютере код или ссылку вставляют в «Альбомы» → «Добавить альбом по коду».</p>
      </div>
      <div className={s.sheetActions}>
        <Button
          onClick={() =>
            void navigator.clipboard.writeText(albumLink(code)).then(
              () => toast('Ссылка на альбом скопирована', 'info'),
              () => toast('Не получилось скопировать', 'error'),
            )
          }
        >
          Скопировать ссылку
        </Button>
        <Button variant="primary" onClick={close}>
          Готово
        </Button>
      </div>
    </>
  )
}

/** «Добавить альбом по коду»: read it, show what it is, add only after a «yes». */
export function AlbumJoinBody() {
  const close = useSheet((x) => x.close)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [found, setFound] = useState<{ code: string; doc: AlbumDoc } | null>(null)

  const look = async (e: FormEvent) => {
    e.preventDefault()
    const code = albumCodeFromLink(typed)
    if (!code) return setError('Это не код альбома — 16 букв и цифр или ссылка nocturne://album')
    setError('')
    setBusy(true)
    const doc = await readAlbum(code, 10_000)
    setBusy(false)
    if (!doc || doc.meta.deletedAt) return setError('Альбом с этим кодом не найден. Проверьте код или подключение к сети')
    const mine = useAlbums.getState().list.find((x) => x.id === doc.id && !x.removedAt)
    if (mine) {
      close()
      useRouter.getState().push({ name: 'album', id: doc.id })
      return toast('Этот альбом уже есть у вас', 'info')
    }
    setFound({ code, doc })
  }

  if (found) {
    const n = liveEntries(found.doc).length
    return (
      <>
        <h2 className={s.sheetTitle}>Добавить альбом «{found.doc.meta.name}» к себе?</h2>
        <p className={s.sheetText}>
          {n} {pluralRu(n, 'трек', 'трека', 'треков')}. Альбом общий: вы и те, у кого есть код, видите изменения друг друга.
        </p>
        <div className={s.sheetActions}>
          <Button onClick={close}>Отмена</Button>
          <Button
            variant="primary"
            onClick={() => {
              const id = useAlbums.getState().join(found.code, found.doc)
              close()
              useRouter.getState().push({ name: 'album', id })
            }}
          >
            Добавить
          </Button>
        </div>
      </>
    )
  }
  return (
    <form onSubmit={look}>
      <h2 className={s.sheetTitle}>Добавить альбом по коду</h2>
      <p className={s.sheetText}>Вставьте код или ссылку, которые вам прислали.</p>
      <label className={s.field}>
        <span className={s.fieldLabel}>Код или ссылка</span>
        <input className={s.input} value={typed} autoFocus spellCheck={false} onChange={(e) => setTyped(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" />
      </label>
      {error && <p className={s.error}>{error}</p>}
      <div className={s.sheetActions}>
        <Button onClick={close}>Отмена</Button>
        <Button variant="primary" type="submit" disabled={busy || !typed.trim()}>
          {busy ? <Spinner size={16} /> : 'Найти'}
        </Button>
      </div>
    </form>
  )
}
