# OpenRAC

OpenRAC is a browser app built with React, TypeScript, and Vite.

## Run locally

```sh
npm install
npm run dev
```

The sound-level demo uses `getUserMedia` and the Web Audio API. Select dBFS,
unweighted dB SPL, A/B/C-weighted levels, or rolling 1-second dBAeq. Microphone
access requires HTTPS or `localhost`.

For absolute SPL readings, start the microphone and calibrate it using a 1 kHz
acoustic sound calibrator set to 94 or 114 dB SPL. The app saves the calibration
offset locally for the active microphone. Disable operating-system enhancements
as well; browsers may not honor requests to disable automatic gain control,
noise suppression, and echo cancellation on every device. Accuracy depends on
the microphone and the entire audio input chain, so this is not a certified
sound-level meter.

To add an npm dependency, install it with `npm install <package>` and import it
from your app code. Check that the package supports browsers: React Native
packages such as `react-native-microphone-stream` depend on native APIs and
cannot be used directly in this Vite web app.
