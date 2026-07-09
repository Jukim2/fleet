// Theme system. Single source of truth for every color token.
//
// Each theme is a small set of BASE tokens (backgrounds, text, one accent, the
// three status colors, and the xterm terminal colors). Every softer shade the
// UI needs — accent washes, hover fills, status halos, rings — is DERIVED from
// these bases with color-mix() in global.css (`:root`), so a theme never has to
// spell out 60 rgba() values and every derived shade adapts per theme for free.
//
// applyTheme() writes the base tokens as inline custom properties on <html>;
// the derived vars in :root reference them and recompute automatically. It also
// fires a `fleet-theme` event so the persistent xterm terminals (which can't
// read CSS) can pull their new colors. First paint (before JS) uses the Slate
// values hard-coded in global.css :root, so there's no flash.

export type ThemeId =
  | "slate"
  | "obsidian"
  | "nebula"
  | "nord"
  | "dracula"
  | "synthwave"
  | "paper";

export type ThemeGroup = "dark" | "light";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  group: ThemeGroup;
  /** base tokens, keyed without the leading `--` */
  tokens: Record<string, string>;
}

// Base token keys every theme must define. Keep in sync with global.css.
// bg            window / app background
// rail          left project rail
// surface       cards, buttons, bars, tabs
// surface-2     inputs, slightly-raised fills
// pane          terminal pane / editor body (the darkest reading surface)
// elevated      floating panels, overlays, popovers
// border        hairline dividers
// border-strong hover / focus borders
// text          primary text
// muted         secondary text
// accent        the one brand accent (links, focus, busy)
// accent-hover  brighter accent for hover
// on-accent     text/icon on an accent fill
// idle          status: done / idle
// busy          status: working (usually == accent)
// waiting       status: needs you (permission prompt)
// danger        errors / destructive
// term-*        xterm terminal bg / fg / cursor / selection

