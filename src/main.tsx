import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LiveTvIntegration } from './components/LiveTvIntegration';
import './styles.css';

/*
 * One boundary around both trees. Separate boundaries would let the app crash
 * while the Live TV integration kept running underneath the fallback, which
 * reads as a half-broken page rather than a clear failure.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <LiveTvIntegration />
    </ErrorBoundary>
  </StrictMode>,
);
