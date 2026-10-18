import { Heart } from 'lucide-react'
import { albumMenuItems } from '../albums/addMenu'
import { isInLibrary, likeLabel, toggleLibrary } from '../app/library'
import { showMenu } from '../app/menu'
import type { Track } from '../vk/models'
import { IconButton } from './controls'
import { IconPlus } from './Icons'

interface Props {
  track: Track
  size: number
  iconSize: number
  className?: string
}

/** The heart: the service's own like — VK's «Моя музыка», SoundCloud's likes. */
export function HeartButton({ track, size, iconSize, className }: Props) {
  const liked = isInLibrary(track)
  return (
    <IconButton className={className} size={size} active={liked} label={likeLabel(track, liked)} onClick={() => void toggleLibrary(track)}>
      <Heart size={iconSize} strokeWidth={2} fill={liked ? 'currentColor' : 'none'} />
    </IconButton>
  )
}

/** The plus: into one of Nocturne's own albums, whatever the service. */
export function AlbumAddButton({ track, size, iconSize, className }: Props) {
  return (
    <IconButton className={className} size={size} label="Добавить в альбом Nocturne" onClick={(e) => showMenu(e, albumMenuItems([track]))}>
      <IconPlus size={iconSize} />
    </IconButton>
  )
}
