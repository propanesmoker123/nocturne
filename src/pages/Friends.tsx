import { useQuery } from '@tanstack/react-query'
import { Lock, Users } from 'lucide-react'
import { useEffect } from 'react'
import { useChrome } from '../app/chrome'
import { useRouter } from '../app/router'
import { Carousel, EmptyState, PlaylistCard, Section, TrackListSkeleton } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { formatLongDuration, pluralRu } from '../lib/format'
import { useAllPages } from '../lib/hooks'
import * as vk from '../vk/api'
import { describeError, VkError } from '../vk/errors'
import s from './pages.module.css'

const friendsKey = () => ['friends', vk.getMeId()] as const

export function Friends() {
  const q = useQuery({ queryKey: friendsKey(), queryFn: vk.getFriends, staleTime: 10 * 60_000 })
  const push = useRouter((r) => r.push)
  const friends = q.data ?? []
  const open = friends.filter((f) => f.canSeeAudio)
  const closed = friends.filter((f) => !f.canSeeAudio)

  return (
    <>
      <PageHeader title="Друзья" subtitle={q.data ? `${open.length} ${pluralRu(open.length, 'друг делится', 'друга делятся', 'друзей делятся')} музыкой` : undefined} />
      {q.isLoading && <div className={s.hint}>Загружаем друзей…</div>}
      {q.isError && <EmptyState icon={<Users size={26} />} title="Друзья не загрузились" text={describeError(q.error)} />}
      {q.data && friends.length === 0 && <EmptyState icon={<Users size={26} />} title="Друзей пока нет" />}
      {friends.length > 0 && (
        <div className={s.people}>
          {[...open, ...closed].map((f) => (
            <button
              key={f.id}
              type="button"
              className={s.person}
              data-locked={!f.canSeeAudio || undefined}
              onClick={() => push({ name: 'friend', id: f.id, title: f.name })}
            >
              <span style={{ position: 'relative' }}>
                {f.photo ? <img className={s.personPhoto} src={f.photo} alt="" referrerPolicy="no-referrer" loading="lazy" /> : <span className={s.personPhoto} style={{ display: 'block' }} />}
                {!f.canSeeAudio && (
                  <span className={s.lock}>
                    <Lock size={14} strokeWidth={2.2} />
                  </span>
                )}
              </span>
              <span className={s.personName}>{f.name}</span>
              {!f.canSeeAudio && <span className={s.personSub}>Музыка скрыта</span>}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export function FriendPage({ id, title }: { id: number; title?: string }) {
  const friends = useQuery({ queryKey: friendsKey(), queryFn: vk.getFriends, staleTime: 10 * 60_000 })
  const friend = friends.data?.find((f) => f.id === id)
  const name = friend?.name ?? title ?? 'Друг'
  const tracks = useAllPages(['tracks', id], (offset) => vk.getTracks(id, offset, 500))
  const playlists = useQuery({ queryKey: ['playlists', id], queryFn: () => vk.getPlaylists(id, 0, 50), retry: false })
  const setTitle = useChrome((c) => c.setTitle)
  useEffect(() => setTitle(name), [name, setTitle])
  const hidden = tracks.isError && VkError.from(tracks.error).isAccessDenied
  const totalSec = tracks.items.reduce((n, t) => n + t.duration, 0)

  return (
    <>
      <div className={s.profile}>
        {friend?.photo ? <img className={s.profilePhoto} src={friend.photo} alt="" referrerPolicy="no-referrer" /> : <span className={s.profilePhoto} style={{ background: 'var(--fill-3)' }} />}
        <div>
          <h1 style={{ font: 'var(--t-large)', letterSpacing: 'var(--track-large)', margin: 0 }}>{name}</h1>
          {tracks.total > 0 && (
            <div className={s.meta}>
              {tracks.total} {pluralRu(tracks.total, 'трек', 'трека', 'треков')} · {formatLongDuration(totalSec)}
            </div>
          )}
        </div>
      </div>
      {hidden ? (
        <EmptyState icon={<Lock size={26} />} title="Музыка скрыта" text={`${name} не открыл(а) свои аудиозаписи.`} />
      ) : (
        <>
          {playlists.data && playlists.data.items.length > 0 && (
            <Section title="Плейлисты">
              <Carousel>
                {playlists.data.items.map((p) => (
                  <PlaylistCard key={`${p.ownerId}_${p.id}`} playlist={p} />
                ))}
              </Carousel>
            </Section>
          )}
          <Section title="Треки">
            {tracks.isLoading && <TrackListSkeleton />}
            {tracks.isError && !hidden && <EmptyState title="Треки не загрузились" text={describeError(tracks.error)} />}
            {tracks.items.length > 0 && <TrackList tracks={tracks.items} />}
            {!tracks.isLoading && !tracks.isError && tracks.items.length === 0 && <EmptyState title="Треков нет" />}
          </Section>
        </>
      )}
    </>
  )
}
