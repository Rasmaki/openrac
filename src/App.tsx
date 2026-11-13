import { useEffect, useRef, useState } from 'react'
import { audioMeterProcessorSource } from './audioMeterProcessor'
import './App.css'

const calibrationStorageKey = 'openrac.microphoneCalibration.v1'
const calibrationDurationMs = 3000

type MicStatus = 'idle' | 'connecting' | 'streaming' | 'error'
type Metric = 'dbfs' | 'spl' | 'dba' | 'dbb' | 'dbc' | 'dbaeq'
type Weighting = 'raw' | 'a' | 'b' | 'c' | 'aeq'

type Calibration = {
  offsetDb: number
  deviceId: string
  deviceLabel: string
  referenceDb: number
}

type MeterMessage = {
  rms: Record<Weighting, number>
  intervalRawPower: number
  intervalSamples: number
  peak: number
  chunks: number
}

type CalibrationCapture = {
  energy: number
  samples: number
  peak: number
  referenceDb: number
}

const metrics: { value: Metric; label: string; weighting: Weighting }[] = [
  { value: 'dbfs', label: 'dBFS (unweighted)', weighting: 'raw' },
  { value: 'spl', label: 'dB SPL (unweighted)', weighting: 'raw' },
  { value: 'dba', label: 'dB(A)', weighting: 'a' },
  { value: 'dbb', label: 'dB(B)', weighting: 'b' },
  { value: 'dbc', label: 'dB(C)', weighting: 'c' },
  { value: 'dbaeq', label: 'dBAeq (1 s)', weighting: 'aeq' },
]

function dbFromRms(rms: number) {
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY
}

function readStoredCalibration(): Calibration | null {
  try {
    const stored = localStorage.getItem(calibrationStorageKey)
    if (!stored) return null
    const value: unknown = JSON.parse(stored)
    if (
      typeof value === 'object' &&
      value !== null &&
      'offsetDb' in value &&
      'deviceId' in value &&
      'deviceLabel' in value &&
      'referenceDb' in value &&
      typeof value.offsetDb === 'number' &&
      Number.isFinite(value.offsetDb) &&
      typeof value.deviceId === 'string' &&
      typeof value.deviceLabel === 'string' &&
      typeof value.referenceDb === 'number' &&
      Number.isFinite(value.referenceDb)
    ) {
      return {
        offsetDb: value.offsetDb,
        deviceId: value.deviceId,
        deviceLabel: value.deviceLabel,
        referenceDb: value.referenceDb,
      }
    }
    throw new Error('Stored microphone calibration has an invalid format.')
  } catch (storageError: unknown) {
    if (storageError instanceof Error && storageError.message.includes('invalid format')) {
      throw storageError
    }
    throw new Error('Could not read the saved microphone calibration.')
  }
}

