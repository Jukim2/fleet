// Turn pasted/dropped Files into terminal input: save each to a temp file via
// the Rust side and TYPE its path into the PTY (claude reads images by path —
// the image itself can't go into a TUI). Shared by the imeBridge paste handler
// (clipboard screenshots, copied files) and ProjectView's drop handler.
import { saveAttachment } from "../../api/attach";
import { writePty } from "../../api/pty";

/** Larger than this is almost certainly a mis-drop, and base64 over IPC would
 *  stall the UI — skip it (the caller reports how many actually attached). */
const MAX_BYTES = 64 * 1024 * 1024;

export const quotePath = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** Type real filesystem paths (from the OS clipboard) into the PTY. */
export const typePaths = (termId: string, paths: string[]) =>
  writePty(termId, paths.map(quotePath).join(" ") + " ");

const toBase64 = async (f: File): Promise<string> => {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit safety
  for (let i = 0; i < buf.length; i += CHUNK)
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
};

/** Save each file and type its (quoted, space-terminated) path into the PTY.
 *  Returns how many files were attached. */
export async function typeFilesAsPaths(termId: string, files: File[]): Promise<number> {
  let attached = 0;
  for (const f of files) {
    if (f.size > MAX_BYTES) continue;
    try {
      const path = await saveAttachment(f.name || "attachment", await toBase64(f));
      await writePty(termId, quotePath(path) + " ");
      attached++;
    } catch {
      /* save failed — skip this file */
    }
  }
  return attached;
}
