import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./styles/global.css";

// No StrictMode: it double-mounts components, which would spawn each PTY twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// Tell the boot watchdog in index.html that React mounted, so it stops trying
// to reload. Reset the reload counter so a genuine later failure gets retries.
window.__fleetMounted = true;
try {
  sessionStorage.removeItem("fleet-boot-reloads");
} catch {
  // sessionStorage may be unavailable; the watchdog simply won't reset.
}
