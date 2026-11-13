import { useCallback, useEffect, useRef, useState } from 'react'
import { analyzeSpectrum, spectrumBinRange, type EqSuggestion, type RoomBand } from './roomAnalysis'

const fftSize = 16384
const durationMs = 10_000
const intervalMs = 100

type Result = { bands: RoomBand[]; suggestions: EqSuggestion[] }

export function RoomMeasurement({ source, peak }: { source: MediaStreamAudioSourceNode; peak: number }) {
  const [measuring, setMeasuring] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const timerRef = useRef<number | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const clippedRef = useRef(false)

  const cleanup = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    if (analyserRef.current) {
      try {
        source.disconnect(analyserRef.current)
      } catch (disconnectError: unknown) {
        if (!(disconnectError instanceof DOMException) || disconnectError.name !== 'InvalidAccessError') throw disconnectError
      }
    }
    analyserRef.current = null
  }, [source])

  useEffect(() => cleanup, [cleanup])
  useEffect(() => {
    if (measuring && peak >= 0.999) clippedRef.current = true
  }, [measuring, peak])

  const start = () => {
    setError('')
    setResult(null)
    setProgress(0)
    clippedRef.current = false
    const analyser = source.context.createAnalyser()
    analyser.fftSize = fftSize
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    analyserRef.current = analyser
    const bins = new Float32Array(analyser.frequencyBinCount)
    const powers = new Float64Array(analyser.frequencyBinCount)
    const { start: firstBin, end: endBin } = spectrumBinRange(source.context.sampleRate, fftSize)
    let observations = 0
    const started = performance.now()
    const warmupMs = fftSize / source.context.sampleRate * 1000
    setMeasuring(true)
    timerRef.current = window.setInterval(() => {
      const elapsed = performance.now() - started
      setProgress(Math.min(100, elapsed / durationMs * 100))
      if (elapsed >= warmupMs) {
        analyser.getFloatFrequencyData(bins)
        for (let i = firstBin; i < endBin; i += 1) {
          if (Number.isFinite(bins[i])) powers[i] += 10 ** (bins[i] / 10)
        }
        observations += 1
      }
      if (elapsed < durationMs) return
      cleanup()
      setMeasuring(false)
      if (clippedRef.current) {
        setError('The input clipped during measurement. Lower the input gain or speaker level and try again.')
        return
      }
      if (observations < 30) {
        setError('Not enough measurements were collected. Keep this page open and try again.')
        return
      }
      try {
        setResult(analyzeSpectrum(powers, observations, source.context.sampleRate, fftSize))
      } catch (measurementError: unknown) {
        setError(measurementError instanceof Error ? measurementError.message : 'Measurement failed.')
      }
    }, intervalMs)
  }

  const cancel = () => {
    cleanup()
    setMeasuring(false)
    setProgress(0)
  }

  return (
    <section className="stream-card room-card" aria-labelledby="room-title">
      <p className="eyebrow">Room and speaker</p>
      <h2 id="room-title">Relative response measurement</h2>
      <p className="room-copy">
        Play steady pink noise through the speaker, place the microphone at the listening position,
        and measure for 10 seconds. Use a comfortable, safe volume and keep the room quiet.
      </p>
      <p className="room-copy">
        No SPL calibration is needed. Phone microphones and automatic audio processing can color
        the result; a measurement microphone and disabled input processing are recommended.
        Choose your microphone in your browser or system settings.
      </p>
      <div className="room-actions">
        <button className="button button-calibrate" onClick={measuring ? cancel : start} type="button">
          {measuring ? 'Cancel measurement' : 'Measure response'}
        </button>
        {measuring && <span role="status">Measuring {Math.round(progress)}%</span>}
      </div>
      {measuring && <progress className="room-progress" max={100} value={progress}> {Math.round(progress)}% </progress>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {result && (
        <div className="room-results">
          <h3>Relative response</h3>
          <p>Third-octave band energy relative to the median. Assumes pink noise; it is not verified. Not an absolute SPL or calibrated frequency response.</p>
          <div className="band-chart" role="img" aria-label="Relative third-octave band levels. Exact levels are listed below.">
            {result.bands.map((band) => (
              <div className="band-column" key={band.frequency} title={`${band.frequency} Hz: ${band.relative.toFixed(1)} dB`}>
                <div className="band-track">
                  <div className="band-bar" style={{
                    bottom: band.relative >= 0 ? '50%' : `${50 + Math.max(-20, band.relative) * 2.5}%`,
                    height: `${Math.min(20, Math.abs(band.relative)) * 2.5}%`,
                  }} />
                </div>
                <span>{band.frequency >= 1000 ? `${band.frequency / 1000}k` : band.frequency}</span>
              </div>
            ))}
          </div>
          <details>
            <summary>Show band values</summary>
            <div className="band-values">
              {result.bands.map((band) => <span key={band.frequency}>{band.frequency} Hz: {band.relative >= 0 ? '+' : ''}{band.relative.toFixed(1)} dB</span>)}
            </div>
          </details>
          <h3>Suggested starting points</h3>
          <p>Conservative peak cuts only, not automatic corrections. Verify by listening and remeasuring at multiple positions; do not copy blindly.</p>
          {result.suggestions.length ? (
            <table>
              <thead><tr><th>Frequency</th><th>Gain</th><th>Q</th></tr></thead>
              <tbody>{result.suggestions.map((item) => (
                <tr key={item.frequency}><td>{item.frequency} Hz</td><td>{item.gain.toFixed(1)} dB</td><td>{item.q.toFixed(1)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p>No prominent peaks found for a suggested cut.</p>}
        </div>
      )}
    </section>
  )
}
