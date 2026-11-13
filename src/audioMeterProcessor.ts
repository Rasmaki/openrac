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
    this.intervalSums = { raw: 0, a: 0, b: 0, c: 0 }
    this.intervalSamples = 0
    this.intervalPeak = 0
    this.intervalChunks = 0
    this.reportEvery = Math.max(1, Math.round(sampleRate / 10))
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0)

    const input = inputs[0]?.[0]
    const frames = input?.length ?? outputs[0]?.[0]?.length ?? 128
    this.intervalChunks += 1

    for (let index = 0; index < frames; index += 1) {
      const raw = input?.[index] ?? 0
      const a = filterSample(this.filters.a, raw)
      const b = filterSample(this.filters.b, raw)
      const c = filterSample(this.filters.c, raw)
      const powers = { raw: raw * raw, a: a * a, b: b * b, c: c * c }

      for (const kind of ['raw', 'a', 'b', 'c']) {
        this.meterSums[kind] += powers[kind] - this.meterRings[kind][this.ringIndex]
        this.meterRings[kind][this.ringIndex] = powers[kind]
        this.intervalSums[kind] += powers[kind]
      }

      this.eqSum += powers.a - this.eqRing[this.eqIndex]
      this.eqRing[this.eqIndex] = powers.a
      this.eqIndex = (this.eqIndex + 1) % this.eqSize
      this.ringIndex = (this.ringIndex + 1) % this.windowSize
      this.intervalPeak = Math.max(this.intervalPeak, Math.abs(raw))
      this.intervalSamples += 1
      this.totalSamples += 1
      this.reportSamples += 1

      if (this.reportSamples >= this.reportEvery) {
        this.reportSamples -= this.reportEvery
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

    this.port.postMessage({
      rms: {
        raw: Math.sqrt(Math.max(0, this.meterSums.raw) / meterDivisor),
        a: Math.sqrt(Math.max(0, this.meterSums.a) / meterDivisor),
        b: Math.sqrt(Math.max(0, this.meterSums.b) / meterDivisor),
        c: Math.sqrt(Math.max(0, this.meterSums.c) / meterDivisor),
        aeq: Math.sqrt(Math.max(0, this.eqSum) / eqDivisor),
      },
      intervalRawPower: this.intervalSums.raw / intervalDivisor,
      intervalSamples,
      peak: this.intervalPeak,
      chunks: this.intervalChunks,
    })

    this.intervalSums = { raw: 0, a: 0, b: 0, c: 0 }
    this.intervalSamples = 0
    this.intervalPeak = 0
    this.intervalChunks = 0
  }
}

registerProcessor('audio-meter-processor', AudioMeterProcessor)
`
