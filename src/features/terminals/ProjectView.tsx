import { useEffect, useLayoutEffect, useRef, useState } from "react";
import NewTerminalMenu from "./NewTerminalMenu";
import SplitLayout, { SplitCtx } from "./SplitLayout";
import { TermSlot } from "./termDock";
import { LayoutNode, Project, Terminal as Term, TermStatus } from "../../types";
import { AgentKind } from "../../lib/agents";
import { leaves } from "../../lib/layout";
import { openPath } from "../../api/system";
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
  onOpenWeb,
  onOpenPlan,
  presetsOpen,
  onTogglePresets,
  wtActive,
  agent,
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
  onOpenWeb: () => void;
  onOpenPlan: () => void;
  presetsOpen: boolean;
  onTogglePresets: () => void;
  wtActive?: { done: number; total: number; active: number; error: number };
  /** the active agent CLI — decides the "＋ 새 세션" button's label + command */
  agent: AgentKind;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [panes, setPanes] = useState<PaneRect[]>([]);
  const [tick, setTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragTermId, setDragTermId] = useState<string | null>(null);
  const [hint, setHint] = useState<{ rect: Rect; zone: Zone } | null>(null);
  const termsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
  const layoutLeaves = layout ? leaves(layout) : [];
  // Tabs that exist but aren't in any pane — candidates to fill the vacated side
  // when you split a pane by dropping its OWN terminal onto an edge.
  const shownTermIds = new Set(layoutLeaves.map((l) => l.termId).filter(Boolean) as string[]);
  const unshownTerminals = terminals.filter((t) => !shownTermIds.has(t.id));

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
    if (!at) {
      setHint(null);
      return;
    }
    const zone = zoneOf(at.hit.rect, at.x, at.y);
    // Dropping a terminal onto its OWN pane only makes sense as a directional
    // split — and only if a free (unshown) tab can fill the side it vacates.
    // Otherwise (center, or nothing to fill with) there's nothing to do.
    if (dragTermId && at.hit.termId === dragTermId) {
      if (zone === "center" || unshownTerminals.length === 0) {
        setHint(null);
        return;
      }
    }
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
    const zone = zoneOf(at.hit.rect, at.x, at.y);
    // Dragging a whole pane (VS Code-style): move it and collapse the old slot.
    if (sourcePaneId) {
      onMovePane(sourcePaneId, at.hit.paneId, zone);
      return;
    }
    // Dropping a terminal onto its OWN pane: split it, keeping this terminal on
    // the dropped side and filling the vacated side with a free (unshown) tab.
    // We split with the FILL terminal on the *opposite* side, which leaves the
    // dragged one where it was dropped — no duplicate, no empty pane.
    if (at.hit.termId === termId) {
      const fill = unshownTerminals[0];
      if (!fill || zone === "center") return;
      if (zone === "left") onSplitWithTerm(at.hit.paneId, "row", false, fill.id);
      else if (zone === "right") onSplitWithTerm(at.hit.paneId, "row", true, fill.id);
      else if (zone === "top") onSplitWithTerm(at.hit.paneId, "col", false, fill.id);
      else onSplitWithTerm(at.hit.paneId, "col", true, fill.id);
      return;
    }
    if (zone === "center") onSetLeafTerm(at.hit.paneId, termId);
    else if (zone === "left") onSplitWithTerm(at.hit.paneId, "row", true, termId);
    else if (zone === "right") onSplitWithTerm(at.hit.paneId, "row", false, termId);
    else if (zone === "top") onSplitWithTerm(at.hit.paneId, "col", true, termId);
    else onSplitWithTerm(at.hit.paneId, "col", false, termId);
  };

  // Pointer-driven pane-bar drag (native HTML5 drag won't start from a pane bar
  // in WebView2). We compute the hovered pane + zone ourselves and reuse the
  // same move/split handlers the HTML5 chip drop uses.
  const onPanePointerDown = (e: React.MouseEvent, paneId: string, termId: string) => {
    const startX = e.clientX;
    const startY = e.clientY;
    // Snapshot what we need — layout can't change mid-drag.
    const shownPanes = panes;
    const fillTerm = unshownTerminals[0];
    let started = false;

    const paneAtClient = (cx: number, cy: number) => {
      const stage = stageRef.current;
      if (!stage) return null;
      const base = stage.getBoundingClientRect();
      const x = cx - base.left;
      const y = cy - base.top;
      const hit = shownPanes.find(
        (p) =>
          x >= p.rect.left &&
          x <= p.rect.left + p.rect.width &&
          y >= p.rect.top &&
          y <= p.rect.top + p.rect.height,
      );
      return hit ? { hit, x, y } : null;
    };

    const move = (ev: MouseEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        started = true;
        setDragging(true);
        setDragTermId(termId);
        document.body.classList.add("dragging-pane");
      }
      const at = paneAtClient(ev.clientX, ev.clientY);
      if (!at) {
        setHint(null);
        return;
      }
      const zone = zoneOf(at.hit.rect, at.x, at.y);
      // Dropping onto its OWN pane only splits, and only if a free tab can fill
      // the vacated side.
      if (at.hit.termId === termId && (zone === "center" || !fillTerm)) {
        setHint(null);
        return;
      }
      setHint({ rect: hintRect(at.hit.rect, zone), zone });
    };

    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging-pane");
      setDragging(false);
      setDragTermId(null);
      setHint(null);
      if (!started) return; // a plain click, not a drag
      const at = paneAtClient(ev.clientX, ev.clientY);
      if (!at) return;
      const zone = zoneOf(at.hit.rect, at.x, at.y);
      // Own pane → split, filling the vacated side with a free (unshown) tab.
      if (at.hit.termId === termId) {
        if (!fillTerm || zone === "center") return;
        if (zone === "left") onSplitWithTerm(at.hit.paneId, "row", false, fillTerm.id);
        else if (zone === "right") onSplitWithTerm(at.hit.paneId, "row", true, fillTerm.id);
        else if (zone === "top") onSplitWithTerm(at.hit.paneId, "col", false, fillTerm.id);
        else onSplitWithTerm(at.hit.paneId, "col", true, fillTerm.id);
        return;
      }
      // Another pane → dock the whole pane there (VS Code-style).
      onMovePane(paneId, at.hit.paneId, zone);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const ctx: SplitCtx = {
    focusedPaneId,
    termsById,
    statuses,
    onFocusPane,
    onSetRatio,
    onSplit,
    onClosePane,
    onCloseTerm,
    onRenameTerm,
    onPanePointerDown,
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
          <button
            className={`tool ${presetsOpen ? "tool-live" : ""}`}
            onClick={onTogglePresets}
            title="프리셋 패널 열기/닫기"
          >
            프리셋
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
          <NewTerminalMenu onCreate={onNewTerm} agent={agent} />
        </div>
      </header>

      {/* Only sessions not placed in any pane appear here — panes themselves are
          the tabs/handles now. The row vanishes when everything is on screen. */}
      {unshownTerminals.length > 0 && (
        <div className="tabs">
          <span className="tabs-label">대기 세션</span>
          {unshownTerminals.map((t) => (
            <div
              key={t.id}
              className="tab"
              title={`${t.title} — 클릭해서 패널에 열기, 드래그해서 배치`}
              draggable
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
              <span className="tab-title">{t.title}</span>
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
      )}

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
              {/* The real xterm (owned by TermPortals) docks in here while this
                  pane is shown; OS-file drop-to-attach lives on the terminal's
                  own wrapper, so it works on every dock surface. */}
              <TermSlot termId={t.id} slotKey={`pv-${project.id}`} priority={1} active={shown} />
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
