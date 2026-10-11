import { create } from 'zustand'

/**
 * Peaks of the track on screen. Its own tiny module so the island window can show the waveform
 * without pulling in the player and hls.js; the main window fills it, the island gets a copy.
 */
export interface WaveformState {
  key: string | null
  peaks: Float32Array | null
}

export const useWaveform = create<WaveformState>(() => ({ key: null, peaks: null }))
