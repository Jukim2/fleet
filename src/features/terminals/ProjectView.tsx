import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Terminal from "./Terminal";
import NewTerminalMenu from "./NewTerminalMenu";
import SplitLayout, { SplitCtx } from "./SplitLayout";
import { LayoutNode, Project, Terminal as Term, TermStatus } from "../../types";
import { leaves } from "../../lib/layout";
import { openPath } from "../../api/system";
import { mod } from "../../lib/platform";
import "./terminals.css";

type Rect = { left: number; top: number; width: number; height: number };
type PaneRect = { paneId: string; termId: string; rect: Rect };
type Zone = "center" | "left" | "right" | "top" | "bottom";

function zoneOf(rect: Rect, x: number, y: number): Zone {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx > 0.28 && rx < 0.72 && ry > 0.28 && ry < 0.72) return "center";
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  return (Object.keys(d) as Zone[]).reduce((a, b) => ((d as any)[b] < (d as any)[a] ? b : a), "left");
}

function hintRect(rect: Rect, zone: Zone): Rect {
  const { left, top, width: w, height: h } = rect;
  switch (zone) {
    case "left":
      return { left, top, width: w / 2, height: h };
    case "right":
      return { left: left + w / 2, top, width: w / 2, height: h };
    case "top":
      return { left, top, width: w, height: h / 2 };
    case "bottom":
      return { left, top: top + h / 2, width: w, height: h / 2 };
    default:
      return rect;
  }
}

