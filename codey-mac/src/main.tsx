import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'
import { VoiceHud } from './components/VoiceHud'

// Auxiliary BrowserWindows load the same bundle behind a hash route.
const hash = window.location.hash
const isCapture = hash.startsWith('#/capture')
const isVoiceHud = hash.startsWith('#/voice-hud')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : isVoiceHud ? <VoiceHud /> : <App />}
  </React.StrictMode>
)
