import { useEffect, useState } from "react";
import { TermStatus } from "../../types";
import { AttentionItem } from "../attention/AttentionPeek";
import "./overview.css";

export type OverviewGroup = {
  projectId: string;
  projectName: string;
  sessions: AttentionItem[];
  plan?: { done: number; total: number };
  boardRunning: boolean;
};

const STATUS_LABEL: Record<TermStatus, string> = {
  waiting: "승인",
  idle: "완료",
  busy: "실행",
  stopped: "종료",
};

/**
 * Global Overview — a summon-and-dismiss mode (not a resident panel) showing
 * every project's sessions grouped, with live status + activity + plan/board
 * progress. Built for the "10 sessions running, what's the state of everything"
 * scan. Click any row to jump straight to that session. Complements the quick
 * ⌘J peek: this is the deep scan, the peek is the fast triage.
 */
export default function OverviewPanel({
  open,
  groups,
  counts,
  onJump,
  onSelectProject,
  onClose,
}: {
  open: boolean;
  groups: OverviewGroup[];
  counts: { waiting: number; busy: number; idle: number };
  onJump: (projectId: string, termId: string) => void;
  onSelectProject: (projectId: string) => void;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (pid: string) => setCollapsed((c) => ({ ...c, [pid]: !c[pid] }));

  return (
    <div className="ov-overlay" onMouseDown={onClose}>
      <div className="ov" onMouseDown={(e) => e.stopPropagation()}>
        <header className="ov-head">
          <span className="ov-title">전체 현황</span>
          <div className="ov-counts">
            {counts.waiting > 0 && <span className="ov-chip waiting">승인 {counts.waiting}</span>}
            {counts.busy > 0 && <span className="ov-chip busy">실행 {counts.busy}</span>}
            {counts.idle > 0 && <span className="ov-chip idle">완료 {counts.idle}</span>}
            {counts.waiting + counts.busy + counts.idle === 0 && (
              <span className="ov-chip muted">살아있는 세션 없음</span>
            )}
          </div>
          <button className="ov-x" onClick={onClose} title="닫기 (Esc)">
            ✕
          </button>
        </header>

        <div className="ov-body">
          {groups.length === 0 && <div className="ov-empty">아직 프로젝트가 없어요.</div>}
          {groups.map((g) => {
            const off = !!collapsed[g.projectId];
            const live = g.sessions.filter((s) => s.status !== "stopped").length;
            return (
              <div className="ov-group" key={g.projectId}>
                <div className="ov-group-head">
                  <button className="ov-caret" onClick={() => toggle(g.projectId)}>
                    {off ? "▸" : "▾"}
                  </button>
                  <button
                    className="ov-proj"
                    onClick={() => {
                      onSelectProject(g.projectId);
                      onClose();
                    }}
                    title="이 프로젝트로 전환"
                  >
                    {g.projectName}
                  </button>
                  {live > 0 && <span className="ov-livecount">{live}</span>}
                  <span className="ov-spacer" />
                  {g.plan && g.plan.total > 0 && (
                    <span className="ov-plan" title={`플랜 ${g.plan.done}/${g.plan.total}`}>
                      <span className="ov-plan-bar">
                        <span
                          className="ov-plan-fill"
                          style={{ width: `${Math.round((g.plan.done / g.plan.total) * 100)}%` }}
                        />
                      </span>
                      {g.plan.done}/{g.plan.total}
                    </span>
                  )}
                  {g.boardRunning && <span className="ov-board" title="보드 실행 중">보드 ▶</span>}
                </div>

                {!off && (
                  <div className="ov-sessions">
                    {g.sessions.length === 0 && <div className="ov-none">열린 세션 없음</div>}
                    {g.sessions.map((s) => (
                      <button
                        className="ov-row"
                        key={s.termId}
                        onClick={() => {
                          onJump(s.projectId, s.termId);
                          onClose();
                        }}
                      >
                        <span className={`ov-status ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                        <span className="ov-name">{s.title}</span>
                        <span className="ov-activity">{s.activity || ""}</span>
                        <span className="ov-go">›</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