export default function ProjectView({
  project,
  terminals,
  layout,
  focusedPaneId,
  statuses,
  visible,
  onActivateTerm,
  onReorderTerms,
  onNewTerm,
  onCloseTerm,
  onRenameTerm,
  onFocusPane,
  onSetRatio,
  onSplit,
  onClosePane,
  onSetLeafTerm,
  onSplitWithTerm,
  onMovePane,
  onStatus,
  onOpenPalette,
  onOpenDrawer,
  onOpenWeb,
  onOpenPlan,
  wtActive,
}: {
  project: Project;
  terminals: Term[];
  layout: LayoutNode | null;
  focusedPaneId: string | null;
  statuses: Record<string, TermStatus>;
  visible: boolean;
  onActivateTerm: (termId: string) => void;
  onReorderTerms: (fromId: string, toId: string) => void;
  onNewTerm: (startup: string, title: string) => void;
  onCloseTerm: (termId: string) => void;
  onRenameTerm: (termId: string, title: string) => void;
  onFocusPane: (paneId: string) => void;
  onSetRatio: (splitId: string, ratio: number) => void;
  onSplit: (paneId: string, dir: "row" | "col") => void;
  onClosePane: (paneId: string) => void;
  onSetLeafTerm: (paneId: string, termId: string) => void;
  onSplitWithTerm: (paneId: string, dir: "row" | "col", before: boolean, termId: string) => void;
  onMovePane: (sourcePaneId: string, targetPaneId: string, zone: Zone) => void;
  onStatus: (id: string, status: TermStatus) => void;
  onOpenPalette: () => void;
  onOpenDrawer: (section: "blocks" | "queue") => void;
  onOpenWeb: () => void;
  onOpenPlan: () => void;
  wtActive?: { done: number; total: number; active: number; error: number };
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [panes, setPanes] = useState<PaneRect[]>([]);
  const [tick, setTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragTermId, setDragTermId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ rect: Rect; zone: Zone } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const termsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
  const layoutLeaves = layout ? leaves(layout) : [];

  // Measure each pane body relative to the stage so terminals can float over them.
  useLayoutEffect(() => {
    if (!visible) return;
    const stage = stageRef.current;
    if (!stage) return;
    const base = stage.getBoundingClientRect();
    const next: PaneRect[] = [];
    stage.querySelectorAll<HTMLElement>("[data-pane-id]").forEach((el) => {
      const paneId = el.getAttribute("data-pane-id")!;
      const termId = el.getAttribute("data-term-id") || "";
      const r = el.getBoundingClientRect();
      next.push({
        paneId,
        termId,
        rect: { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height },
      });
    });
    setPanes(next);
  }, [layout, visible, tick]);

  // Remeasure whenever the stage or any pane resizes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(stage);
    stage.querySelectorAll<HTMLElement>("[data-pane-id]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [layout, visible]);

  const rectForTerm = (termId: string) => panes.find((p) => p.termId === termId)?.rect;

  const focusByTerm = (termId: string) => {
    const leaf = layoutLeaves.find((l) => l.termId === termId);
    if (leaf) onFocusPane(leaf.id);
  };

  const startRename = (termId: string, current: string) => {
    setEditing(termId);
    setDraft(current);
  };
  const commitRename = () => {
    if (editing && draft.trim()) onRenameTerm(editing, draft.trim());
    setEditing(null);
  };

  const paneAt = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const base = stage.getBoundingClientRect();
    const x = clientX - base.left;
    const y = clientY - base.top;
    const hit = panes.find(
      (p) =>
        x >= p.rect.left &&
        x <= p.rect.left + p.rect.width &&
        y >= p.rect.top &&
        y <= p.rect.top + p.rect.height,
    );
    return hit ? { hit, x, y } : null;
  };

  const onDragOverStage = (e: React.DragEvent) => {
    e.preventDefault();
    const at = paneAt(e.clientX, e.clientY);
    // No valid target over an empty area, or over the pane that already shows
    // the dragged terminal (dropping there would just duplicate it).
    if (!at || (dragTermId && at.hit.termId === dragTermId)) {
      setHint(null);
      return;
    }
    const zone = zoneOf(at.hit.rect, at.x, at.y);
    setHint({ rect: hintRect(at.hit.rect, zone), zone });
  };

  const onDropStage = (e: React.DragEvent) => {
    e.preventDefault();
    const termId = e.dataTransfer.getData("text/term");
    const sourcePaneId = e.dataTransfer.getData("text/pane");
    const at = paneAt(e.clientX, e.clientY);
    setDragging(false);
    setDragTermId(null);
    setHint(null);
    if (!termId || !at) return;
    // Dropping a terminal onto the pane already showing it is a no-op.
    if (at.hit.termId === termId) return;
    const zone = zoneOf(at.hit.rect, at.x, at.y);
    // Dragging a whole pane (VS Code-style): move it and collapse the old slot.
    if (sourcePaneId) {
      onMovePane(sourcePaneId, at.hit.paneId, zone);
      return;
    }
    if (zone === "center") onSetLeafTerm(at.hit.paneId, termId);
    else if (zone === "left") onSplitWithTerm(at.hit.paneId, "row", true, termId);
    else if (zone === "right") onSplitWithTerm(at.hit.paneId, "row", false, termId);
    else if (zone === "top") onSplitWithTerm(at.hit.paneId, "col", true, termId);
    else onSplitWithTerm(at.hit.paneId, "col", false, termId);
  };

  const onPaneDragStart = (e: React.DragEvent, paneId: string, termId: string) => {
    e.dataTransfer.setData("text/term", termId);
    e.dataTransfer.setData("text/pane", paneId);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
    setDragTermId(termId);
  };
  const onPaneDragEnd = () => {
    setDragging(false);
    setDragTermId(null);
    setHint(null);
  };

  const ctx: SplitCtx = {
    focusedPaneId,
    termsById,
    statuses,
    canClose: layoutLeaves.length > 1,
    onFocusPane,
    onSetRatio,
    onSplit,
    onClosePane,
    onPaneDragStart,
    onPaneDragEnd,
  };

  return (
    <section className="pv" style={{ display: visible ? "flex" : "none" }}>
      <header className="pv-head">
        <div className="pv-title">
          <strong>{project.name}</strong>
          <span className="pv-path" title={project.path}>
            {project.path}
          </span>
          <button className="pv-open" title="폴더 열기" onClick={() => openPath(project.path)}>
            📂
          </button>
        </div>
        <div className="pv-tools">
          <button className="tool" onClick={onOpenPalette} title={`블럭 빠른 전송 (${mod("K")})`}>
            {mod("K")}
          </button>
          <button className="tool" onClick={() => onOpenDrawer("blocks")} title="블럭">
            블럭
          </button>
          <button className="tool" onClick={() => onOpenDrawer("queue")} title="큐">
            큐
          </button>
          <button
            className={`tool ${wtActive ? "tool-live" : ""}`}
            onClick={onOpenPlan}
            title="요청 → 단계 분해 → 실행"
          >
            플랜
            {wtActive && (
              <span className={`tool-badge ${wtActive.error ? "err" : "go"}`}>
                {wtActive.done}/{wtActive.total}
              </span>
            )}
          </button>
          <button className="tool" onClick={onOpenWeb} title="웹 AI 탭 (동시 전송)">
            웹
          </button>
          <NewTerminalMenu onCreate={onNewTerm} />
        </div>
      </header>

      <div className="tabs">
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`tab ${rectForTerm(t.id) ? "shown" : ""}`}
            draggable={editing !== t.id}
            onClick={() => onActivateTerm(t.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/term", t.id);
              e.dataTransfer.effectAllowed = "move";
              setDragging(true);
              setDragTermId(t.id);
            }}
            onDragEnd={() => {
              setDragging(false);
              setDragTermId(null);
              setHint(null);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/term");
              if (from && from !== t.id) onReorderTerms(from, t.id);
            }}
          >
            <span className={`tdot ${statuses[t.id] ?? "stopped"}`} />
            {editing === t.id ? (
              <input
                className="tab-edit"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <span
                className="tab-title"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(t.id, t.title);
                }}
              >
                {t.title}
              </span>
            )}
            <button
              className="tab-x"
              title="터미널 닫기"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTerm(t.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="stage" ref={stageRef}>
        {layout ? (
          <SplitLayout node={layout} ctx={ctx} />
        ) : (
          <div className="stage-empty">
            <p>열린 터미널이 없어요.</p>
            <p className="stage-empty-sub">탭을 클릭하거나 ＋ 로 새 터미널을 여세요.</p>
          </div>
        )}

        {terminals.map((t) => {
          const rect = rectForTerm(t.id);
          const shown = visible && !!rect;
          return (
            <div
              key={t.id}
              className="term-float"
              style={
                shown
                  ? { left: rect!.left, top: rect!.top, width: rect!.width, height: rect!.height }
                  : { display: "none" }
              }
              onMouseDown={() => focusByTerm(t.id)}
            >
              <Terminal
                id={t.id}
                cwd={t.cwd ?? project.path}
                startup={t.startup}
                visible={shown}
                onStatus={onStatus}
              />
            </div>
          );
        })}

        {/* Active only while dragging a tab — captures drops over terminals too. */}
        {dragging && (
          <div
            className="drop-catcher"
            onDragOver={onDragOverStage}
            onDragLeave={() => setHint(null)}
            onDrop={onDropStage}
          >
            {hint && (
              <div
                className="drop-hint"
                style={{
                  left: hint.rect.left,
                  top: hint.rect.top,
                  width: hint.rect.width,
                  height: hint.rect.height,
                }}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
