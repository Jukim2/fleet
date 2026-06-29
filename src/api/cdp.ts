// Drive a real Chrome (for sites that block embedding, e.g. ChatGPT) over the
// Chrome DevTools Protocol. Fleet launches Chrome with remote debugging; these
// wrap the Rust side that talks to it.
import { invoke } from "@tauri-apps/api/core";

export type CdpTarget = { ws: string; url: string; title: string };

/** Launch the Fleet-controlled Chrome (if needed) and open `url` in a tab. */
export const cdpOpen = (url: string) => invoke<void>("cdp_open", { url });

/** List open page tabs in the Fleet-controlled Chrome. */
export const cdpTargets = () => invoke<CdpTarget[]>("cdp_targets");

/** Evaluate JS in a tab via its CDP WebSocket URL. */
export const cdpEval = (ws: string, js: string) => invoke<void>("cdp_eval", { ws, js });
