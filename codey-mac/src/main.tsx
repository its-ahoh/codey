import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'

// The quick-capture BrowserWindow loads the same bundle with #/capture.
const isCapture = window.location.hash.startsWith('#/capture')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : <App />}
  </React.StrictMode>
)
