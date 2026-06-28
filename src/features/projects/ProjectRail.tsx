import { ClaudeSession, Project } from "../../types";
import "./projects.css";

function relTime(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

export default function ProjectRail({
  projects,
  activeId,
  liveByProject,
  sessions,
  sessionsLoading,
  onSelect,
  onAdd,
  onRemove,
  onReorder,
  onRefreshSessions,
  onResume,
}: {
  projects: Project[];
  activeId: string | null;
  liveByProject: Record<string, number>;
  sessions: ClaudeSession[] | null;
  sessionsLoading: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onRefreshSessions: () => void;
  onResume: (s: ClaudeSession) => void;
}) {
  return (
    <nav className="rail">
      <div className="rail-head">Fleet</div>

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
            {liveByProject[p.id] > 0 && <span className="rail-dot" />}
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
            <span>이어갈 세션</span>
            <button className="icon-btn" title="새로고침" onClick={onRefreshSessions}>
              ⟳
            </button>
          </div>
          <div className="sessions-list">
            {sessionsLoading && <div className="sessions-empty">불러오는 중…</div>}
            {!sessionsLoading && sessions && sessions.length === 0 && (
              <div className="sessions-empty">저장된 세션이 없어요.</div>
            )}
            {!sessionsLoading &&
              sessions?.map((s) => (
                <button key={s.id} className="session" onClick={() => onResume(s)} title={s.summary}>
                  <span className="session-summary">{s.summary}</span>
                  <span className="session-time">{relTime(s.modified)}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </nav>
  );
}
