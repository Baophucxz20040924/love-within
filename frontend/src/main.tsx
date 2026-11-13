import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Be Vietnam Pro: designed for Vietnamese diacritics; self-hosted (no third-party font request, works offline).
// Only the latin + vietnamese subsets: every Vietnamese letter (ă, đ, ơ, ư, ạ…) is in the vietnamese subset, so the
// ~13 KB-per-weight latin-ext files are not needed (rare non-Vietnamese accented letters fall back to the system font).
import '@fontsource/be-vietnam-pro/latin-400.css';
import '@fontsource/be-vietnam-pro/vietnamese-400.css';
import '@fontsource/be-vietnam-pro/latin-500.css';
import '@fontsource/be-vietnam-pro/vietnamese-500.css';
import '@fontsource/be-vietnam-pro/latin-600.css';
import '@fontsource/be-vietnam-pro/vietnamese-600.css';
import '@fontsource/be-vietnam-pro/latin-700.css';
import '@fontsource/be-vietnam-pro/vietnamese-700.css';
import '@fontsource/be-vietnam-pro/latin-800.css';
import '@fontsource/be-vietnam-pro/vietnamese-800.css';
import { App } from './app/App';
import { captureInstallPrompt } from './lib/installPrompt';
import './styles/global.css';

// Before the first render: Chrome may offer the install prompt right after load (used by the /install page).
captureInstallPrompt();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: register the minimal service worker in production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
