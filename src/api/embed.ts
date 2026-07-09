// invoke() wrappers for in-window embedded web panes (src-tauri/src/embed.rs).
// A child webview is positioned over a DOM region; the frontend feeds it that
// region's rect and hides it when an overlay should sit on top.
import { invoke } from "@tauri-apps/api/core";

export const embedWebCreate = (
  label: string,
  url: string,
  x: number,
  y: number,
  w: number,
  h: number,
  profile: string,
) => invoke<void>("embed_web_create", { label, url, x, y, w, h, profile });

export const embedWebBounds = (label: string, x: number, y: number, w: number, h: number) =>
  invoke<void>("embed_web_bounds", { label, x, y, w, h });

export const embedWebShow = (label: string, visible: boolean) =>
  invoke<void>("embed_web_show", { label, visible });

export const embedWebClose = (label: string) => invoke<void>("embed_web_close", { label });
