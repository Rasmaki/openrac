import { useEffect, useMemo, useRef } from 'react'

type Weighting = 'raw' | 'a' | 'b' | 'c' | 'aeq'
type Levels = Record<Weighting, number>
type Point = { time: number; levels: Levels }

const historyMs = 60_000
const width = 720
const height = 220
const plotLeft = 48
const plotRight = 704
type Plot = { left: number; right: number; top: number; bottom: number }
const series: { key: Weighting; label: string; color: string }[] = [
  { key: 'raw', label: 'SPL', color: '#7c3aed' },
  { key: 'a', label: 'A', color: '#0284c7' },
  { key: 'b', label: 'B', color: '#d97706' },
  { key: 'c', label: 'C', color: '#059669' },
  { key: 'aeq', label: 'Aeq', color: '#db2777' },
]

function decibels(value: number) {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY
}

function setup(canvas: HTMLCanvasElement) {
  const displayWidth = Math.max(1, Math.round(canvas.clientWidth))
  if (canvas.width !== displayWidth) canvas.width = displayWidth
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, canvas.width, height)
  ctx.font = '12px sans-serif'
  ctx.fillStyle = '#64748b'
  ctx.strokeStyle = '#cbd5e1'
  ctx.lineWidth = 1
  return ctx
}

function grid(ctx: CanvasRenderingContext2D, plot: Plot, min: number, max: number, unit: string) {
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i += 1) {
    const y = plot.top + (plot.bottom - plot.top) * i / 4
    ctx.beginPath()
    ctx.moveTo(plot.left, y)
    ctx.lineTo(plot.right, y)
    ctx.stroke()
    ctx.fillText(`${Math.round(max - (max - min) * i / 4)}`, plot.left - 7, y)
  }
  ctx.textAlign = 'left'
  ctx.fillText(unit, 2, 8)
}

