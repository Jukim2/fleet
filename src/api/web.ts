// Wrappers over the Rust web-tab commands. Each web tab is a native webview
// window (label `web-<id>`) showing a logged-in AI site, driven via JS eval.
import { invoke } from "@tauri-apps/api/core";

/** Window label for a web tab id. Tauri labels allow [a-zA-Z0-9-_], so a uuid is fine. */
export const labelFor = (id: string) => `web-${id}`;

/** Open a web tab. `profile` keys an isolated login session (one per tab id →
 *  the same site can be signed into different accounts in different tabs). */
export const openWebTab = (id: string, url: string, title: string, profile: string) =>
  invoke<void>("open_web_tab", { label: labelFor(id), url, title, profile });

export const webEval = (id: string, js: string) =>
  invoke<void>("web_eval", { label: labelFor(id), js });

/** Evaluate JS in a web tab and get its result back (JSON string). Used to
 *  read page state — e.g. detect a freshly generated image URL. */
export const webEvalCb = (id: string, js: string) =>
  invoke<string>("web_eval_cb", { label: labelFor(id), js });

export const closeWebTab = (id: string) =>
  invoke<void>("close_web_tab", { label: labelFor(id) });

export const isWebTabOpen = (id: string) =>
  invoke<boolean>("web_tab_open", { label: labelFor(id) });

/** Queue a prompt for the browser userscript (real browser tabs) to pick up.
 *  `sites` = hostnames to target (substring match); empty = all. */
export const webEnqueue = (text: string, sites: string[] = []) =>
  invoke<number>("web_enqueue", { text, sites });
