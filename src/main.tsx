import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) { refreshing = true; window.location.reload(); }
  });
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const announce = () => {
        if (registration.waiting && navigator.serviceWorker.controller) window.dispatchEvent(new Event('fameloop:update-ready'));
      };
      announce();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed') announce(); });
      });
      window.setInterval(() => registration.update().catch(() => undefined), 60 * 60 * 1000);
      window.addEventListener('fameloop:apply-update', () => registration.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    } catch (error) { console.warn('FameLoop offline updates unavailable', error); }
  });
}