function App() {
  const [status, setStatus] = useState<MicStatus>('idle')
  const [metric, setMetric] = useState<Metric>('dbfs')
  const [error, setError] = useState('')
  const [calibrationMessage, setCalibrationMessage] = useState('')
  const [calibrationReference, setCalibrationReference] = useState(94)
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [chunkCount, setChunkCount] = useState(0)
  const [meter, setMeter] = useState<MeterMessage | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const deviceIdRef = useRef('')
  const deviceLabelRef = useRef('')
  const calibrationCaptureRef = useRef<CalibrationCapture | null>(null)
  const calibrationTimerRef = useRef<number | null>(null)
  const calibrationStartedRef = useRef(0)

  const cancelCalibration = () => {
    if (calibrationTimerRef.current !== null) {
      window.clearInterval(calibrationTimerRef.current)
      calibrationTimerRef.current = null
    }
    calibrationCaptureRef.current = null
    setCalibrating(false)
    setCalibrationProgress(0)
  }

  const releaseMicrophone = () => {
    if (calibrationTimerRef.current !== null) {
      window.clearInterval(calibrationTimerRef.current)
      calibrationTimerRef.current = null
    }
    calibrationCaptureRef.current = null
    if (processorRef.current) {
      processorRef.current.port.onmessage = null
      processorRef.current.disconnect()
      processorRef.current = null
    }
    sourceRef.current?.disconnect()
    sourceRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') {
      void context.close().catch((closeError: unknown) => {
        console.error('Could not close the microphone audio context.', closeError)
      })
    }
  }

  useEffect(() => releaseMicrophone, [])

  const startMicrophone = async () => {
    setStatus('connecting')
    setError('')
    setCalibrationMessage('')
    setCalibration(null)
    setChunkCount(0)
    setMeter(null)
    setSampleRate(null)

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is not available in this browser.')
      }
      if (!window.isSecureContext) {
        throw new Error('Microphone access requires HTTPS or localhost.')
      }
      if (!('AudioWorkletNode' in window)) {
        throw new Error('Live audio processing is not supported in this browser.')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          autoGainControl: { ideal: false },
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
        },
      })
      streamRef.current = stream

      const track = stream.getAudioTracks()[0]
      const settings = track?.getSettings()
      deviceIdRef.current = settings?.deviceId ?? ''
      deviceLabelRef.current = track?.label ?? 'Microphone'

      try {
        const savedCalibration = readStoredCalibration()
        if (savedCalibration && savedCalibration.deviceId === deviceIdRef.current) {
          setCalibration(savedCalibration)
          setCalibrationMessage(
            `Calibration loaded for ${savedCalibration.deviceLabel} (${savedCalibration.referenceDb} dB SPL reference).`,
          )
        } else if (savedCalibration) {
          setCalibrationMessage(
            `A saved calibration exists for ${savedCalibration.deviceLabel}; calibrate this microphone before measuring SPL.`,
          )
        }
      } catch (storageError: unknown) {
        setCalibrationMessage(
          storageError instanceof Error
            ? storageError.message
            : 'Could not load the saved microphone calibration.',
        )
      }

      const context = new AudioContext()
      contextRef.current = context
      const moduleUrl = URL.createObjectURL(
        new Blob([audioMeterProcessorSource], { type: 'text/javascript' }),
      )
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }

      const source = context.createMediaStreamSource(stream)
      const processor = new AudioWorkletNode(context, 'audio-meter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      sourceRef.current = source
      processorRef.current = processor

      processor.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        const data = event.data
        setMeter(data)
        setChunkCount((count) => count + data.chunks)

        const capture = calibrationCaptureRef.current
        if (capture) {
          capture.energy += data.intervalRawPower * data.intervalSamples
          capture.samples += data.intervalSamples
          capture.peak = Math.max(capture.peak, data.peak)
        }
      }

      source.connect(processor)
      processor.connect(context.destination)
      await context.resume()

      setSampleRate(context.sampleRate)
      setStatus('streaming')
    } catch (startError: unknown) {
      releaseMicrophone()
      setError(
        startError instanceof Error
          ? startError.message
          : 'Unable to start microphone streaming.',
      )
      setStatus('error')
    }
  }

  const startCalibration = () => {
    setCalibrationMessage(
      'Keep the 1 kHz acoustic calibrator coupled to the microphone for the full measurement.',
    )
    setCalibrationProgress(0)
    calibrationCaptureRef.current = {
      energy: 0,
      samples: 0,
      peak: 0,
      referenceDb: calibrationReference,
    }
    calibrationStartedRef.current = Date.now()
    setCalibrating(true)

    calibrationTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - calibrationStartedRef.current
      setCalibrationProgress(Math.min(100, (elapsed / calibrationDurationMs) * 100))
      if (elapsed < calibrationDurationMs) return

      if (calibrationTimerRef.current !== null) {
        window.clearInterval(calibrationTimerRef.current)
        calibrationTimerRef.current = null
      }

      const capture = calibrationCaptureRef.current
      calibrationCaptureRef.current = null
      setCalibrating(false)
      setCalibrationProgress(0)

      if (!capture || capture.samples === 0) {
        setCalibrationMessage('No calibration audio was received. Try again.')
        return
      }
      if (capture.peak >= 0.999) {
        setCalibrationMessage(
          'The calibration signal clipped. Try the 94 dB setting or reduce the microphone input gain.',
        )
        return
      }

      const rms = Math.sqrt(capture.energy / capture.samples)
      if (!Number.isFinite(rms) || rms <= 0) {
        setCalibrationMessage('No usable calibration tone was detected. Check the microphone and try again.')
        return
      }

      const nextCalibration: Calibration = {
        offsetDb: capture.referenceDb - dbFromRms(rms),
        deviceId: deviceIdRef.current,
        deviceLabel: deviceLabelRef.current,
        referenceDb: capture.referenceDb,
      }
      setCalibration(nextCalibration)

      if (!nextCalibration.deviceId) {
        setCalibrationMessage(
          `Calibrated for this session, but the browser did not provide a stable microphone ID to save it.`,
        )
        return
      }

      try {
        localStorage.setItem(calibrationStorageKey, JSON.stringify(nextCalibration))
        setCalibrationMessage(
          `Calibration saved for ${nextCalibration.deviceLabel} using a ${nextCalibration.referenceDb} dB SPL reference.`,
        )
      } catch {
        setCalibrationMessage(
          'Calibration is active for this session, but the browser could not save it locally.',
        )
      }
    }, 100)
  }

  const stopMicrophone = () => {
    if (calibrating) {
      setCalibrationMessage('Calibration cancelled.')
    }
    cancelCalibration()
    releaseMicrophone()
    setMeter(null)
    setStatus('idle')
  }

  const clearCalibration = () => {
    try {
      localStorage.removeItem(calibrationStorageKey)
      setCalibration(null)
      setCalibrationMessage('Saved microphone calibration cleared.')
    } catch {
      setCalibrationMessage('Could not clear the saved microphone calibration.')
    }
  }

  const selectedMetric = metrics.find((option) => option.value === metric)!
  const rawRms = meter?.rms[selectedMetric.weighting]
  const hasSPLCalibration = calibration !== null
  const measuredValue =
    rawRms !== undefined && (metric === 'dbfs' || hasSPLCalibration)
      ? dbFromRms(rawRms) + (metric === 'dbfs' ? 0 : (calibration?.offsetDb ?? 0))
      : null
  const formattedValue =
    measuredValue !== null && Number.isFinite(measuredValue)
      ? measuredValue.toFixed(1)
      : '--'

  const readoutUnit = {
    dbfs: 'dBFS',
    spl: 'dB SPL',
    dba: 'dB(A)',
    dbb: 'dB(B)',
    dbc: 'dB(C)',
    dbaeq: 'dBAeq',
  }[metric]

  const statusLabel = {
    idle: 'Ready',
    connecting: 'Requesting access',
    streaming: 'Streaming',
    error: 'Could not start',
  }[status]

  return (
    <main className="mic-app">
      <header className="page-heading">
        <p className="eyebrow">Browser audio</p>
        <h1>Sound level meter</h1>
        <p className="intro">
          Measure live audio levels with selectable frequency weighting. Calibrate
          the microphone with a 1 kHz acoustic sound calibrator for SPL readings.
        </p>
      </header>

      <section className="stream-card" aria-labelledby="stream-title">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Input</p>
            <h2 id="stream-title">Live measurement</h2>
          </div>
          <span className={`status status-${status}`} role="status">
            <span className="status-dot" />
            {statusLabel}
          </span>
        </div>

        <label className="field-label" htmlFor="metric">
          Measurement
        </label>
        <select
          className="metric-select"
          id="metric"
          onChange={(event) => setMetric(event.target.value as Metric)}
          value={metric}
        >
          {metrics.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="measurement" aria-live="polite">
          <strong className="measurement-value">{formattedValue}</strong>
          <span className="measurement-unit">{readoutUnit}</span>
        </div>

        <div className="metrics" aria-live="polite">
          <div className="metric">
            <span className="metric-label">Audio chunks</span>
            <strong>{chunkCount.toLocaleString()}</strong>
          </div>
          <div className="metric">
            <span className="metric-label">Sample rate</span>
            <strong>{sampleRate ? `${(sampleRate / 1000).toFixed(1)} kHz` : '--'}</strong>
          </div>
        </div>

        {metric !== 'dbfs' && !hasSPLCalibration && (
          <p className="measurement-hint">
            Calibrate this microphone to display absolute sound pressure levels.
          </p>
        )}

        <section className="calibration" aria-labelledby="calibration-title">
          <div className="calibration-heading">
            <div>
              <p className="eyebrow">Reference</p>
              <h3 id="calibration-title">Microphone calibration</h3>
            </div>
            {calibration && (
              <button className="text-button" onClick={clearCalibration} type="button">
                Clear
              </button>
            )}
          </div>
          <p className="calibration-copy">
            Couple a 1 kHz acoustic calibrator to the microphone, then calibrate.
            The offset is saved in this browser for this microphone.
          </p>
          <div className="calibration-controls">
            <label className="field-label" htmlFor="calibration-reference">
              Calibrator level
            </label>
            <select
              className="reference-select"
              disabled={calibrating}
              id="calibration-reference"
              onChange={(event) => setCalibrationReference(Number(event.target.value))}
              value={calibrationReference}
            >
              <option value={94}>94 dB SPL</option>
              <option value={114}>114 dB SPL</option>
            </select>
            <button
              className="button button-calibrate"
              disabled={status !== 'streaming' || calibrating}
              onClick={startCalibration}
              type="button"
            >
              {calibrating ? 'Calibrating...' : 'Calibrate microphone'}
            </button>
          </div>
          {calibrating && (
            <div
              className="calibration-progress"
              aria-label={`Calibration progress ${Math.round(calibrationProgress)} percent`}
            >
              <div
                className="calibration-progress-fill"
                style={{ width: `${calibrationProgress}%` }}
              />
            </div>
          )}
          {calibrationMessage && (
            <p className="calibration-message" role="status">
              {calibrationMessage}
            </p>
          )}
          {calibration && (
            <p className="calibration-details">
              Active offset: {calibration.offsetDb >= 0 ? '+' : ''}
              {calibration.offsetDb.toFixed(1)} dB · {calibration.deviceLabel}
            </p>
          )}
        </section>

        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}

        <div className="controls">
          {status === 'streaming' ? (
            <button className="button button-stop" onClick={stopMicrophone} type="button">
              Stop measurement
            </button>
          ) : (
            <button
              className="button button-start"
              disabled={status === 'connecting'}
              onClick={startMicrophone}
              type="button"
            >
              {status === 'connecting' ? 'Waiting for permission...' : 'Start microphone'}
            </button>
          )}
          <p className="permission-note">
            Audio is processed locally. Browser access requires microphone
            permission and HTTPS or localhost.
          </p>
        </div>
      </section>

      <p className="platform-note">
        A-weighted equivalent level is a rolling 1-second Leq. Digital weighting
        and acoustic calibration are for indicative use, not a certified sound
        level meter; microphone hardware and operating-system processing affect
        accuracy.
      </p>
    </main>
  )
}

export default App
