// Pure helpers for global presets + their per-project bodies.
import { Preset, PresetBody } from "../types";

/** The string this preset runs with in a given project: the project's `command`
 *  (code) or `prompt` (ai). Empty string when the project hasn't created a body
 *  for this preset yet. */
export function presetBody(p: Preset, body?: PresetBody): string {
  const v = p.kind === "code" ? body?.command : body?.prompt;
  return v?.trim() ? v : "";
}

/** True when this project has created a non-empty body for the preset. */
export function hasBody(p: Preset, body?: PresetBody): boolean {
  return presetBody(p, body).trim() !== "";
}
