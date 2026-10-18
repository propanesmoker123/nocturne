import { create } from 'zustand'
import { loadJSON, saveJSON } from '../lib/persist'
import type { ServiceId } from '../vk/models'
import { routeService, useRouter, type Route } from './router'

export interface ServiceInfo {
  id: ServiceId
  name: string
  /** the brand colour: the rail's ring, the sidebar's mark (never the app's accent) */
  color: string
  home: Route
}

/** The rail, top to bottom. YouTube or Spotify would be one more line here and one more set of pages. */
export const SERVICES: ServiceInfo[] = [
  { id: 'vk', name: 'VK Музыка', color: '#0077ff', home: { name: 'home' } },
  { id: 'sc', name: 'SoundCloud', color: '#ff5500', home: { name: 'sc-home' } },
]

export const serviceInfo = (id: ServiceId): ServiceInfo => SERVICES.find((s) => s.id === id) ?? SERVICES[0]

/** The page each service was last on: picking it again goes back there. */
const lastRoute = new Map<ServiceId, Route>()

interface ServiceState {
  /** follows the pages: going to a SoundCloud page selects SoundCloud */
  current: ServiceId
  select(id: ServiceId): void
}

export const useService = create<ServiceState>(() => ({
  current: 'vk',
  select(id) {
    useRouter.getState().push(lastRoute.get(id) ?? serviceInfo(id).home)
  },
}))

function follow(r: Route) {
  const s = routeService(r)
  if (!s) return
  lastRoute.set(s, r)
  if (useService.getState().current === s) return
  useService.setState({ current: s })
  void saveJSON('service', s)
}

let following = false

/** Opens where the person left off (VK or SoundCloud) and keeps the rail in step with the pages. */
export async function initService() {
  const saved = await loadJSON<ServiceId>('service')
  if (!following) {
    following = true
    useRouter.subscribe((st, prev) => st.route !== prev.route && follow(st.route))
  }
  if (saved === 'sc') {
    useService.setState({ current: 'sc' })
    useRouter.getState().replace(serviceInfo('sc').home)
  }
}
