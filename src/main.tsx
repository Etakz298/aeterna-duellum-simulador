import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyOrientation } from './rotation'

// Alto real visible: en algunos móviles 100vh incluye la zona tapada por la
// barra del navegador y la parte de abajo de la mesa quedaba cortada.
// En móviles en vertical, además, la aplicación se gira para verse en horizontal
applyOrientation()
window.addEventListener('resize', applyOrientation)
window.addEventListener('orientationchange', () => setTimeout(applyOrientation, 300))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
