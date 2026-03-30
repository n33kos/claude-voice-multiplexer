import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.scss'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Extensible command hook for the vmux-overlay native wrapper.
// pywebview's evaluate_js() calls this; the web app dispatches internally.
void ((window as any).vmuxCommand = (type: string, data?: any) => {
  document.dispatchEvent(
    new CustomEvent('vmux:command', { detail: { type, data } })
  )
})
