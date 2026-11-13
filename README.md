# OpenRAC

OpenRAC is a browser app built with React, TypeScript, and Vite.

## Run locally

```sh
npm install
npm run dev
```

## Run with Docker Compose

Create a `compose.yaml` file with the following content:

```yaml
services:
  openrac:
    image: ghcr.io/rasmaki/openrac:latest
    ports:
      - "18763:80"
    restart: unless-stopped
```

In the same directory, run:

```sh
docker compose up -d
```

Open `http://localhost:18763`. To stop the app, run `docker compose down`.
Port 18763 is an arbitrary host port; change the left side of `18763:80` in
`compose.yaml` if it is already in use.

To update the image, run `docker compose pull` followed by `docker compose up -d`.
The image supports Linux on AMD64 and ARM64.

Microphone access requires HTTPS or localhost. For access from another device,
serve the app over HTTPS using a reverse proxy. The microphone is accessed by
the client's browser and does not need to be passed into the container.

### Publishing the image

The GitHub Actions workflow publishes `ghcr.io/rasmaki/openrac:latest` on pushes
to `master` and can also be run manually from `master`. After the first successful
publication, the repository owner must set the package visibility to **Public** in
its GitHub Packages settings so that others can pull it without signing in.

To build the image locally from a checkout instead, run
`docker build -t openrac:local .` and change the Compose image to `openrac:local`.

The sound-level demo uses `getUserMedia` and the Web Audio API. It displays dBFS,
unweighted dB SPL, A/B/C-weighted levels, rolling 1-second dBAeq, a live FFT
spectrum, and a 60-second level history. The FFT shows uncalibrated digital
frequency magnitudes in dBFS, not SPL. History is kept only in memory and is
cleared when measurement stops. Microphone access requires HTTPS or `localhost`.
Calibration, live levels, and room measurement are available in separate tabs.
Start or stop the microphone from the Calibration tab. The microphone remains
active when switching tabs, and the live level history
continues collecting while the live tab is hidden.
The live tab prioritizes current A-weighted SPL, peak and 30-minute average;
additional SPL and digital readings remain visible in compact groups. DIN
reference details can be expanded below the main readings.

For absolute SPL readings, start the microphone and calibrate it using a 1 kHz
acoustic sound calibrator set to 94 or 114 dB SPL. The app saves the calibration
offset locally for the active microphone. Disable operating-system enhancements
as well; browsers may not honor requests to disable automatic gain control,
noise suppression, and echo cancellation on every device. Accuracy depends on
the microphone and the entire audio input chain, so this is not a certified
sound-level meter.

Without an SPL reference, the app shows unweighted and A/B/C-weighted digital
levels in dBFS, including a rolling A-weighted average. It cannot infer absolute
SPL or input sensitivity from microphone samples alone.

The sound-pressure cards include the current A-weighted SPL and the highest
calibrated C-weighted sample peak since reset. They compare LCpeak with the
135 dB(C) reference, and compares a rolling, energy-averaged 30-minute LAeq
with the 85, 95 and 99 dB(A) references only after collecting a full 30 minutes
of audio. An expected assessment level from 85 dB(A) is associated with audience
information and precautions near loudspeakers. The 95 dB(A) assessment reference
applies when hearing protection is not provided; 99 dB(A) applies under
specified conditions. The displayed LAeq is not the
corrected assessment level. Measurement position, corrections, equipment,
operating conditions and logging matter, so these indications do not establish
DIN compliance or safety. A sample peak is not a certified true peak; input
clipping and processing, including clipping before the browser, can make results
unreliable. Peak and 30-minute average resets work independently; calibration
and stopping the microphone restart both. The window counts processed audio
samples, not elapsed time during a suspended audio stream. A disconnected
worklet input clears the window.

For a relative room/speaker measurement, start the microphone and play steady
pink noise through the speaker at a comfortable volume. Measure at the listening
position for 10 seconds. The app averages FFT energy in third-octave bands from
100 Hz to 8 kHz, displays it relative to the median band, and proposes up to four
conservative peaking EQ cuts (maximum 6 dB, Q 1.4). These are starting points,
not automatic corrections: microphone response, input processing, background
noise, placement and the speaker all affect the result. Verify at multiple
positions; use a measurement microphone for better accuracy. No sound is recorded
or uploaded, and the measurement does not control any external DSP.

To add an npm dependency, install it with `npm install <package>` and import it
from your app code. Check that the package supports browsers: React Native
packages such as `react-native-microphone-stream` depend on native APIs and
cannot be used directly in this Vite web app.
