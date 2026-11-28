import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './design-tokens.css'
import './styles.css'
import './settings.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少应用容器')

// The service worker shows review reminders and an offline page. The app works the same without it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
