import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LiveTvIntegration } from './components/LiveTvIntegration';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <LiveTvIntegration />
  </StrictMode>,
);