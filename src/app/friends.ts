import { useQuery } from '@tanstack/react-query'
import * as vk from '../vk/api'

export const friendsKey = () => ['friends', vk.getMeId()] as const

/** The VK friends list, shared by the friends pages and «Отправить другу». */
export const useFriends = () => useQuery({ queryKey: friendsKey(), queryFn: vk.getFriends, staleTime: 10 * 60_000 })

const fold = (s: string) => s.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim()

/** Search by any part of the name, ignoring case and ё/е. */
export function friendMatches(name: string, query: string): boolean {
  const q = fold(query)
  return !q || fold(name).includes(q)
}
