// Guard run automatically before dev (npm "predev" lifecycle hook).
// Frees the Vite dev ports if an orphaned process is still holding them.
//
// Why this exists: on Windows, closing the Tauri app window does NOT reliably
// kill its `beforeDevCommand` (Vite) child process tree. A stale `node vite.js`
// server survives as an orphan and keeps holding port 1420, so the next
// `tauri dev` / `npm run dev` dies with "Port 1420 is already in use".
// This runs before Vite starts (regardless of how dev was launched) and clears it.
//
// Windows-only: macOS/Linux kill the process group cleanly, so this is a no-op there.

import { spawnSync } from "node:child_process";

// Keep in sync with vite.config.ts server.port / hmr. 1420 = dev server, 1421 = HMR.
const PORTS = [1420, 1421];

if (process.platform !== "win32") {
  process.exit(0);
}

// Collect PIDs currently LISTENING on any of our ports (netstat is always present).
// NOTE: no `-p tcp` filter — on Windows that shows IPv4 only, but Vite binds the
// IPv6 loopback (::1), which lives under TCPv6 and would be missed. Plain `-ano`
// lists both; we filter to LISTENING lines ourselves (UDP has no such state).
const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
if (netstat.status !== 0 || !netstat.stdout) {
  process.exit(0);
}

const pids = new Set();
for (const line of netstat.stdout.split(/\r?\n/)) {
  if (!/LISTENING/i.test(line)) continue;
  const cols = line.trim().split(/\s+/);
  // e.g. "TCP  [::1]:1420  [::]:0  LISTENING  178128"
  const local = cols[1] ?? "";
  const pid = cols[cols.length - 1];
  const port = Number(local.slice(local.lastIndexOf(":") + 1));
  if (PORTS.includes(port) && /^\d+$/.test(pid) && pid !== "0") {
    pids.add(pid);
  }
}

for (const pid of pids) {
  console.log(`[free-dev-port] Port held by PID ${pid} — killing orphaned dev process tree...`);
  spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
}

process.exit(0);
