/// <reference types="vite/client" />

interface Window {
  /** Set by main.tsx after React mounts; read by the boot watchdog in index.html. */
  __fleetMounted?: boolean;
}
