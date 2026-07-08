import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Terminal from "./Terminal";
import { typeFilesAsPaths } from "./attachFiles";
import { Project, Terminal as Term, TermStatus } from "../../types";
import {
  isTermShown,
  pruneTermContainers,
  setTermParking,
  subscribeDock,
  termContainer,
} from "./termDock";

/**
 * Owns every live <Terminal> exactly once, rendered through a portal into that
 * terminal's dock container (see termDock). Whichever surface currently claims
 * the terminal — a project pane float or a live-canvas session node — receives
 * the same DOM, so nothing remounts on moves. The wrapper carries the OS-file
 * "drop to attach as path" behavior, so every dock surface gets it for free.
 *
 * A terminal's portal exists once its project has been visited (same lazy-spawn
 * behavior as before, when ProjectView owned the terminals).
 */
export default function TermPortals({
  terminals,
  projects,
  visited,
  woken,
  onStatus,
  onNotice,
}: {
  terminals: Term[];
  projects: Project[];
  visited: Record<string, boolean>;
  /** terminals explicitly woken from the live canvas (spawn without a visit) */
  woken: Record<string, boolean>;
  onStatus: (id: string, status: TermStatus) => void;
  onNotice: (kind: "ok" | "err" | "info", text: string) => void;
}) {
  // re-render when docking changes (drives each Terminal's `visible` prop)
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeDock(force), []);

  // hidden, document-connected parking lot for unclaimed terminals
  const parkRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTermParking(parkRef.current);
    return () => setTermParking(null);
  }, []);

  // drop containers of closed terminals
  useEffect(() => {
    pruneTermContainers(new Set(terminals.map((t) => t.id)));
  }, [terminals]);

  const projById = Object.fromEntries(projects.map((p) => [p.id, p]));

  return (
    <>
      <div className="term-parking" ref={parkRef} />
      {terminals
        .filter((t) => (visited[t.projectId] || woken[t.id]) && projById[t.projectId])
        .map((t) =>
          createPortal(
            <TermChrome
              term={t}
              projectPath={projById[t.projectId].path}
              onStatus={onStatus}
              onNotice={onNotice}
            />,
            termContainer(t.id),
            t.id,
          ),
        )}
    </>
  );
}

/** The terminal + its OS-file drop-to-attach overlay (surface-independent). */
function TermChrome({
  term,
  projectPath,
  onStatus,
  onNotice,
}: {
  term: Term;
  projectPath: string;
  onStatus: (id: string, status: TermStatus) => void;
  onNotice: (kind: "ok" | "err" | "info", text: string) => void;
}) {
  const [fileHover, setFileHover] = useState(false);
  return (
    <div
      className="term-wrap"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!fileHover) setFileHover(true);
      }}
      onDragLeave={(e) => {
        // Ignore leaves into our own children (xterm's internals).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFileHover(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setFileHover(false);
        // A dropped FOLDER exposes no path and no bytes to the webview
        // (dragDropEnabled is off) — only copy→paste can carry its real path.
        // Attach the plain files, explain the folders.
        const files: File[] = [];
        let dirs = 0;
        for (const it of Array.from(e.dataTransfer.items)) {
          if (it.webkitGetAsEntry?.()?.isDirectory) {
            dirs++;
            continue;
          }
          const file = it.getAsFile();
          if (file) files.push(file);
        }
        if (dirs > 0)
          onNotice(
            "info",
            "폴더는 드래그로 경로를 읽을 수 없어요 — 폴더를 복사(Ctrl+C)한 뒤 터미널에 붙여넣기(Ctrl+V)하면 실제 경로가 입력돼요",
          );
        if (files.length) void typeFilesAsPaths(term.id, files);
      }}
    >
      <Terminal
        id={term.id}
        cwd={term.cwd ?? projectPath}
        startup={term.startup}
        resumeId={term.resumeId}
        visible={isTermShown(term.id)}
        onStatus={onStatus}
      />
      {fileHover && <div className="file-drop-hint">놓으면 파일 경로가 입력돼요</div>}
    </div>
  );
}
