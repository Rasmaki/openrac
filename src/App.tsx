import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { audioMeterProcessorSource } from './audioMeterProcessor'
import { LiveCharts } from './LiveCharts'
import { RoomMeasurement } from './RoomMeasurement'
import { averageReference, peakReference } from './dinReference'
import './App.css'

const calibrationStorageKey = 'openrac.microphoneCalibration.v1'
const calibrationDurationMs = 3000

type MicStatus = 'idle' | 'connecting' | 'streaming' | 'error'
type Metric = 'dbfs' | 'spl' | 'dba' | 'dbb' | 'dbc' | 'dbaeq' | 'dbfsa' | 'dbfsb' | 'dbfsc' | 'dbfsaeq'
type Weighting = 'raw' | 'a' | 'b' | 'c' | 'aeq'
type Tab = 'calibration' | 'levels' | 'room'

const tabs: { id: Tab; label: string }[] = [
  { id: 'calibration', label: 'Calibration' },
  { id: 'levels', label: 'Live levels' },
  { id: 'room', label: 'Room & speaker' },
]

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
  cPeak: number
  monitorRawPeak: number
  monitorCPeak: number
  monitorClipped: boolean
  monitorWindowClipped: boolean
  monitorAvailable: boolean
  monitorSamples: number
  monitorARms: number
  monitorGeneration: number
}

type CalibrationCapture = {
  energy: number
  samples: number
  peak: number
  referenceDb: number
}

const metrics: { value: Metric; label: string; description: string; weighting: Weighting; digital: boolean }[] = [
  { value: 'dbfs', label: 'dBFS', description: 'Unweighted', weighting: 'raw', digital: true },
  { value: 'dbfsa', label: 'dBFS(A)', description: 'A-weighted', weighting: 'a', digital: true },
  { value: 'dbfsb', label: 'dBFS(B)', description: 'B-weighted', weighting: 'b', digital: true },
  { value: 'dbfsc', label: 'dBFS(C)', description: 'C-weighted', weighting: 'c', digital: true },
  { value: 'dbfsaeq', label: 'dBFS(Aeq)', description: '1-second average', weighting: 'aeq', digital: true },
  { value: 'dba', label: 'dB(A) SPL', description: 'Current A-weighted level', weighting: 'a', digital: false },
  { value: 'spl', label: 'dB SPL', description: 'Unweighted', weighting: 'raw', digital: false },
  { value: 'dbb', label: 'dB(B)', description: 'B-weighted', weighting: 'b', digital: false },
  { value: 'dbc', label: 'dB(C)', description: 'C-weighted', weighting: 'c', digital: false },
  { value: 'dbaeq', label: 'dBAeq', description: '1-second average', weighting: 'aeq', digital: false },
]

function dbFromRms(rms: number) {
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY
}

function readStoredCalibration(): Calibration | null {
  let value: unknown
  try {
    const stored = localStorage.getItem(calibrationStorageKey)
    if (!stored) return null
    value = JSON.parse(stored)
  } catch {
    throw new Error('Could not read the saved microphone calibration.')
  }
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
}

