import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// MSAL can return a silent token response to the app URL in a hidden iframe.
// Rendering the CRM there starts routing, polling, and another silent token
// request inside the callback frame. Leave that frame inert so the parent
// MSAL instance can read the response hash without recursively booting the app.
const isSilentAuthFrame = window.self !== window.top && !window.opener

if (!isSilentAuthFrame) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
