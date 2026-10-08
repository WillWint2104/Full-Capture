// Entry point: start the Session, then the interface.
import { Session } from './session.js';
import { createUI } from './ui/app.js';

async function boot() {
  const session = new Session();
  globalThis.fullCapture = session;   // handy for support and for tests
  const ui = createUI(session);
  if (!navigator.mediaDevices?.getDisplayMedia) {
    ui.notices.toast({ kind: 'error', title: 'This browser can’t record the screen', text: 'Open this file in Chrome or Edge on a computer.' });
  }
  try {
    await session.init();
  } catch (e) {
    console.error(e);
    ui.notices.toast({ kind: 'error', title: 'Something went wrong while starting', text: `${e.message || e}. Reload the page to try again.` });
  }
  document.documentElement.dataset.ready = 'true';
}

boot();
