// Pure helpers for global presets + per-project overrides.
import { Preset, PresetOverride } from "../types";

/** The body (command for code, prompt for ai) a preset runs with, after applying
 *  a project's override. Override wins when it has a non-empty value. */
export function effectiveBody(p: Preset, ov?: PresetOverride): string {
  if (p.kind === "code") return (ov?.command?.trim() ? ov.command : p.command) ?? "";
  return (ov?.prompt?.trim() ? ov.prompt : p.prompt) ?? "";
}

/** A preset with its per-project override folded into command/prompt, ready to
 *  run or display for that project. */
export function resolvePreset(p: Preset, ov?: PresetOverride): Preset {
  const body = effectiveBody(p, ov);
  return p.kind === "code" ? { ...p, command: body } : { ...p, prompt: body };
}

/** True when this project has an override that actually changes the body. */
export function isOverridden(p: Preset, ov?: PresetOverride): boolean {
  if (!ov) return false;
  const v = p.kind === "code" ? ov.command : ov.prompt;
  return !!v?.trim();
}