export const THEMES: Record<ThemeId, ThemeDef> = {
  slate: {
    id: "slate",
    name: "Slate",
    group: "dark",
    tokens: {
      bg: "#0B0F14",
      rail: "#0E141B",
      surface: "#121821",
      "surface-2": "#151C27",
      pane: "#0E141C",
      elevated: "#141B26",
      border: "#1E2733",
      "border-strong": "#2A3648",
      text: "#E6EBF2",
      muted: "#8A94A6",
      accent: "#3B82F6",
      "accent-hover": "#60A5FA",
      "on-accent": "#04080F",
      idle: "#34D399",
      busy: "#3B82F6",
      waiting: "#F59E0B",
      danger: "#F87171",
      "term-bg": "#0E141C",
      "term-fg": "#E6EBF2",
      "term-cursor": "#3B82F6",
      "term-selection": "#28344A",
    },
  },
  obsidian: {
    id: "obsidian",
    name: "Obsidian",
    group: "dark",
    tokens: {
      bg: "#0D0D0F",
      rail: "#101012",
      surface: "#17171A",
      "surface-2": "#1B1B1F",
      pane: "#101013",
      elevated: "#191919",
      border: "#242428",
      "border-strong": "#33333A",
      text: "#ECECEE",
      muted: "#8B8B92",
      accent: "#5B8DEF",
      "accent-hover": "#7BA5F5",
      "on-accent": "#04070E",
      idle: "#4ADE80",
      busy: "#5B8DEF",
      waiting: "#F5A623",
      danger: "#F87171",
      "term-bg": "#101013",
      "term-fg": "#ECECEE",
      "term-cursor": "#5B8DEF",
      "term-selection": "#2E2E36",
    },
  },
  nebula: {
    id: "nebula",
    name: "Nebula",
    group: "dark",
    tokens: {
      bg: "#0A0E1A",
      rail: "#0C1120",
      surface: "#10162A",
      "surface-2": "#141C33",
      pane: "#0B1120",
      elevated: "#121A30",
      border: "#1C2A44",
      "border-strong": "#294066",
      text: "#E8EEF7",
      muted: "#7E8AA6",
      accent: "#22D3EE",
      "accent-hover": "#2DD4BF",
      "on-accent": "#03121A",
      idle: "#34D399",
      busy: "#22D3EE",
      waiting: "#FBBF24",
      danger: "#FB7185",
      "term-bg": "#0B1120",
      "term-fg": "#E8EEF7",
      "term-cursor": "#22D3EE",
      "term-selection": "#1E3352",
    },
  },
  nord: {
    id: "nord",
    name: "Nord",
    group: "dark",
    tokens: {
      bg: "#2E3440",
      rail: "#2B303B",
      surface: "#3B4252",
      "surface-2": "#434C5E",
      pane: "#292E39",
      elevated: "#3B4252",
      border: "#434C5E",
      "border-strong": "#4C566A",
      text: "#ECEFF4",
      muted: "#8893A8",
      accent: "#88C0D0",
      "accent-hover": "#8FBCBB",
      "on-accent": "#0E1620",
      idle: "#A3BE8C",
      busy: "#88C0D0",
      waiting: "#EBCB8B",
      danger: "#BF616A",
      "term-bg": "#292E39",
      "term-fg": "#ECEFF4",
      "term-cursor": "#88C0D0",
      "term-selection": "#434C5E",
    },
  },
  dracula: {
    id: "dracula",
    name: "Dracula",
    group: "dark",
    tokens: {
      bg: "#282A36",
      rail: "#21222C",
      surface: "#343746",
      "surface-2": "#3C3F51",
      pane: "#21222C",
      elevated: "#343746",
      border: "#3C3F51",
      "border-strong": "#4C4F63",
      text: "#F8F8F2",
      muted: "#9CA0B6",
      accent: "#BD93F9",
      "accent-hover": "#D0AAFF",
      "on-accent": "#1A1024",
      idle: "#50FA7B",
      busy: "#BD93F9",
      waiting: "#F1FA8C",
      danger: "#FF5555",
      "term-bg": "#21222C",
      "term-fg": "#F8F8F2",
      "term-cursor": "#BD93F9",
      "term-selection": "#44475A",
    },
  },
  synthwave: {
    id: "synthwave",
    name: "Synthwave",
    group: "dark",
    tokens: {
      bg: "#1A1033",
      rail: "#160C2B",
      surface: "#241640",
      "surface-2": "#2D1B4E",
      pane: "#150A2E",
      elevated: "#241640",
      border: "#3A2560",
      "border-strong": "#4E3480",
      text: "#F5EEFF",
      muted: "#A996C8",
      accent: "#FF2E97",
      "accent-hover": "#FF5FB0",
      "on-accent": "#1A0512",
      idle: "#36F9C6",
      busy: "#FF2E97",
      waiting: "#FEDE5A",
      danger: "#FF5E5E",
      "term-bg": "#150A2E",
      "term-fg": "#F5EEFF",
      "term-cursor": "#FF2E97",
      "term-selection": "#3A2560",
    },
  },
  paper: {
    id: "paper",
    name: "Paper",
    group: "light",
    tokens: {
      bg: "#F7F8FA",
      rail: "#EFF1F5",
      surface: "#FFFFFF",
      "surface-2": "#F2F4F7",
      pane: "#FFFFFF",
      elevated: "#FFFFFF",
      border: "#E2E6EC",
      "border-strong": "#CDD4DE",
      text: "#14181F",
      muted: "#5B6675",
      accent: "#2563EB",
      "accent-hover": "#1D4ED8",
      "on-accent": "#FFFFFF",
      idle: "#16A34A",
      busy: "#2563EB",
      waiting: "#D97706",
      danger: "#DC2626",
      "term-bg": "#FFFFFF",
      "term-fg": "#1F2530",
      "term-cursor": "#2563EB",
      "term-selection": "#D6E4FF",
    },
  },
};

export const THEME_LIST: ThemeDef[] = Object.values(THEMES);
export const DEFAULT_THEME: ThemeId = "slate";

/** A few representative colors for a theme's picker swatch. */
export function themeSwatch(id: ThemeId) {
  const t = (THEMES[id] ?? THEMES[DEFAULT_THEME]).tokens;
  return {
    bg: t.bg,
    surface: t.surface,
    accent: t.accent,
    text: t.text,
    idle: t.idle,
    waiting: t.waiting,
  };
}

/** Read xterm's theme colors out of the currently-applied CSS custom props. */
export function readTermColors(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  return {
    background: v("--term-bg", "#0E141C"),
    foreground: v("--term-fg", "#E6EBF2"),
    cursor: v("--term-cursor", "#3B82F6"),
    selectionBackground: v("--term-selection", "#28344A"),
  };
}

let current: ThemeId = DEFAULT_THEME;
export const currentTheme = () => current;

/** Apply a theme: write base tokens onto <html>, mark it, and notify terminals. */
export function applyTheme(id: ThemeId) {
  const def = THEMES[id] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [k, val] of Object.entries(def.tokens)) {
    root.style.setProperty(`--${k}`, val);
  }
  root.dataset.theme = def.id;
  root.dataset.themeGroup = def.group;
  current = def.id;
  window.dispatchEvent(new CustomEvent("fleet-theme", { detail: def.id }));
}
