export type RoomBand = {
  frequency: number
  level: number
  relative: number
}

export type EqSuggestion = {
  frequency: number
  gain: number
  q: number
}

const centers = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000]
const octaveRatio = 2 ** (1 / 6)

export function spectrumBinRange(sampleRate: number, fftSize: number) {
  const binWidth = sampleRate / fftSize
  return {
    start: Math.max(1, Math.ceil(centers[0] / octaveRatio / binWidth)),
    end: Math.min(fftSize / 2, Math.ceil(centers[centers.length - 1] * octaveRatio / binWidth)),
  }
}

export function analyzeSpectrum(
  powerSums: Float64Array,
  observations: number,
  sampleRate: number,
  fftSize: number,
): { bands: RoomBand[]; suggestions: EqSuggestion[] } {
  if (observations <= 0) throw new Error('No spectrum data was collected.')
  const binWidth = sampleRate / fftSize
  const bands = centers.flatMap((frequency) => {
    const lower = frequency / octaveRatio
    const upper = frequency * octaveRatio
    if (upper > sampleRate / 2) return []
    let power = 0
    for (let bin = Math.max(1, Math.ceil(lower / binWidth)); bin < powerSums.length && bin * binWidth < upper; bin += 1) {
      power += powerSums[bin] / observations
    }
    return power > 0 ? [{ frequency, level: 10 * Math.log10(power), relative: 0 }] : []
  })
  if (bands.length < 5) throw new Error('Not enough frequency data was received. Check the microphone and try again.')
  const sorted = bands.map((band) => band.level).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const reference = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  for (const band of bands) band.relative = band.level - reference

  const candidates = bands
    .filter((band, index) =>
      band.relative >= 3 &&
      (index === 0 || band.level >= bands[index - 1].level) &&
      (index === bands.length - 1 || band.level >= bands[index + 1].level),
    )
    .sort((a, b) => b.relative - a.relative)
  const suggestions: EqSuggestion[] = []
  for (const band of candidates) {
    if (suggestions.some((item) => Math.abs(Math.log2(item.frequency / band.frequency)) < 0.5)) continue
    suggestions.push({
      frequency: band.frequency,
      gain: -Math.min(6, Math.round(band.relative * 2) / 2),
      q: 1.4,
    })
    if (suggestions.length === 4) break
  }
  return { bands, suggestions }
}
