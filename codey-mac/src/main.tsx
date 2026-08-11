import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'

// Auxiliary BrowserWindows load the same bundle behind a hash route.
const hash = window.location.hash
const isCapture = hash.startsWith('#/capture')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : <App />}
  </React.StrictMode>
)
