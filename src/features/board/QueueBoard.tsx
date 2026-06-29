import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Block,
  LaneTarget,
  Project,
  QueueBoard as Board,
  QueueTask,
  TaskStatus,
  Terminal,
  TermStatus,
} from "../../types";
import { laneLiveTerm } from "../../lib/board";
import "./board.css";

type Rect = { x: number; y: number; w: number; h: number };
type PickerState = { taskId: string; anchor: DOMRect };

/** Fixed-position style for a popover anchored under (or above) a trigger rect. */
function popoverStyle(anchor: DOMRect, width: number): React.CSSProperties {
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
  const below = window.innerHeight - anchor.bottom;
  const openUp = below < 260 && anchor.top > below;
  const maxHeight = (openUp ? anchor.top : below) - 16;
  return openUp
    ? { left, bottom: window.innerHeight - anchor.top + 6, maxHeight, width }
    : { left, top: anchor.bottom + 6, maxHeight, width };
}

export default function QueueBoard({
  project,
  terminals,
  statuses,
  board,
  taskStatus,
  blocks,
  projects,
  boards,
  allTerminals,
  onClose,
  onAddLane,
  onRemoveLane,
  onAddTask,
  onRemoveTask,
  onSetDeps,
  onAddBlock,
  onToggleRunningProject,
  onResetProject,
  onOpenProject,
  onAddProject,
}: {
  project: Project;
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  board: Board;
  taskStatus: Record<string, TaskStatus>;
  blocks: Block[];
  projects: Project[];
  boards: Record<string, Board>;
  allTerminals: Terminal[];
  onClose: () => void;
  onAddLane: (target: LaneTarget, title: string) => void;
  onRemoveLane: (laneId: string) => void;
  onAddTask: (laneId: string, text: string) => void;
  onRemoveTask: (taskId: string) => void;
  onSetDeps: (taskId: string, deps: string[]) => void;
  onAddBlock: (text: string) => void;
  onToggleRunningProject: (projectId: string) => void;
  onResetProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
  onAddProject: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"project" | "overview">("project");
  const bodyRef = useRef<HTMLDivElement>(null); // non-scrolling overlay parent (arrow origin)
  const scrollRef = useRef<HTMLDivElement>(null); // the horizontally-scrolling lane strip
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [picker, setPicker] = useState<PickerState | null>(null);

  const termsById = useMemo(() => Object.fromEntries(terminals.map((t) => [t.id, t])), [terminals]);
  const tasksById = useMemo(
    () => Object.fromEntries(board.tasks.map((t) => [t.id, t])),
    [board.tasks],
  );
  const laneIndex = useMemo(
    () => Object.fromEntries(board.lanes.map((l, i) => [l.id, i])),
    [board.lanes],
  );
  /** lane id → display title (lane's own title, falling back to its terminal). */
  const laneTitleById = useMemo(
    () =>
      Object.fromEntries(
        board.lanes.map((l) => [l.id, l.title || termsById[laneLiveTerm(l) ?? ""]?.title || "트랙"]),
      ),
    [board.lanes, termsById],
  );
  // Terminals not already bound to a session lane (offer them as new lanes).
  const usedTerm = new Set(
    board.lanes.flatMap((l) => (l.target.kind === "session" ? [l.target.termId] : [])),
  );
  const available = terminals.filter((t) => !usedTerm.has(t.id));
  const done = board.tasks.filter((t) => taskStatus[t.id] === "done").length;

  // does task `a` (transitively) depend on task `b`? — used to forbid dependency cycles
  const dependsOn = (aId: string, bId: string, seen = new Set<string>()): boolean => {
    const a = tasksById[aId];
    if (!a) return false;
    for (const d of a.deps) {
      if (d === bId) return true;
      if (!seen.has(d)) {
        seen.add(d);
        if (dependsOn(d, bId, seen)) return true;
      }
    }
    return false;
  };

  // Measure card boxes relative to the (non-scrolling) body so dep arrows stay
  // aligned with the SVG overlay even while the lane strip scrolls.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scroller = scrollRef.current;
    if (!body || !scroller) return;
    const measure = () => {
      const base = body.getBoundingClientRect();
      const next: Record<string, Rect> = {};
      for (const [id, el] of Object.entries(cardRefs.current)) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        next[id] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      }
      setRects(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    scroller.querySelectorAll("[data-card]").forEach((el) => ro.observe(el));
    scroller.addEventListener("scroll", measure);
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, [board.tasks, board.lanes, taskStatus]);

  const pathFor = (fromId: string, toId: string): string | null => {
    const a = rects[fromId];
    const b = rects[toId];
    if (!a || !b) return null;
    const fromCol = laneIndex[tasksById[fromId]?.laneId] ?? 0;
    const toCol = laneIndex[tasksById[toId]?.laneId] ?? 0;
    let x1: number, x2: number;
    if (toCol > fromCol) {
      x1 = a.x + a.w;
      x2 = b.x;
    } else if (toCol < fromCol) {
      x1 = a.x;
      x2 = b.x + b.w;
    } else {
      x1 = a.x + a.w;
      x2 = b.x + b.w;
    }
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    if (toCol === fromCol)
      return `M ${x1} ${y1} C ${x1 + 52} ${y1}, ${x2 + 52} ${y2}, ${x2} ${y2}`;
    const dir = toCol > fromCol ? 1 : -1;
    const dx = Math.max(34, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dir * dx} ${y1}, ${x2 - dir * dx} ${y2}, ${x2} ${y2}`;
  };

  const edges = board.tasks.flatMap((t) =>
    t.deps.filter((d) => tasksById[d]).map((d) => ({ key: `${d}->${t.id}`, from: d, to: t.id })),
  );

  const toggleDep = (taskId: string, depId: string) => {
    const cur = tasksById[taskId]?.deps ?? [];
    onSetDeps(taskId, cur.includes(depId) ? cur.filter((d) => d !== depId) : [...cur, depId]);
  };

  return (
    <div className="qb-overlay" onMouseDown={onClose}>
      <div className="qb" onMouseDown={(e) => e.stopPropagation()}>
        <header className="qb-head">
          <div className="qb-title">
            <strong>큐 보드</strong>
            <div className="qb-modes">
              <button className={mode === "project" ? "on" : ""} onClick={() => setMode("project")}>
                이 프로젝트
              </button>
              <button
                className={mode === "overview" ? "on" : ""}
                onClick={() => setMode("overview")}
              >
                전체
              </button>
            </div>
            {mode === "project" && <span className="qb-proj">{project.name}</span>}
            {mode === "project" && board.tasks.length > 0 && (
              <span className="qb-count">
                {done}/{board.tasks.length} 완료
              </span>
            )}
          </div>
          <div className="qb-actions">
            {mode === "project" && (
              <>
                <button
                  className={`qb-run ${board.running ? "on" : ""}`}
                  onClick={() => onToggleRunningProject(project.id)}
                  disabled={board.tasks.length === 0}
                >
                  {board.running ? "■ 정지" : "▶ 실행"}
                </button>
                <button
                  className="qb-btn"
                  onClick={() => onResetProject(project.id)}
                  disabled={done === 0 && !board.running}
                >
                  초기화
                </button>
              </>
            )}
            <button className="qb-x" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
        </header>

        {mode === "overview" ? (
          <Overview
            projects={projects}
            boards={boards}
            terminals={allTerminals}
            taskStatus={taskStatus}
            onToggleRunning={onToggleRunningProject}
            onReset={onResetProject}
            onOpen={(pid) => {
              onOpenProject(pid);
              setMode("project");
            }}
            onAddProject={async () => {
              if (await onAddProject()) setMode("project"); // new project becomes active → enter it
            }}
          />
        ) : (
          <div className="qb-body" ref={bodyRef}>
          <svg className="qb-arrows">
            <defs>
              <marker
                id="qb-arrowhead"
                markerWidth="9"
                markerHeight="9"
                refX="7"
                refY="4.5"
                orient="auto"
              >
                <path d="M1,1 L8,4.5 L1,8 Z" fill="var(--accent)" />
              </marker>
            </defs>
            {edges.map((e) => {
              const d = pathFor(e.from, e.to);
              return d ? (
                <path key={e.key} d={d} className="qb-edge" markerEnd="url(#qb-arrowhead)" />
              ) : null;
            })}
          </svg>

          <div className="qb-lanes" ref={scrollRef}>
            {board.lanes.map((lane) => {
              const liveTerm = laneLiveTerm(lane);
              const laneTasks = board.tasks.filter((t) => t.laneId === lane.id);
              const spawn = lane.target.kind === "spawn" && !lane.boundTermId;
              return (
                <Lane
                  key={lane.id}
                  title={laneTitleById[lane.id]}
                  termStatus={liveTerm ? statuses[liveTerm] ?? "stopped" : "stopped"}
                  pending={spawn}
                  tasks={laneTasks}
                  taskStatus={taskStatus}
                  tasksById={tasksById}
                  laneTitleById={laneTitleById}
                  cardRefs={cardRefs}
                  blocks={blocks}
                  onAddTask={(text) => onAddTask(lane.id, text)}
                  onAddBlock={onAddBlock}
                  onRemoveTask={onRemoveTask}
                  onOpenPicker={(taskId, el) =>
                    setPicker((p) =>
                      p?.taskId === taskId ? null : { taskId, anchor: el.getBoundingClientRect() },
                    )
                  }
                  onRemoveLane={() => onRemoveLane(lane.id)}
                />
              );
            })}

            <div className="qb-addlane">
              <p className="qb-hint">＋ 트랙 추가</p>
              <button
                className="qb-lanepick"
                onClick={() => onAddLane({ kind: "spawn", startup: "claude" }, "Claude")}
              >
                ◇ 새 Claude 세션
              </button>
              <button
                className="qb-lanepick"
                onClick={() => onAddLane({ kind: "spawn", startup: "" }, "셸")}
              >
                › 새 셸
              </button>
              {available.map((t) => (
                <button
                  key={t.id}
                  className="qb-lanepick"
                  onClick={() => onAddLane({ kind: "session", termId: t.id }, t.title)}
                >
                  <span className={`qb-dot ${statuses[t.id] ?? "stopped"}`} />
                  {t.title}
                </button>
              ))}
            </div>
          </div>
        </div>
        )}
      </div>

      {picker && (
        <DepPicker
          state={picker}
          board={board}
          tasksById={tasksById}
          laneTitleById={laneTitleById}
          dependsOn={dependsOn}
          onToggle={(depId) => toggleDep(picker.taskId, depId)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** All-projects monitor: per-project progress, running state, and lane breakdown. */
function Overview({
  projects,
  boards,
  terminals,
  taskStatus,
  onToggleRunning,
  onReset,
  onOpen,
  onAddProject,
}: {
  projects: Project[];
  boards: Record<string, Board>;
  terminals: Terminal[];
  taskStatus: Record<string, TaskStatus>;
  onToggleRunning: (projectId: string) => void;
  onReset: (projectId: string) => void;
  onOpen: (projectId: string) => void;
  onAddProject: () => void;
}) {
  const termsById = useMemo(() => Object.fromEntries(terminals.map((t) => [t.id, t])), [terminals]);

  return (
    <div className="qb-overview">
      {projects.map((p) => {
        const board = boards[p.id] ?? { running: false, lanes: [], tasks: [] };
        const total = board.tasks.length;
        const done = board.tasks.filter((t) => taskStatus[t.id] === "done").length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const allDone = total > 0 && done === total;
        return (
          <div key={p.id} className="qb-ov-card">
            <div className="qb-ov-top">
              <strong className="qb-ov-name" title={p.path}>
                {p.name}
              </strong>
              {board.running ? (
                <span className="qb-ov-badge run">실행중</span>
              ) : allDone ? (
                <span className="qb-ov-badge done">완료</span>
              ) : null}
              {total > 0 && (
                <span className="qb-ov-count">
                  {done}/{total}
                </span>
              )}
            </div>

            {total > 0 ? (
              <>
                <div className="qb-ov-bar">
                  <div
                    className={`qb-ov-fill ${allDone ? "done" : ""}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="qb-ov-lanes">
                  {board.lanes.map((lane) => {
                    const laneTasks = board.tasks.filter((t) => t.laneId === lane.id);
                    if (laneTasks.length === 0) return null;
                    const running = laneTasks.find((t) => taskStatus[t.id] === "running");
                    const ld = laneTasks.filter((t) => taskStatus[t.id] === "done").length;
                    const state = running ? "running" : ld === laneTasks.length ? "done" : "pending";
                    const name = lane.title || termsById[laneLiveTerm(lane) ?? ""]?.title || "트랙";
                    return (
                      <div key={lane.id} className="qb-ov-lane">
                        <span className={`qb-tstat ${state}`} />
                        <span className="qb-ov-lname">{name}</span>
                        <span className="qb-ov-ltask">
                          {running ? running.text : `${ld}/${laneTasks.length}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="qb-ov-empty">큐 없음 — 열어서 작업을 추가하세요.</p>
            )}

            <div className="qb-ov-actions">
              {total > 0 && (
                <>
                  <button
                    className={`qb-run ${board.running ? "on" : ""}`}
                    onClick={() => onToggleRunning(p.id)}
                  >
                    {board.running ? "■ 정지" : "▶ 실행"}
                  </button>
                  <button
                    className="qb-btn"
                    onClick={() => onReset(p.id)}
                    disabled={done === 0 && !board.running}
                  >
                    초기화
                  </button>
                </>
              )}
              <button className="qb-btn" onClick={() => onOpen(p.id)}>
                열기 →
              </button>
            </div>
          </div>
        );
      })}

      <button className="qb-ov-add" onClick={onAddProject}>
        <span className="qb-ov-add-plus">＋</span>
        새 프로젝트
      </button>
    </div>
  );
}

/** Floating dependency picker — portaled to <body> so it is never clipped by lane scroll. */
function DepPicker({
  state,
  board,
  tasksById,
  laneTitleById,
  dependsOn,
  onToggle,
  onClose,
}: {
  state: PickerState;
  board: Board;
  tasksById: Record<string, QueueTask>;
  laneTitleById: Record<string, string>;
  dependsOn: (a: string, b: string) => boolean;
  onToggle: (depId: string) => void;
  onClose: () => void;
}) {
  const { taskId, anchor } = state;
  const task = tasksById[taskId];
  const others = board.tasks.filter((o) => o.id !== taskId);

  return createPortal(
    <>
      <div
        className="qb-pick-catch"
        onMouseDown={(e) => {
          e.stopPropagation(); // portal events bubble the React tree → don't close the board
          onClose();
        }}
      />
      <div
        className="qb-pick"
        style={popoverStyle(anchor, 300)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="qb-pick-head">선행 작업 선택 — 먼저 끝나야 시작</div>
        {others.length === 0 && <div className="qb-pick-empty">다른 작업이 없습니다.</div>}
        {board.lanes.map((lane) => {
          const opts = others.filter((o) => o.laneId === lane.id);
          if (opts.length === 0) return null;
          return (
            <div key={lane.id} className="qb-pick-group">
              <div className="qb-pick-lane">{laneTitleById[lane.id]}</div>
              {opts.map((o) => {
                const checked = task?.deps.includes(o.id) ?? false;
                const cyclic = !checked && dependsOn(o.id, taskId);
                return (
                  <button
                    key={o.id}
                    className={`qb-pick-item ${checked ? "on" : ""}`}
                    disabled={cyclic}
                    title={cyclic ? "순환 의존이 되어 선택 불가" : o.text}
                    onClick={() => onToggle(o.id)}
                  >
                    <span className="qb-pick-box">{checked ? "✓" : ""}</span>
                    <span className="qb-pick-text">{o.text}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>,
    document.body,
  );
}

function Lane({
  title,
  termStatus,
  pending,
  tasks,
  taskStatus,
  tasksById,
  laneTitleById,
  cardRefs,
  blocks,
  onAddTask,
  onAddBlock,
  onRemoveTask,
  onOpenPicker,
  onRemoveLane,
}: {
  title: string;
  termStatus: TermStatus;
  pending: boolean;
  tasks: QueueTask[];
  taskStatus: Record<string, TaskStatus>;
  tasksById: Record<string, QueueTask>;
  laneTitleById: Record<string, string>;
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  blocks: Block[];
  onAddTask: (text: string) => void;
  onAddBlock: (text: string) => void;
  onRemoveTask: (taskId: string) => void;
  onOpenPicker: (taskId: string, el: HTMLElement) => void;
  onRemoveLane: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [blockMenu, setBlockMenu] = useState<DOMRect | null>(null);
  const add = () => {
    if (!draft.trim()) return;
    onAddTask(draft.trim());
    setDraft("");
  };

  return (
    <div className="qb-lane">
      <div className="qb-lane-head">
        <span className={`qb-dot ${termStatus}`} />
        <span className="qb-lane-title" title={title}>
          {title}
        </span>
        {pending && <span className="qb-lane-tag">실행 시 생성</span>}
        <span className="qb-lane-n">{tasks.length}</span>
        <button className="qb-lane-x" onClick={onRemoveLane} title="트랙 제거">
          ✕
        </button>
      </div>

      <div className="qb-cards">
        {tasks.length === 0 && <p className="qb-empty">작업 없음</p>}
        {tasks.map((t, i) => {
          const st = taskStatus[t.id]; // undefined | running | done
          return (
            <div
              key={t.id}
              data-card
              ref={(el) => {
                cardRefs.current[t.id] = el;
              }}
              className={`qb-card ${st ?? "pending"}`}
            >
              <div className="qb-card-top">
                <span className={`qb-tstat ${st ?? "pending"}`} />
                <span className="qb-card-i">{i + 1}</span>
                <button className="qb-card-x" onClick={() => onRemoveTask(t.id)} title="작업 삭제">
                  ✕
                </button>
              </div>
              <div className="qb-card-text">{t.text}</div>

              {t.deps.length > 0 && (
                <div className="qb-deps">
                  {t.deps.map((d) => {
                    const dt = tasksById[d];
                    const lane = dt ? laneTitleById[dt.laneId] : "?";
                    return (
                      <span key={d} className="qb-chip" title={dt?.text}>
                        ← {lane}: {dt ? dt.text.slice(0, 16) : "(삭제됨)"}
                      </span>
                    );
                  })}
                </div>
              )}

              <div className="qb-card-actions">
                <button
                  className={`qb-dep-btn ${t.deps.length ? "has" : ""}`}
                  onClick={(e) => onOpenPicker(t.id, e.currentTarget)}
                >
                  선행 {t.deps.length > 0 ? t.deps.length : "…"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="qb-add">
        <button
          className="qb-add-block"
          title="블럭에서 추가 / 저장"
          onClick={(e) =>
            setBlockMenu((m) => (m ? null : e.currentTarget.getBoundingClientRect()))
          }
        >
          블럭
        </button>
        <input
          placeholder="작업 추가…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add} disabled={!draft.trim()}>
          ＋
        </button>
      </div>

      {blockMenu && (
        <BlockMenu
          anchor={blockMenu}
          blocks={blocks}
          draft={draft.trim()}
          onPick={(text) => {
            onAddTask(text);
            setBlockMenu(null);
          }}
          onSaveDraft={() => {
            if (draft.trim()) onAddBlock(draft.trim());
            setBlockMenu(null);
          }}
          onClose={() => setBlockMenu(null)}
        />
      )}
    </div>
  );
}

/** Floating block menu — pick a saved block as a task, or save the input as a new block. */
function BlockMenu({
  anchor,
  blocks,
  draft,
  onPick,
  onSaveDraft,
  onClose,
}: {
  anchor: DOMRect;
  blocks: Block[];
  draft: string;
  onPick: (text: string) => void;
  onSaveDraft: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <>
      <div
        className="qb-pick-catch"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        className="qb-pick"
        style={popoverStyle(anchor, 280)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="qb-pick-head">블럭</div>
        {draft && (
          <button className="qb-pick-item save" onClick={onSaveDraft} title={draft}>
            <span className="qb-pick-box">＋</span>
            <span className="qb-pick-text">‘{draft.slice(0, 20)}’ 블럭으로 저장</span>
          </button>
        )}
        {blocks.length === 0 ? (
          <div className="qb-pick-empty">
            저장된 블럭이 없어요. 입력 후 ‘블럭으로 저장’ 하세요.
          </div>
        ) : (
          blocks.map((b) => (
            <button key={b.id} className="qb-pick-item" onClick={() => onPick(b.text)} title={b.text}>
              <span className="qb-pick-text">{b.name}</span>
            </button>
          ))
        )}
      </div>
    </>,
    document.body,
  );
}
