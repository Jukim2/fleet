// Config persistence (load/save the whole FleetConfig as JSON on disk).
import { invoke } from "@tauri-apps/api/core";
import { FleetConfig, emptyConfig } from "../types";

export async function loadConfig(): Promise<FleetConfig> {
  const raw = await invoke<string>("load_config");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed) return emptyConfig;
    const cfg: FleetConfig = {
      projects: parsed.projects ?? [],
      terminals: parsed.terminals ?? [],
      layouts: parsed.layouts ?? {},
      blocks: parsed.blocks ?? [],
      // may be a legacy Record<projectId, Preset[]> on disk; migratePresets sorts it
      presets: parsed.presets ?? [],
      presetOverrides: parsed.presetOverrides ?? {},
      boards: parsed.boards ?? {},
      webTabs: parsed.webTabs ?? [],
      plans: parsed.plans ?? {},
    };
    // Carry legacy per-terminal queues (pre-board configs) for one-time migration.
    if (parsed.queues) (cfg as unknown as { queues: unknown }).queues = parsed.queues;
    return cfg;
  } catch {
    return emptyConfig;
  }
}

export const saveConfig = (config: FleetConfig) =>
  invoke<void>("save_config", { data: JSON.stringify(config, null, 2) });