function App() {
  const [status, setStatus] = useState<MicStatus>('idle')
  const [activeTab, setActiveTab] = useState<Tab>('calibration')
  const [error, setError] = useState('')
  const [calibrationMessage, setCalibrationMessage] = useState('')
  const [calibrationReference, setCalibrationReference] = useState(94)
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [meter, setMeter] = useState<MeterMessage | null>(null)
  const [monitorGeneration, setMonitorGeneration] = useState(0)
  const [sampleRate, setSampleRate] = useState<number | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [roomSource, setRoomSource] = useState<MediaStreamAudioSourceNode | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const deviceIdRef = useRef('')
  const deviceLabelRef = useRef('')
  const calibrationCaptureRef = useRef<CalibrationCapture | null>(null)
  const calibrationTimerRef = useRef<number | null>(null)
  const calibrationStartedRef = useRef(0)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const monitorGenerationRef = useRef(0)

  const resetMonitor = (type: 'reset-monitor' | 'reset-peaks' | 'reset-average' = 'reset-monitor') => {
    monitorGenerationRef.current += 1
    processorRef.current?.port.postMessage({
      type,
      generation: monitorGenerationRef.current,
    })
    setMonitorGeneration(monitorGenerationRef.current)
  }

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
    analyserRef.current?.disconnect()
    analyserRef.current = null
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
    setMeter(null)
    setSampleRate(null)
    setAnalyser(null)
    setRoomSource(null)
    monitorGenerationRef.current = 0
    setMonitorGeneration(0)

    const failStart = (message: string) => {
      releaseMicrophone()
      setError(message)
      setStatus('error')
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      failStart('Microphone access is not available in this browser.')
      return
    }
    if (!window.isSecureContext) {
      failStart('Microphone access requires HTTPS or localhost.')
      return
    }
    if (!('AudioWorkletNode' in window)) {
      failStart('Live audio processing is not supported in this browser.')
      return
    }

    try {
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
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.6
      const processor = new AudioWorkletNode(context, 'audio-meter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      sourceRef.current = source
      processorRef.current = processor
      analyserRef.current = analyser

      processor.port.onmessage = (event: MessageEvent<MeterMessage>) => {
        const data = event.data
        if (data.monitorGeneration !== monitorGenerationRef.current) return
        setMeter(data)

        const capture = calibrationCaptureRef.current
        if (capture) {
          capture.energy += data.intervalRawPower * data.intervalSamples
          capture.samples += data.intervalSamples
          capture.peak = Math.max(capture.peak, data.peak)
        }
      }

      source.connect(processor)
      source.connect(analyser)
      processor.connect(context.destination)
      await context.resume()

      setSampleRate(context.sampleRate)
      setAnalyser(analyser)
      setRoomSource(source)
      setStatus('streaming')
    } catch (startError: unknown) {
      failStart(
        startError instanceof Error
          ? startError.message
          : 'Unable to start microphone streaming.',
      )
    }
  }

  const startCalibration = () => {
    resetMonitor()
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
      resetMonitor()

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
    setSampleRate(null)
    setAnalyser(null)
    setRoomSource(null)
    setStatus('idle')
  }

  const clearCalibration = () => {
    try {
      localStorage.removeItem(calibrationStorageKey)
      setCalibration(null)
      resetMonitor()
      setCalibrationMessage('Saved microphone calibration cleared.')
    } catch {
      setCalibrationMessage('Could not clear the saved microphone calibration.')
    }
  }

  const hasSPLCalibration = calibration !== null
  const monitor = !calibrating && meter?.monitorGeneration === monitorGeneration && meter.monitorAvailable && meter.monitorSamples > 0 ? meter : null
  const peakSPL = monitor && calibration ? dbFromRms(monitor.monitorCPeak) + calibration.offsetDb : null
  const averageSPL = monitor && calibration ? dbFromRms(monitor.monitorARms) + calibration.offsetDb : null
  const peakStatus = peakReference(peakSPL, monitor?.monitorClipped ?? false)
  const averageStatus = averageReference(
    averageSPL,
    !!monitor && !!sampleRate && monitor.monitorSamples >= sampleRate * 1800,
    monitor?.monitorWindowClipped ?? false,
  )
  const displayDb = (value: number | null) =>
    value === null ? '--' : value === Number.NEGATIVE_INFINITY ? '−∞' : value.toFixed(1)
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    setActiveTab(tabs[next].id)
    tabRefs.current[next]?.focus()
  }

  const statusLabel = {
    idle: 'Ready',
    connecting: 'Requesting access',
    streaming: 'Streaming',
    error: 'Could not start',
  }[status]

  return (
    <main className="mic-app">
      <header className="page-heading">
        <p className="eyebrow">Venue Measurement</p>
        <h1>OpenRAC</h1>
      </header>

      <div className="tabs" role="tablist" aria-label="Measurement features">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => { tabRefs.current[index] = element }}
            className="tab"
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div id="panel-calibration" role="tabpanel" aria-labelledby="tab-calibration" hidden={activeTab !== 'calibration'} tabIndex={0}>
      <section className="stream-card calibration" aria-labelledby="calibration-title">
        <p className="eyebrow">Reference</p>
        <h2 id="calibration-title">Microphone calibration</h2>
        <div className="microphone-bar">
          <div className="microphone-status">
            <span className={`status status-${status}`} role="status">
              <span className="status-dot" />
              {statusLabel}
            </span>
            <span className="permission-note">Audio stays on this device. Microphone access requires HTTPS or localhost.</span>
          </div>
          {status === 'streaming' ? (
            <button className="button button-stop" onClick={stopMicrophone} type="button">
              Stop microphone
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
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <p className="calibration-copy">
          Start the microphone, couple a 1 kHz acoustic calibrator, then calibrate.
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
          {calibration && (
            <button className="text-button" onClick={clearCalibration} type="button">
              Clear calibration
            </button>
          )}
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
      </div>

      <div id="panel-levels" role="tabpanel" aria-labelledby="tab-levels" hidden={activeTab !== 'levels'} tabIndex={0}>
      <section className="stream-card measurement-card" aria-labelledby="stream-title">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Input</p>
            <h2 id="stream-title">Live measurement</h2>
          </div>
          <span className="sample-rate">
            Sample rate: {sampleRate ? `${(sampleRate / 1000).toFixed(1)} kHz` : '--'}
          </span>
        </div>
        <section className="level-group" aria-labelledby="spl-title">
          <h3 id="spl-title">Sound pressure</h3>
          {!hasSPLCalibration && (
            <p className="measurement-hint">
              SPL requires calibration.
              {' '}<button className="inline-button" type="button" onClick={() => { setActiveTab('calibration'); tabRefs.current[0]?.focus() }}>Go to calibration</button>
            </p>
          )}
          <div className="metrics din-metrics">
              <div className="metric primary-level">
                <span className="metric-label">Current · dB(A) SPL</span>
                <strong>{displayDb(meter && calibration ? dbFromRms(meter.rms.a) + calibration.offsetDb : null)}</strong>
                <span className="metric-description">A-weighted · 125 ms RMS</span>
              </div>
              <div className={`metric reference-${peakStatus.tone}`}>
                <span className="metric-label">Peak · dB(C)</span>
                <strong>{displayDb(peakSPL)}</strong>
                <span className="metric-description">Highest C-weighted sample peak</span>
                <span className="reference-status">{peakStatus.text}</span>
                <span className="metric-description">
                  Current interval: {displayDb(monitor && calibration ? dbFromRms(monitor.cPeak) + calibration.offsetDb : null)} dB(C)
                </span>
                <button className="inline-button metric-reset" type="button" disabled={status !== 'streaming' || calibrating} onClick={() => resetMonitor('reset-peaks')}>
                  Reset peaks
                </button>
              </div>
              <div className={`metric reference-${averageStatus.tone}`}>
                <span className="metric-label">30-minute LAeq · dB(A)</span>
                <strong>{displayDb(averageSPL)}</strong>
                <span className="metric-description">
                  {monitor && sampleRate ? (Math.floor(Math.min(30, monitor.monitorSamples / sampleRate / 60) * 10) / 10).toFixed(1) : '0.0'} / 30 min · uncorrected
                </span>
                <span className="reference-status">{averageStatus.text}</span>
                <button className="inline-button metric-reset" type="button" disabled={status !== 'streaming' || calibrating} onClick={() => resetMonitor('reset-average')}>
                  Reset 30-minute average
                </button>
              </div>
          </div>
          {monitor?.monitorClipped && (
            <p className="measurement-hint" role="status">Digital input clipping was detected since peak reset; peaks may be underestimated. Reset peaks after reducing input gain.</p>
          )}
          <details className="measurement-details">
            <summary>About DIN references and accuracy</summary>
            <p>
                DIN 15905-5 references are indicative, not a compliance determination. An expected assessment level from 85 dB(A) calls for audience information and loudspeaker-area precautions.
                The 95 dB(A) assessment reference applies when hearing protection is not provided; 99 dB(A) applies under specified conditions.
                The displayed LAeq is uncorrected. Calibration, measurement position, corrections and equipment requirements matter.
                Sample peaks are not certified true peaks; microphone or input processing may distort or clip sound before the browser can detect it.
                The average counts processed audio and may not cover real time if the stream is suspended.
            </p>
          </details>
        </section>
        <section className="level-group secondary-levels" aria-label="Additional live levels">
          {[false, true].map((digital) => (
            <div className="level-strip" key={digital ? 'digital' : 'spl'}>
              <h3>{digital ? 'Digital input · dBFS' : 'Other sound pressure · dB SPL'}</h3>
              <div className="level-strip-values">
                {metrics.filter((option) => option.digital === digital && option.value !== 'dba').map((option) => {
                  const rms = meter?.rms[option.weighting]
                  const value = rms !== undefined && (digital || calibration !== null)
                    ? dbFromRms(rms) + (digital ? 0 : (calibration?.offsetDb ?? 0))
                    : null
                  return (
                    <div className="level-compact" key={option.value}>
                      <span title={option.description}>{option.label}</span>
                      <strong>{displayDb(value)}</strong>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </section>
        {status === 'streaming' && meter && analyser && sampleRate ? (
          <LiveCharts meter={meter.rms} analyser={analyser} sampleRate={sampleRate} offsetDb={calibration?.offsetDb ?? null} visible={activeTab === 'levels'} />
        ) : (
          <p className="chart-placeholder">Start the microphone to see the frequency spectrum and level history.</p>
        )}
      </section>
      </div>

      <div id="panel-room" role="tabpanel" aria-labelledby="tab-room" hidden={activeTab !== 'room'} tabIndex={0}>
      {status === 'streaming' && roomSource && meter && (
        <RoomMeasurement source={roomSource} peak={meter.peak} />
      )}
      {status !== 'streaming' && (
        <section className="stream-card room-card" aria-labelledby="room-inactive-title">
          <p className="eyebrow">Room and speaker</p>
          <h2 id="room-inactive-title">Relative response measurement</h2>
          <p className="room-copy">Start the microphone to measure a speaker using pink noise and see suggested EQ starting points.</p>
        </section>
      )}
      </div>
    </main>
  )
}

export default App
