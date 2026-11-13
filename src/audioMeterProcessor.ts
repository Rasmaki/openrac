export const audioMeterProcessorSource = `
const TAU = 2 * Math.PI

function prewarpedFrequency(frequency) {
  return 2 * sampleRate * Math.tan(Math.PI * frequency / sampleRate)
}

function highPassSection(frequency) {
  const k = 2 * sampleRate
  const w = prewarpedFrequency(frequency)
  const denominator = k + w
  return {
    b: [k / denominator, -k / denominator],
    a: [1, (w - k) / denominator],
  }
}

function lowPassSection(frequency) {
  const k = 2 * sampleRate
  const w = prewarpedFrequency(frequency)
  const denominator = k + w
  return {
    b: [k / denominator, k / denominator],
    a: [1, (w - k) / denominator],
  }
}

function differentiatorSection() {
  return { b: [1, -1], a: [1, 1] }
}

function responseAt(sections, frequency) {
  const angle = TAU * frequency / sampleRate
  let real = 1
  let imaginary = 0

  for (const section of sections) {
    let numeratorReal = 0
    let numeratorImaginary = 0
    let denominatorReal = 0
    let denominatorImaginary = 0

    for (let index = 0; index < section.b.length; index += 1) {
      const phase = angle * index
      numeratorReal += section.b[index] * Math.cos(phase)
      numeratorImaginary -= section.b[index] * Math.sin(phase)
    }
    for (let index = 0; index < section.a.length; index += 1) {
      const phase = angle * index
      denominatorReal += section.a[index] * Math.cos(phase)
      denominatorImaginary -= section.a[index] * Math.sin(phase)
    }

    const denominatorMagnitude =
      denominatorReal * denominatorReal + denominatorImaginary * denominatorImaginary
    const sectionReal =
      (numeratorReal * denominatorReal + numeratorImaginary * denominatorImaginary) /
      denominatorMagnitude
    const sectionImaginary =
      (numeratorImaginary * denominatorReal - numeratorReal * denominatorImaginary) /
      denominatorMagnitude
    const nextReal = real * sectionReal - imaginary * sectionImaginary
    imaginary = real * sectionImaginary + imaginary * sectionReal
    real = nextReal
  }

  return Math.sqrt(real * real + imaginary * imaginary)
}

function makeWeighting(kind) {
  const sections = [
    highPassSection(20.598997),
    highPassSection(20.598997),
  ]

  if (kind === 'a') {
    sections.push(
      lowPassSection(107.65265),
      lowPassSection(737.86223),
      highPassSection(12194.217),
      highPassSection(12194.217),
    )
  } else if (kind === 'b') {
    sections.push(
      lowPassSection(158.48932),
      differentiatorSection(),
      lowPassSection(12194.217),
      lowPassSection(12194.217),
    )
  } else {
    sections.push(lowPassSection(12194.217), lowPassSection(12194.217))
  }

  return {
    sections: sections.map((section) => ({
      ...section,
      z1: 0,
      z2: 0,
    })),
    gain: 1 / responseAt(sections, 1000),
  }
}

function filterSample(filter, input) {
  let value = input * filter.gain
  for (const section of filter.sections) {
    const output = section.b[0] * value + section.z1
    const b1 = section.b[1] ?? 0
    const b2 = section.b[2] ?? 0
    const a1 = section.a[1] ?? 0
    const a2 = section.a[2] ?? 0
    section.z1 = b1 * value - a1 * output + section.z2
    section.z2 = b2 * value - a2 * output
    value = output
  }
  return value
}

class AudioMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.filters = {
      a: makeWeighting('a'),
      b: makeWeighting('b'),
      c: makeWeighting('c'),
    }
    this.windowSize = Math.max(1, Math.round(sampleRate * 0.125))
    this.eqSize = Math.max(1, Math.round(sampleRate))
    this.meterRings = {
      raw: new Float64Array(this.windowSize),
      a: new Float64Array(this.windowSize),
      b: new Float64Array(this.windowSize),
      c: new Float64Array(this.windowSize),
    }
    this.meterSums = { raw: 0, a: 0, b: 0, c: 0 }
    this.eqRing = new Float64Array(this.eqSize)
    this.eqSum = 0
    this.ringIndex = 0
    this.eqIndex = 0
    this.totalSamples = 0
    this.reportSamples = 0
    this.intervalRawSum = 0
    this.intervalSamples = 0
    this.intervalPeak = 0
    this.intervalCPeak = 0
    this.monitorSize = 18000
    this.monitorRing = new Float64Array(this.monitorSize)
    this.monitorSampleRing = new Uint32Array(this.monitorSize)
    this.monitorClipRing = new Uint8Array(this.monitorSize)
    this.monitorGeneration = 0
    this.monitorAvailable = false
    this.resetMonitor()
    this.port.onmessage = (event) => {
      if (['reset-monitor', 'reset-peaks', 'reset-average'].includes(event.data?.type)) {
        if (event.data.type !== 'reset-average') this.resetPeaks()
        if (event.data.type !== 'reset-peaks') this.resetAverage()
        this.monitorGeneration = event.data.generation
      }
    }
  }

  resetMonitor() {
    this.resetPeaks()
    this.resetAverage()
  }

  resetPeaks() {
    this.monitorRawPeak = 0
    this.monitorCPeak = 0
    this.monitorClipped = false
    this.heldIntervalPeak = 0
    this.heldIntervalCPeak = 0
  }

  resetAverage() {
    this.monitorRing.fill(0)
    this.monitorSampleRing.fill(0)
    this.monitorClipRing.fill(0)
    this.monitorIndex = 0
    this.monitorSum = 0
    this.intervalASum = 0
    this.averageIntervalSamples = 0
    this.averageIntervalClipped = false
    this.monitorSamples = 0
    this.monitorClippedBlocks = 0
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0)

    const input = inputs[0]?.[0]
    if (!!input !== this.monitorAvailable) this.resetMonitor()
    this.monitorAvailable = !!input
    const frames = input?.length ?? outputs[0]?.[0]?.length ?? 128

    for (let index = 0; index < frames; index += 1) {
      const raw = input?.[index] ?? 0
      const a = filterSample(this.filters.a, raw)
      const b = filterSample(this.filters.b, raw)
      const c = filterSample(this.filters.c, raw)
      const rawMagnitude = Math.abs(raw)
      const cMagnitude = Math.abs(c)
      const rawPower = raw * raw
      const aPower = a * a
      const bPower = b * b
      const cPower = c * c
      const ringIndex = this.ringIndex
      const rings = this.meterRings
      const sums = this.meterSums
      sums.raw += rawPower - rings.raw[ringIndex]
      sums.a += aPower - rings.a[ringIndex]
      sums.b += bPower - rings.b[ringIndex]
      sums.c += cPower - rings.c[ringIndex]
      rings.raw[ringIndex] = rawPower
      rings.a[ringIndex] = aPower
      rings.b[ringIndex] = bPower
      rings.c[ringIndex] = cPower
      this.intervalRawSum += rawPower
      this.intervalASum += aPower
      this.averageIntervalSamples += 1
      this.averageIntervalClipped ||= rawMagnitude >= 0.999

      this.eqSum += aPower - this.eqRing[this.eqIndex]
      this.eqRing[this.eqIndex] = aPower
      this.eqIndex += 1
      if (this.eqIndex === this.eqSize) this.eqIndex = 0
      this.ringIndex += 1
      if (this.ringIndex === this.windowSize) this.ringIndex = 0
      this.intervalPeak = Math.max(this.intervalPeak, rawMagnitude)
      this.intervalCPeak = Math.max(this.intervalCPeak, cMagnitude)
      this.heldIntervalPeak = Math.max(this.heldIntervalPeak, rawMagnitude)
      this.heldIntervalCPeak = Math.max(this.heldIntervalCPeak, cMagnitude)
      this.intervalSamples += 1
      this.totalSamples += 1
      this.reportSamples += 10

      if (this.reportSamples >= sampleRate) {
        this.reportSamples -= sampleRate
        this.report()
      }
    }

    return true
  }

  report() {
    const meterDivisor = Math.min(this.totalSamples, this.windowSize)
    const eqDivisor = Math.min(this.totalSamples, this.eqSize)
    const intervalSamples = this.intervalSamples
    const intervalDivisor = Math.max(1, intervalSamples)
    const clipped = this.averageIntervalClipped ? 1 : 0
    if (this.monitorAvailable) {
      this.monitorSum += this.intervalASum - this.monitorRing[this.monitorIndex]
      this.monitorSamples += this.averageIntervalSamples - this.monitorSampleRing[this.monitorIndex]
      this.monitorClippedBlocks += clipped - this.monitorClipRing[this.monitorIndex]
      this.monitorRing[this.monitorIndex] = this.intervalASum
      this.monitorSampleRing[this.monitorIndex] = this.averageIntervalSamples
      this.monitorClipRing[this.monitorIndex] = clipped
      this.monitorIndex = (this.monitorIndex + 1) % this.monitorSize
      this.monitorRawPeak = Math.max(this.monitorRawPeak, this.heldIntervalPeak)
      this.monitorCPeak = Math.max(this.monitorCPeak, this.heldIntervalCPeak)
      this.monitorClipped ||= this.heldIntervalPeak >= 0.999
    }

    this.port.postMessage({
      rms: {
        raw: Math.sqrt(Math.max(0, this.meterSums.raw) / meterDivisor),
        a: Math.sqrt(Math.max(0, this.meterSums.a) / meterDivisor),
        b: Math.sqrt(Math.max(0, this.meterSums.b) / meterDivisor),
        c: Math.sqrt(Math.max(0, this.meterSums.c) / meterDivisor),
        aeq: Math.sqrt(Math.max(0, this.eqSum) / eqDivisor),
      },
      intervalRawPower: this.intervalRawSum / intervalDivisor,
      intervalSamples,
      peak: this.intervalPeak,
      cPeak: this.intervalCPeak,
      monitorRawPeak: this.monitorRawPeak,
      monitorCPeak: this.monitorCPeak,
      monitorClipped: this.monitorClipped,
      monitorWindowClipped: this.monitorClippedBlocks > 0,
      monitorAvailable: this.monitorAvailable,
      monitorSamples: this.monitorSamples,
      monitorARms: this.monitorSamples ? Math.sqrt(Math.max(0, this.monitorSum) / this.monitorSamples) : 0,
      monitorGeneration: this.monitorGeneration,
    })

    this.intervalRawSum = 0
    this.intervalSamples = 0
    this.intervalPeak = 0
    this.intervalCPeak = 0
    this.intervalASum = 0
    this.averageIntervalSamples = 0
    this.averageIntervalClipped = false
    this.heldIntervalPeak = 0
    this.heldIntervalCPeak = 0
  }
}

registerProcessor('audio-meter-processor', AudioMeterProcessor)
`
