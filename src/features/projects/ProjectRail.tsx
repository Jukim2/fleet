import { useMemo, useState } from "react";
import { ClaudeSession, Project } from "../../types";
import "./projects.css";

function relTime(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

/** "claude-opus-4-8" → "Opus 4.8"; falls back to a trimmed id. */
function modelLabel(model?: string | null): string | null {
  if (!model) return null;
  const m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const fam = m.match(/(opus|sonnet|haiku)/i)?.[1];
  const ver = m.match(/(\d+)-(\d+)/);
  if (fam && ver) {
    return `${fam[0].toUpperCase()}${fam.slice(1).toLowerCase()} ${ver[1]}.${ver[2]}`;
  }
  return m;
}

export default function ProjectRail({
  projects,
  activeId,
  liveByProject,
  projectStatus,
  sessions,
  sessionsLoading,
  onSelect,
  onAdd,
  onRemove,
  onReorder,
  onRefreshSessions,
  onResume,
  onDeleteSession,
  openSessionTerm,
  onOpenSettings,
  onCollapse,
}: {
  projects: Project[];
  activeId: string | null;
  liveByProject: Record<string, number>;
  /** projectId → most attention-worthy live status (waiting > busy > idle) */
  projectStatus: Record<string, "busy" | "idle" | "waiting" | "stopped">;
  sessions: ClaudeSession[] | null;
  sessionsLoading: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onRefreshSessions: () => void;
  onResume: (s: ClaudeSession) => void;
  onDeleteSession: (s: ClaudeSession) => void;
  /** resume-session id → open terminal id, for the "이미 열림" marker */
  openSessionTerm: Record<string, string>;
  onOpenSettings: () => void;
  onCollapse: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!sessions) return null;
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.summary.toLowerCase().includes(q));
  }, [sessions, query]);
  return (
    <nav className="rail">
      <div className="rail-head">
        <span>Fleet</span>
        <div className="rail-head-btns">
          <button className="icon-btn" title="설정 · 진단" onClick={onOpenSettings}>
            ⚙
          </button>
          <button className="icon-btn" title="사이드바 접기" onClick={onCollapse}>
            ‹
          </button>
        </div>
      </div>

      <div className="rail-list">
        {projects.map((p) => (
          <div
            key={p.id}
            className={`rail-item ${p.id === activeId ? "active" : ""}`}
            draggable
            onClick={() => onSelect(p.id)}
            onDragStart={(e) => e.dataTransfer.setData("text/project", p.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/project");
              if (from && from !== p.id) onReorder(from, p.id);
            }}
          >
            <span className="folder">▸</span>
            <span className="rail-name" title={p.path}>
              {p.name}
            </span>
            {liveByProject[p.id] > 0 && (
              <span
                className={`rail-dot ${projectStatus[p.id] ?? "idle"}`}
                title={
                  projectStatus[p.id] === "waiting"
                    ? "승인 대기 중"
                    : projectStatus[p.id] === "busy"
                      ? "작업 중"
                      : "대기"
                }
              />
            )}
            <button
              className="rail-x"
              title="제거"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button className="rail-add" onClick={onAdd}>
        ＋ 폴더 추가
      </button>

      {activeId && (
        <div className="sessions">
          <div className="sessions-head">
            <span>
              이어갈 세션{sessions && sessions.length > 0 ? ` (${sessions.length})` : ""}
            </span>
            <button className="icon-btn" title="새로고침" onClick={onRefreshSessions}>
              ⟳
            </button>
          </div>
          {sessions && sessions.length > 0 && (
            <input
              className="session-search"
              type="text"
              placeholder="세션 검색…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="sessions-list">
            {sessionsLoading && !sessions && <div className="sessions-empty">불러오는 중…</div>}
            {!sessionsLoading && sessions && sessions.length === 0 && (
              <div className="sessions-empty">저장된 세션이 없어요.</div>
            )}
            {sessions && sessions.length > 0 && filtered && filtered.length === 0 && (
              <div className="sessions-empty">검색 결과가 없어요.</div>
            )}
            {filtered?.map((s) => {
              const open = !!openSessionTerm[s.id];
              const model = modelLabel(s.model);
              return (
                <button
                  key={s.id}
                  className={`session ${open ? "open" : ""}`}
                  onClick={() => onResume(s)}
                  title={open ? `${s.summary}\n(이미 열려 있어요 — 해당 탭으로 이동)` : s.summary}
                >
                  <span className="session-summary">{s.summary}</span>
                  <span className="session-meta">
                    {open && <span className="session-badge">열림</span>}
                    {model && <span className="session-model">{model}</span>}
                    <span className="session-time">{relTime(s.modified)}</span>
                    <span
                      className="session-x"
                      title="세션 삭제"
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm("이 세션 기록을 삭제할까요? 되돌릴 수 없어요.")) {
                          onDeleteSession(s);
                        }
                      }}
                    >
                      ✕
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
