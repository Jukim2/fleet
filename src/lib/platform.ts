// Platform-aware shortcut labels: Cmd (⌘) on macOS, Ctrl elsewhere.
// The key handling in App.tsx already accepts both metaKey and ctrlKey; this is
// only about what we *show* the user.
const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Shortcut label, e.g. mod("K") -> "⌘K" on macOS, "Ctrl+K" on Windows/Linux. */
export const mod = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`);
