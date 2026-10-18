import { create } from 'zustand'
import { isAndroid } from '../lib/platform'
import { loadJSON, saveJSON } from '../lib/persist'
import { normalizeCode } from '../together/code'
import { newDeviceId, newGroupCode } from './link'
import type { SeenDevice } from './logic'

/** What is kept on this device: who it is, and the group code once linked. */
interface Saved {
  deviceId: string
  name: string
  code: string | null
}

export interface DevicesState extends Saved {
  ready: boolean
  /** Other devices of the group as last heard. */
  devices: Record<string, SeenDevice>
  /** The device this one steers (remote mode), or null. */
  remoteId: string | null
}

export const defaultDeviceName = () => (isAndroid ? 'Телефон' : 'Компьютер')

export const useDevices = create<DevicesState>(() => ({ ready: false, deviceId: '', name: defaultDeviceName(), code: null, devices: {}, remoteId: null }))

const save = () => {
  const { deviceId, name, code } = useDevices.getState()
  void saveJSON('devices', { deviceId, name, code } satisfies Saved)
}

export async function loadDevices() {
  const saved = await loadJSON<Partial<Saved>>('devices')
  const keepId = typeof saved?.deviceId === 'string' && /^[0-9a-f]{16}$/.test(saved.deviceId)
  const deviceId = keepId ? saved!.deviceId! : newDeviceId()
  const name = typeof saved?.name === 'string' && saved.name.trim() ? saved.name.trim().slice(0, 40) : defaultDeviceName()
  const code = typeof saved?.code === 'string' ? normalizeCode(saved.code) : null
  useDevices.setState({ ready: true, deviceId, name, code, devices: {}, remoteId: null })
  if (!keepId) save()
}

/** The group code, made the first time this device offers to link another. */
export function ensureCode(): string {
  const have = useDevices.getState().code
  if (have) return have
  const code = newGroupCode()
  useDevices.setState({ code })
  save()
  return code
}

/** Joins the group of a code typed in or read from a QR link; false for something that is not a code. */
export function joinGroup(input: string): boolean {
  const code = normalizeCode(input)
  if (!code) return false
  // remote mode is left by the runtime when the channel closes, never by just forgetting it here
  useDevices.setState({ code, devices: {} })
  save()
  return true
}

export function renameDevice(name: string) {
  const n = name.trim().slice(0, 40)
  if (!n) return
  useDevices.setState({ name: n })
  save()
}

const unlinkListeners = new Set<(kind: 'here' | 'all') => void>()

/** Hears unlinking: `all` (a new code, every other device cut off) or `here` (this device left). */
export function onUnlink(fn: (kind: 'here' | 'all') => void): () => void {
  unlinkListeners.add(fn)
  return () => void unlinkListeners.delete(fn)
}

/** This device leaves the group; the others stay together. */
export function unlinkHere() {
  useDevices.setState({ code: null, devices: {} })
  save()
  for (const fn of unlinkListeners) fn('here')
}

/** A new code here: every other device loses the link and has to be linked again. */
export function unlinkAll() {
  useDevices.setState({ code: newGroupCode(), devices: {} })
  save()
  for (const fn of unlinkListeners) fn('all')
}
