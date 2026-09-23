import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)

if (import.meta.env.DEV) {
  console.log(`[droplet-files] renderer mounted; api=${typeof window.api}`)
}
