import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Block,
  Project,
  QueueBoard as Board,
  QueueTask,
  TaskStatus,
  Terminal,
  TermStatus,
} from "../../types";
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
  onClose,
  onAddLane,
  onRemoveLane,
  onAddTask,
  onRemoveTask,
  onSetDeps,
  onAddBlock,
  onToggleRunning,
  onReset,
}: {
  project: Project;
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  board: Board;
  taskStatus: Record<string, TaskStatus>;
  blocks: Block[];
  onClose: () => void;
  onAddLane: (termId: string) => void;
  onRemoveLane: (termId: string) => void;
  onAddTask: (termId: string, text: string) => void;
  onRemoveTask: (taskId: string) => void;
  onSetDeps: (taskId: string, deps: string[]) => void;
  onAddBlock: (text: string) => void;
  onToggleRunning: () => void;
  onReset: () => void;
}) {
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
    () => Object.fromEntries(board.lanes.map((l, i) => [l, i])),
    [board.lanes],
  );
  const available = terminals.filter((t) => !board.lanes.includes(t.id));
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
    const fromCol = laneIndex[tasksById[fromId]?.laneTermId] ?? 0;
    const toCol = laneIndex[tasksById[toId]?.laneTermId] ?? 0;
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
            <span className="qb-proj">{project.name}</span>
            {board.tasks.length > 0 && (
              <span className="qb-count">
                {done}/{board.tasks.length} 완료
              </span>
            )}
          </div>
          <div className="qb-actions">
            <button
              className={`qb-run ${board.running ? "on" : ""}`}
              onClick={onToggleRunning}
              disabled={board.tasks.length === 0}
            >
              {board.running ? "■ 정지" : "▶ 실행"}
            </button>
            <button className="qb-btn" onClick={onReset} disabled={done === 0 && !board.running}>
              초기화
            </button>
            <button className="qb-x" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
        </header>

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
            {board.lanes.map((termId) => {
              const term = termsById[termId];
              const laneTasks = board.tasks.filter((t) => t.laneTermId === termId);
              return (
                <Lane
                  key={termId}
                  title={term?.title ?? "(닫힌 터미널)"}
                  termStatus={statuses[termId] ?? "stopped"}
                  tasks={laneTasks}
                  taskStatus={taskStatus}
                  tasksById={tasksById}
                  termsById={termsById}
                  cardRefs={cardRefs}
                  blocks={blocks}
                  onAddTask={(text) => onAddTask(termId, text)}
                  onAddBlock={onAddBlock}
                  onRemoveTask={onRemoveTask}
                  onOpenPicker={(taskId, el) =>
                    setPicker((p) =>
                      p?.taskId === taskId ? null : { taskId, anchor: el.getBoundingClientRect() },
                    )
                  }
                  onRemoveLane={() => onRemoveLane(termId)}
                />
              );
            })}

            {available.length > 0 && (
              <div className="qb-addlane">
                <p className="qb-hint">＋ 레인 추가</p>
                {available.map((t) => (
                  <button key={t.id} className="qb-lanepick" onClick={() => onAddLane(t.id)}>
                    <span className={`qb-dot ${statuses[t.id] ?? "stopped"}`} />
                    {t.title}
                  </button>
                ))}
              </div>
            )}

            {board.lanes.length === 0 && available.length === 0 && (
              <p className="qb-hint">먼저 이 프로젝트에 터미널을 만들어 주세요.</p>
            )}
          </div>
        </div>
      </div>

      {picker && (
        <DepPicker
          state={picker}
          board={board}
          tasksById={tasksById}
          termsById={termsById}
          dependsOn={dependsOn}
          onToggle={(depId) => toggleDep(picker.taskId, depId)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** Floating dependency picker — portaled to <body> so it is never clipped by lane scroll. */
function DepPicker({
  state,
  board,
  tasksById,
  termsById,
  dependsOn,
  onToggle,
  onClose,
}: {
  state: PickerState;
  board: Board;
  tasksById: Record<string, QueueTask>;
  termsById: Record<string, Terminal>;
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
        {board.lanes.map((lt) => {
          const opts = others.filter((o) => o.laneTermId === lt);
          if (opts.length === 0) return null;
          return (
            <div key={lt} className="qb-pick-group">
              <div className="qb-pick-lane">{termsById[lt]?.title ?? "?"}</div>
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
  tasks,
  taskStatus,
  tasksById,
  termsById,
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
  tasks: QueueTask[];
  taskStatus: Record<string, TaskStatus>;
  tasksById: Record<string, QueueTask>;
  termsById: Record<string, Terminal>;
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
        <span className="qb-lane-n">{tasks.length}</span>
        <button className="qb-lane-x" onClick={onRemoveLane} title="레인 제거">
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
                    const lane = dt ? termsById[dt.laneTermId]?.title : "?";
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
