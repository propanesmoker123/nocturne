import { Clock3 } from 'lucide-react'
import { Button } from '../components/controls'
import { EmptyState } from '../components/cards'
import { PageHeader } from '../components/PageHeader'
import { TrackList } from '../components/TrackList'
import { saveJSON } from '../lib/persist'
import { usePlayer } from '../player/store'

export function Recent() {
  const history = usePlayer((p) => p.history)
  return (
    <>
      <PageHeader
        title="Недавние"
        subtitle={history.length ? 'Последние 200 треков, которые вы слушали в Nocturne' : undefined}
        actions={
          history.length > 0 && (
            <Button
              onClick={() => {
                usePlayer.setState({ history: [] })
                void saveJSON('history', [])
              }}
            >
              Очистить
            </Button>
          )
        }
      />
      {history.length === 0 ? (
        <EmptyState icon={<Clock3 size={26} />} title="История пуста" text="Здесь появятся треки, которые вы слушаете." />
      ) : (
        <TrackList tracks={history} />
      )}
    </>
  )
}
