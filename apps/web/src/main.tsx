import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/newsreader/wght-italic.css';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initializePlatform } from './workspace/platform';

async function start() {
  await initializePlatform();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </BrowserRouter>
    </React.StrictMode>,
  );
}
void start().catch((error) => {
  const root = document.getElementById('root');
  if (root) {
    root.textContent =
      error instanceof Error
        ? error.message
        : 'De app kon niet worden gestart. Bewaar de appgegevens en neem contact op met ondersteuning.';
    root.setAttribute('role', 'alert');
  }
});
