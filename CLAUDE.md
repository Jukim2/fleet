# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fleet is a Tauri 2 desktop app (Rust backend + React 19/TS frontend) for managing many interactive `claude` sessions side by side, one **real PTY terminal per session**. It deliberately runs the logged-in interactive `claude` TUI (not headless `claude -p`), so there is no extra API billing — it drives the same subscription session the user runs in a normal terminal.

The UI is in Korean; keep user-facing strings Korean to match.

## Commands

```bash
npm install
npm run tauri dev      # dev (Vite on :1420 + Rust, hot reload)
npm run tauri build    # release bundle (.app/.dmg/.msi)
npm run dev            # frontend only (Tauri APIs unavailable — invoke() will fail)
npm run build          # tsc typecheck + vite build (use this to typecheck the frontend)
```

There is no test suite, linter config, or single-test command. `npm run build` (the `tsc` step) is the only automated check. Rust: `cd src-tauri && cargo build` / `cargo check`.

## Architecture

The app is a single window. Everything funnels through one central store hook; the Rust side is a thin PTY + filesystem service.

### Backend — `src-tauri/src/` (split by concern)
`lib.rs` is just the module root: it defines `run()` (plugins, managed state, the `invoke_handler!` list) and the shared `home_dir()`. Each concern is its own module: `pty.rs`, `sessions.rs` (resume discovery), `config.rs`, `bridge.rs` (hook + web-poll server, hook install), `webtabs.rs`, `cdp.rs`, `diagnostics.rs`.
- **PTY sessions** (`pty.rs`): `Sessions(Mutex<HashMap<id, Session>>)`. `spawn_session` opens a `portable-pty` PTY in the project's cwd running the default shell, then types the `startup_cmd` (e.g. `claude`) into it. A reader thread streams PTY bytes to the frontend via the `pty-output` event and emits `pty-exit` on close. The shell — not a direct `claude` spawn — is the PTY's process, so the terminal survives `claude` exiting. Commands: `write_pty`, `send_prompt` (appends `\r` to submit in claude's TUI), `resize_pty`, `kill_session`, `list_sessions`.
- **Claude session discovery (resume)** (`sessions.rs`): `list_claude_sessions(cwd)` reads `~/.claude/projects/<encoded-cwd>/*.jsonl` and extracts each transcript's first real user message as a summary. `encode_project_dir` replaces every non-`[A-Za-z0-9-]` char with `-` (matching Claude Code's own scheme); lookup is **case-insensitive** to work around a Windows drive-letter casing bug (`C--…` vs `c--…`).
- **Config persistence** (`config.rs`): `load_config`/`save_config` read/write `fleet.json` in the OS app-config dir. The whole `FleetConfig` is serialized as one JSON blob.
- **Hook bridge (status without screen-scraping)** (`bridge.rs`): `start_hook_server` runs a tiny localhost HTTP server on port **47100** (also serves the web-poll queue). Each PTY is tagged with env `FLEET_TERM_ID`. `ensure_hook_installed` merges Fleet's lifecycle hooks (`Stop`, `UserPromptSubmit`, `Notification`) into `~/.claude/settings.json`; the installed hook command POSTs the hook JSON to `/hook?term=$FLEET_TERM_ID`. The server re-emits each as a `hook-event` Tauri event. Hook install is idempotent — groups whose command contains `FLEET_TERM_ID` are treated as ours and replaced. **`HOOK_PORT` and the `HOOK_CMD` curl string must stay in sync.**

When adding a Rust command, put it in the concern's module (`pub fn` + `#[tauri::command]`), register it in the `invoke_handler!` list in `lib.rs::run()` as `module::command`, and add a wrapper in the matching `src/api/*.ts`. Command return structs must be `pub` (the generated handler references them from `lib.rs`).

### Frontend
- **`src/hooks/useFleet.ts`** — the central store. Owns the entire `FleetConfig` plus non-persisted live state (terminal statuses, focused pane, board task status) and **every mutation**. `App.tsx` and feature components are mostly wiring. Config is auto-saved to disk on every change (the `useEffect` on `config`). New features almost always mean adding state + actions here.
- **`src/api/`** — thin `invoke()` wrappers, one per backend concern: `pty.ts`, `config.ts`, `claude.ts` (resume discovery + delete), `web.ts`, `cdp.ts`, `system.ts` (diagnostics + auto-updater).
- **`src/lib/layout.ts`** — pure, immutable functions over the recursive split-layout tree (`Leaf | Split`, see `types.ts`). Panes split row/col, leaves hold a `termId`. Invariant enforced here: **a terminal lives in at most one pane** (dedup in `setLeafTerm`/`splitLeafWithSide`) and **empty panes are never shown** (`compact`/`removeLeaf`/`normalize` collapse siblings up). Layouts are persisted per project.
- **`src/features/`** — `projects/` (rail), `terminals/` (Terminal, ProjectView, SplitLayout, NewTerminalMenu), `blocks/` (CommandPalette), `drawer/` (Drawer, BlocksPanel), `board/` (QueueBoard), `settings/` (SettingsPanel).

### Two key invariants to preserve

1. **Scrollback survives moves.** xterm instances are never recreated when tabs/panes are rearranged — the terminal is an absolutely-positioned overlay that is only repositioned, and layout state references it by `termId`. Don't remount terminals on layout change.

2. **Status comes from hooks, not the screen, once proven.** Two status sources exist: a fallback heuristic in `Terminal.tsx` that scans the xterm viewport for claude's `esc to interrupt` hint, and the authoritative Claude Code hook events. In `useFleet`, once a terminal has produced any hook event (`hookDriven`), the screen-scan heuristic is ignored for it (except a real `pty-exit` → `stopped`). Hooks also distinguish `waiting` (blocked on a permission prompt → OS notification) from `idle` (done). `TermStatus` = `stopped | busy | idle | waiting`.

### Queue board
Per-project board (`QueueBoard` in `types.ts`): **lanes** are terminals, each holding ordered **tasks** with cross-lane `deps`. A 1-second runner loop in `useFleet` dispatches a lane's head task when its terminal is `idle` and all its deps are `done`, so dep-free lanes run in parallel and dep chains serialize. A task is `done` when its terminal returns to idle after dispatch.

## Notes

- The README documents a removed scheduler and an old `api/claude.ts`/`QueuePanel`/`SchedulePanel` layout — trust the actual files over the README for structure.
- Config migration: `migrateBoards` upgrades the pre-board `queues` shape. When changing the persisted `FleetConfig` schema, handle old configs already on disk.
- The updater pulls release artifacts from the GitHub repo in `tauri.conf.json`; `checkForUpdate` returns null on dev builds with no endpoint.
