// System diagnostics + app auto-update wrappers.
import { invoke } from "@tauri-apps/api/core";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type Diagnostics = {
  version: string;
  home: string;
  configPath: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  hookPort: number;
  hookInstalled: boolean;
};

export const appDiagnostics = () => invoke<Diagnostics>("app_diagnostics");
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
export const openPath = (path: string) => invoke<void>("open_path", { path });

export type UpdateAvailable = {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  /** Download + install, then relaunch the app. */
  install: (onProgress?: (pct: number) => void) => Promise<void>;
};

/** Resolves to update info when one is available, or null (incl. on any error,
 *  e.g. running an unbundled dev build with no release endpoint). */
export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  let update: Update | null;
  try {
    update = await check();
  } catch {
    return null; // no network / no updater artifacts / dev build
  }
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body || undefined,
    date: update.date || undefined,
    install: async (onProgress) => {
      let total = 0;
      let got = 0;
      await update!.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
        } else if (ev.event === "Finished") {
          onProgress?.(100);
        }
      });
      await relaunch();
    },
  };
}
