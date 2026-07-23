import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { configureApi } from './services/api.ts'

async function bootstrap() {
  if (window.electronAPI) {
    configureApi(await window.electronAPI.getBackendConfig())
  } else {
    const baseUrl = import.meta.env.VITE_API_URL
    const token = import.meta.env.VITE_API_TOKEN
    if (!baseUrl || !token) {
      throw new Error('Launch Cognito with Electron, or provide VITE_API_URL and VITE_API_TOKEN.')
    }
    configureApi({ baseUrl, token })
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  createRoot(document.getElementById('root')!).render(
    <main className="startup-error">
      <p className="eyebrow">LOCAL SERVICE UNAVAILABLE</p>
      <h1>Cognito could not start.</h1>
      <p>{message}</p>
    </main>,
  )
})
