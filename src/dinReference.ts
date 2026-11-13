export type ReferenceStatus = {
  tone: 'neutral' | 'below' | 'notice' | 'warning' | 'exceeded'
  text: string
}

export function peakReference(value: number | null, clipped: boolean): ReferenceStatus {
  if (value === null) return { tone: 'neutral', text: 'Calibration and live audio required' }
  if (value > 135) return { tone: 'exceeded', text: 'Above 135 dB(C) peak reference' }
  if (clipped) return { tone: 'warning', text: 'Input clipped; peak is unreliable' }
  return { tone: 'below', text: 'At or below 135 dB(C) peak reference' }
}

export function averageReference(
  value: number | null,
  complete: boolean,
  clipped: boolean,
): ReferenceStatus {
  if (value === null) return { tone: 'neutral', text: 'Calibration and live audio required' }
  if (!complete) return { tone: 'neutral', text: 'Waiting for 30 minutes of audio' }
  if (value > 99) return { tone: 'exceeded', text: 'Above 99 dB(A) reference' }
  if (clipped) return { tone: 'warning', text: 'Input clipped; average is unreliable' }
  if (value >= 95) return { tone: 'warning', text: '95 dB(A) reference reached; conditions apply' }
  if (value >= 85) return { tone: 'notice', text: '85 dB(A) reference reached; audience information applies' }
  return { tone: 'below', text: 'Below 85 dB(A) reference' }
}
