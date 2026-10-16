import { call } from '../vk/api'
import { journal } from './journal'

/**
 * The time as VK's servers have it. Linked devices and listening together stamp their messages
 * with it and judge others' by it, and relays turn away events whose time is far off — so a
 * computer clock a couple of minutes off would otherwise go unheard. Everything else keeps
 * using the local clock.
 */

let offset = 0

/** Milliseconds since the epoch, by VK's clock once it was asked (the local one until then). */
export const serverNow = () => Date.now() + offset

/** Below this the local clock is good enough (the answer is in whole seconds anyway). */
const NOISE_MS = 2000
const SLOW_MS = 5000

/** Asks VK for the time once; a failed or slow answer keeps what we had. */
export async function syncServerTime(ask: () => Promise<number> = () => call<number>('utils.getServerTime')): Promise<boolean> {
  const t0 = Date.now()
  let seconds: number
  try {
    seconds = await ask()
  } catch {
    return false
  }
  const t1 = Date.now()
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || t1 - t0 > SLOW_MS) return false
  // the server read its clock somewhere in the middle of the round trip, and in the middle of that second
  const measured = seconds * 1000 + 500 - (t0 + t1) / 2
  const next = Math.abs(measured) < NOISE_MS || Math.abs(measured) > 86_400_000 ? 0 : Math.round(measured)
  if (Math.abs(next - offset) >= NOISE_MS) journal('clock', `this clock is ${Math.round(next / 1000)} s off VK's`)
  offset = next
  return true
}

let started = false

/** Asks now (again a minute later while signed out or offline), then every hour. */
export function startServerTimeSync() {
  if (started) return
  started = true
  const run = async () => setTimeout(run, (await syncServerTime()) ? 3_600_000 : 60_000)
  void run()
}
