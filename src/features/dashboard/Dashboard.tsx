import { useMemo } from "react";
import { Project, QueueBoard, QueueTask, TaskStatus, TermStatus } from "../../types";
import { laneLiveTerm } from "../../lib/board";
import "./dashboard.css";

// Live execution/progress view of a project's queue board, rendered as a
// dependency DAG (left→right by dep depth) with status coloring + a progress
// roll-up. Read-only over the same board data the queue uses — "one model, two
// views". Native SVG edges + HTML nodes, no external graph library.

const NODE_W = 176;
const NODE_H = 56;
const COL_GAP = 72;
const ROW_GAP = 22;

type NodeState = "done" | "running" | "ready" | "blocked";

function nodeState(t: QueueTask, taskStatus: Record<string, TaskStatus>): NodeState {
  const ts = taskStatus[t.id];
  if (ts === "done") return "done";
  if (ts === "running") return "running";
  return t.deps.every((d) => taskStatus[d] === "done") ? "ready" : "blocked";
}

const STATE_LABEL: Record<NodeState, string> = {
  done: "완료",
  running: "실행 중",
  ready: "대기",
  blocked: "의존 대기",
};

export default function Dashboard({
  project,
  board,
  taskStatus,
  statuses,
  onClose,
}: {
  project: Project;
  board: QueueBoard;
  taskStatus: Record<string, TaskStatus>;
  statuses: Record<string, TermStatus>;
  onClose: () => void;
}) {
  const tasks = board.tasks;
  const laneById = useMemo(() => Object.fromEntries(board.lanes.map((l) => [l.id, l])), [board.lanes]);

  // Dep depth = longest path from a root; columns group tasks by depth.
  const depth = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const cache = new Map<string, number>();
    const visiting = new Set<string>();
    const calc = (id: string): number => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      const deps = (byId.get(id)?.deps ?? []).filter((d) => byId.has(d));
      const d = deps.length ? 1 + Math.max(...deps.map(calc)) : 0;
      visiting.delete(id);
      cache.set(id, d);
      return d;
    };
    tasks.forEach((t) => calc(t.id));
    return cache;
  }, [tasks]);

  const { pos, width, height } = useMemo(() => {
    const rowOf: Record<number, number> = {};
    const pos: Record<string, { x: number; y: number }> = {};
    let maxRow = 0;
    let maxDepth = 0;
    for (const t of tasks) {
      const d = depth.get(t.id) ?? 0;
      const row = rowOf[d] ?? 0;
      rowOf[d] = row + 1;
      pos[t.id] = { x: d * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP) };
      maxRow = Math.max(maxRow, row + 1);
      maxDepth = Math.max(maxDepth, d);
    }
    return {
      pos,
      width: (maxDepth + 1) * NODE_W + maxDepth * COL_GAP,
      height: Math.max(1, maxRow) * (NODE_H + ROW_GAP),
    };
  }, [tasks, depth]);

  const edges = useMemo(() => {
    const out: { id: string; d: string }[] = [];
    for (const t of tasks) {
      const to = pos[t.id];
      if (!to) continue;
      for (const dep of t.deps) {
        const from = pos[dep];
        if (!from) continue;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        out.push({ id: `${dep}-${t.id}`, d: `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}` });
      }
    }
    return out;
  }, [tasks, pos]);

  const total = tasks.length;
  const done = tasks.filter((t) => taskStatus[t.id] === "done").length;
  const running = tasks.filter((t) => taskStatus[t.id] === "running").length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="dash-overlay" onMouseDown={onClose}>
      <div className="dash" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dash-head">
          <strong>{project.name} · 진행 대시보드</strong>
          <div className="dash-progress" title={`${done}/${total} 완료`}>
            <div className="dash-bar">
              <div className="dash-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="dash-pct">
              {done}/{total} · {pct}%{running ? ` · ${running} 실행중` : ""}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className="dash-canvas">
          {total === 0 ? (
            <div className="dash-empty">
              큐에 태스크가 없어요. 헤더의 <b>큐</b>에서 추가하면 여기서 흐름과 진행도가 보여요.
            </div>
          ) : (
            <div className="dash-graph" style={{ width, height }}>
              <svg className="dash-edges" width={width} height={height}>
                {edges.map((e) => (
                  <path key={e.id} d={e.d} className="dash-edge" />
                ))}
              </svg>
              {tasks.map((t) => {
                const p = pos[t.id];
                if (!p) return null;
                const state = nodeState(t, taskStatus);
                const lane = laneById[t.laneId];
                const liveTerm = lane ? laneLiveTerm(lane) : undefined;
                const liveStatus = liveTerm ? statuses[liveTerm] : undefined;
                return (
                  <div
                    key={t.id}
                    className={`dash-node ${state}`}
                    style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                    title={t.text}
                  >
                    <div className="dash-node-text">{t.text}</div>
                    <div className="dash-node-foot">
                      <span className="dash-lane">
                        <span className={`dash-dot ${liveStatus ?? "stopped"}`} />
                        {lane?.title ?? "트랙"}
                      </span>
                      <span className={`dash-state ${state}`}>{STATE_LABEL[state]}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
