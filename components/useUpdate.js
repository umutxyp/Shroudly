'use client';

/*
 * Auto-update state from the main process (electron/updater.js), shared by the
 * update banner and the About tab through a single IPC subscription.
 */

import { useEffect, useState } from 'react';

let current = null;
let wired = false;
const subscribers = new Set();

function push(state) {
  current = state;
  subscribers.forEach((fn) => fn(state));
}

function wire() {
  const e = typeof window !== 'undefined' ? window.electron : null;
  if (wired || !e?.getUpdateState) return;
  wired = true;
  e.getUpdateState().then(push).catch(() => {});
  e.onUpdateState?.(push);
}

export function useUpdate() {
  const [state, setState] = useState(current);
  useEffect(() => {
    wire();
    subscribers.add(setState);
    if (current) setState(current);
    return () => { subscribers.delete(setState); };
  }, []);
  return state;
}

/* Seconds left until an automatic restart, ticking once per second. */
export function useCountdown(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
}

const api = () => (typeof window !== 'undefined' ? window.electron : null);
export const updateActions = {
  check: () => api()?.checkForUpdates?.(),
  download: () => api()?.downloadUpdate?.(),
  install: () => api()?.installUpdate?.(),
  postpone: () => api()?.postponeUpdate?.(),
};

export const RELEASES_URL = 'https://github.com/umutxyp/Shroudly/releases/latest';
