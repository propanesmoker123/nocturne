/** One ping/pong: sent at t0 and answered at t2 on the listener clock, read as t1 on the host clock. */
export interface ClockSample {
  t0: number
  t1: number
  t2: number
}

/** How far the host clock is ahead of ours, assuming the trip took as long both ways. */
export function sampleOffset({ t0, t1, t2 }: ClockSample): { offset: number; rtt: number } {
  const rtt = t2 - t0
  return { offset: t1 - (t0 + rtt / 2), rtt }
}

/** The offset from the fastest round trip (least room for a lopsided trip); 0 until measured. */
export function bestOffset(samples: ClockSample[]): number {
  let best: { offset: number; rtt: number } | null = null
  for (const s of samples) {
    const m = sampleOffset(s)
    if (m.rtt >= 0 && (!best || m.rtt < best.rtt)) best = m
  }
  return best?.offset ?? 0
}
