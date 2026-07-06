// Wrapper over the Rust attachment command: save pasted/dropped file bytes to
// a temp file and get back the absolute path to type into the terminal.
import { invoke } from "@tauri-apps/api/core";

export const saveAttachment = (name: string, dataBase64: string) =>
  invoke<string>("save_attachment", { name, dataBase64 });

/** Real paths of files/folders copied to the OS clipboard (Explorer/Finder).
 *  Empty when the clipboard holds no file list (e.g. a screenshot). */
export const clipboardPaths = () => invoke<string[]>("clipboard_paths");
