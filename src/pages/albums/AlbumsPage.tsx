import { Disc3, Plus } from 'lucide-react'
import { useRouter } from '../../app/router'
import { useSheet } from '../../app/sheetStore'
import { liveEntries } from '../../albums/model'
import { useAlbums } from '../../albums/store'
import { Artwork } from '../../components/Artwork'
import { Button } from '../../components/controls'
import { EmptyState } from '../../components/cards'
import c from '../../components/cards.module.css'
import { PageHeader } from '../../components/PageHeader'
import { useDevices } from '../../connect/devices'
import { pluralRu } from '../../lib/format'
import a from './albums.module.css'

/** «Альбомы»: Nocturne's own albums, any service's tracks inside. */
export function AlbumsPage() {
  const list = useAlbums((x) => x.list)
  const docs = useAlbums((x) => x.docs)
  const linked = useDevices((x) => !!x.code)
  const push = useRouter((r) => r.push)
  const albums = list.filter((e) => !e.removedAt && docs[e.id] && !docs[e.id].meta.deletedAt)
  const open = useSheet.getState().open
  return (
    <>
      <PageHeader
        title="Альбомы"
        subtitle={!linked ? 'Свяжите телефон в «Устройствах», чтобы альбомы были и там' : undefined}
        actions={
          <>
            <Button onClick={() => open({ kind: 'album-join' })}>Добавить альбом по коду</Button>
            <Button variant="primary" onClick={() => open({ kind: 'album-create' })}>
              <Plus size={15} strokeWidth={2.4} /> Новый альбом
            </Button>
          </>
        }
      />
      {albums.length === 0 ? (
        <EmptyState icon={<Disc3 size={26} />} title="Альбомов пока нет" text="Соберите свой альбом из треков VK и SoundCloud — плюс в строке трека добавляет его в альбом." />
      ) : (
        <div className={a.grid}>
          {albums.map((e) => {
            const doc = docs[e.id]
            const live = liveEntries(doc)
            const covers = live.map((x) => x.track!.cover).filter((u): u is string => !!u).slice(0, 4)
            const name = doc.meta.name || e.name
            return (
              <div key={e.id} className={c.card}>
                <button type="button" className={c.cover} onClick={() => push({ name: 'album', id: e.id })} aria-label={name}>
                  <Artwork mosaic={covers.length >= 4 ? covers : undefined} src={covers.length < 4 ? covers[0] : undefined} size="100%" radius={12} seed={name} style={{ aspectRatio: '1', height: 'auto' }} />
                </button>
                <button type="button" className={c.cardTitle} onClick={() => push({ name: 'album', id: e.id })}>
                  {name}
                </button>
                <div className={`${c.cardSub} truncate`}>
                  {[e.shared ? 'Общий' : null, `${live.length} ${pluralRu(live.length, 'трек', 'трека', 'треков')}`].filter(Boolean).join(' · ')}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
