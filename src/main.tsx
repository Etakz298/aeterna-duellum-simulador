import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Alto real visible: en algunos móviles 100vh incluye la zona tapada por la
// barra del navegador y la parte de abajo de la mesa quedaba cortada
const fitHeight = () => {
  document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`)
  document.documentElement.classList.add('js-h')
}
fitHeight()
window.addEventListener('resize', fitHeight)
window.addEventListener('orientationchange', () => setTimeout(fitHeight, 300))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