function drawSpectrum(canvas: HTMLCanvasElement, analyser: AnalyserNode, sampleRate: number, bins: Float32Array<ArrayBuffer>, plotBins: Uint16Array) {
  const ctx = setup(canvas)
  if (!ctx) return
  const plot = { left: plotLeft, right: Math.max(plotLeft + 1, canvas.width - 16), top: 12, bottom: 188 }
  analyser.getFloatFrequencyData(bins)
  grid(ctx, plot, -100, 0, 'dBFS')
  const maxFrequency = sampleRate / 2
  const minFrequency = 20
  const xFor = (frequency: number) => plot.left +
    Math.log(frequency / minFrequency) / Math.log(maxFrequency / minFrequency) * (plot.right - plot.left)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const frequency of [20, 100, 1000, 10000]) {
    if (frequency > maxFrequency) continue
    ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`, xFor(frequency), plot.bottom + 8)
  }
  ctx.textAlign = 'right'
  ctx.fillText('Hz', plot.right, plot.bottom + 8)
  ctx.strokeStyle = '#7c3aed'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let x = plot.left; x <= plot.right; x += 1) {
    const bin = plotBins[Math.round((x - plot.left) * (plotBins.length - 1) / (plot.right - plot.left))]
    const value = Number.isFinite(bins[bin]) ? Math.max(-100, Math.min(0, bins[bin])) : -100
    const y = plot.bottom - (value + 100) / 100 * (plot.bottom - plot.top)
    if (x === plot.left) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawHistory(canvas: HTMLCanvasElement, history: Point[], offsetDb: number | null) {
  const ctx = setup(canvas)
  if (!ctx || history.length === 0) return
  const plot = { left: plotLeft, right: Math.max(plotLeft + 1, canvas.width - 16), top: 12, bottom: 188 }
  const active = series
  const offset = offsetDb ?? 0
  let lowest = Infinity
  let highest = -Infinity
  for (const point of history) {
    for (const { key } of active) {
      const value = point.levels[key] + offset
      if (Number.isFinite(value)) {
        lowest = Math.min(lowest, value)
        highest = Math.max(highest, value)
      }
    }
  }
  const min = Number.isFinite(lowest) ? Math.floor((lowest - 5) / 10) * 10 : -100
  const max = Number.isFinite(highest) ? Math.max(min + 20, Math.ceil((highest + 5) / 10) * 10) : 0
  grid(ctx, plot, min, max, offsetDb === null ? 'dBFS' : 'dB SPL')
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const seconds of [60, 45, 30, 15, 0]) {
    const x = plot.left + (60 - seconds) / 60 * (plot.right - plot.left)
    ctx.fillText(seconds === 0 ? 'now' : `-${seconds}s`, x, plot.bottom + 8)
  }
  const now = history[history.length - 1].time
  for (const { key, color } of active) {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    let drawing = false
    for (const point of history) {
      const value = point.levels[key] + offset
      if (!Number.isFinite(value)) {
        drawing = false
        continue
      }
      const x = plot.right - (now - point.time) / historyMs * (plot.right - plot.left)
      const y = plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top)
      if (drawing) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      drawing = true
    }
    ctx.stroke()
  }
}

export function LiveCharts({ meter, analyser, sampleRate, offsetDb, visible }: {
  meter: Levels
  analyser: AnalyserNode
  sampleRate: number
  offsetDb: number | null
  visible: boolean
}) {
  const spectrumRef = useRef<HTMLCanvasElement>(null)
  const historyCanvasRef = useRef<HTMLCanvasElement>(null)
  const historyRef = useRef<Point[]>([])
  const lastMeterRef = useRef<Levels | null>(null)
  const bins = useMemo(() => new Float32Array(analyser.frequencyBinCount), [analyser])
  const plotBins = useMemo(() => {
    const result = new Uint16Array(plotRight - plotLeft + 1)
    for (let x = plotLeft; x <= plotRight; x += 1) {
      const frequency = 20 * (sampleRate / 40) ** ((x - plotLeft) / (plotRight - plotLeft))
      result[x - plotLeft] = Math.min(analyser.frequencyBinCount - 1, Math.round(frequency * analyser.fftSize / sampleRate))
    }
    return result
  }, [analyser, sampleRate])

  useEffect(() => {
    const now = performance.now()
    if (lastMeterRef.current !== meter) {
      historyRef.current.push({
        time: now,
        levels: {
          raw: decibels(meter.raw),
          a: decibels(meter.a),
          b: decibels(meter.b),
          c: decibels(meter.c),
          aeq: decibels(meter.aeq),
        },
      })
      lastMeterRef.current = meter
    }
    let expired = 0
    while (expired < historyRef.current.length && now - historyRef.current[expired].time > historyMs) expired += 1
    expired = Math.max(expired, historyRef.current.length - 601)
    if (expired > 0) historyRef.current.splice(0, expired)
    if (visible && spectrumRef.current) drawSpectrum(spectrumRef.current, analyser, sampleRate, bins, plotBins)
    if (visible && historyCanvasRef.current) drawHistory(historyCanvasRef.current, historyRef.current, offsetDb)
  }, [meter, analyser, sampleRate, offsetDb, visible, bins, plotBins])

  return (
    <div className="charts">
      <section aria-labelledby="spectrum-title">
        <h3 id="spectrum-title">Frequency spectrum</h3>
        <p>Live FFT · digital level (dBFS) · logarithmic frequency scale</p>
        <canvas ref={spectrumRef} width={width} height={height} role="img" aria-label="Live FFT frequency spectrum in dBFS" />
      </section>
      <section aria-labelledby="history-title">
        <h3 id="history-title">Level over time</h3>
        <p>Last 60 seconds · {offsetDb === null ? 'digital level until calibrated' : 'calibrated sound pressure levels'}</p>
        <canvas ref={historyCanvasRef} width={width} height={height} role="img" aria-label="Sound level history over the last 60 seconds" />
        <div className="chart-legend">
          {(offsetDb === null ? series.map((item) => ({ ...item, label: item.key === 'raw' ? 'dBFS' : `dBFS(${item.label})` })) : series).map((item) => (
            <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}</span>
          ))}
        </div>
        {offsetDb !== null && <p>History uses the current calibration offset.</p>}
      </section>
    </div>
  )
}
