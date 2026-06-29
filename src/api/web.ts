// Wrappers over the Rust web-tab commands. Each web tab is a native webview
// window (label `web-<id>`) showing a logged-in AI site, driven via JS eval.
import { invoke } from "@tauri-apps/api/core";

/** Window label for a web tab id. Tauri labels allow [a-zA-Z0-9-_], so a uuid is fine. */
export const labelFor = (id: string) => `web-${id}`;

export const openWebTab = (id: string, url: string, title: string) =>
  invoke<void>("open_web_tab", { label: labelFor(id), url, title });

export const webEval = (id: string, js: string) =>
  invoke<void>("web_eval", { label: labelFor(id), js });

export const closeWebTab = (id: string) =>
  invoke<void>("close_web_tab", { label: labelFor(id) });

export const isWebTabOpen = (id: string) =>
  invoke<boolean>("web_tab_open", { label: labelFor(id) });

/** Queue a prompt for the browser userscript (real browser tabs) to pick up.
 *  `sites` = hostnames to target (substring match); empty = all. */
export const webEnqueue = (text: string, sites: string[] = []) =>
  invoke<number>("web_enqueue", { text, sites });
