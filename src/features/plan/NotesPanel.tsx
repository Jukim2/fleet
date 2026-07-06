import { useState } from "react";
import { Note } from "../../types";

/**
 * Left-panel memo list inside the Plan overlay. Jot down rough ideas, select
 * some, and hand them to the planner AI ("선택 메모로 플랜 구성") — it refines
 * them into theme→feature→step and merges into the graph. Added notes keep a
 * "✓ 추가됨" badge so you don't feed the same idea twice.
 */
export default function NotesPanel({
  notes,
  planning,
  onAdd,
  onEdit,
  onRemove,
  onPlanFromNotes,
}: {
  notes: Note[];
  planning: boolean;
  onAdd: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onPlanFromNotes: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);

  const add = () => {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  const toggle = (id: string) =>
    setSel((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const runPlan = () => {
    if (!sel.size || planning) return;
    onPlanFromNotes([...sel]);
    setSel(new Set());
  };

  return (
    <div className="plan-notes">
      <div className="plan-notes-add">
        <textarea
          className="plan-notes-in"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn" onClick={add} disabled={!draft.trim()}>
          ＋ 메모 추가
        </button>
      </div>

      <div className="plan-notes-list">
        {notes.length === 0
          ? null
          : notes.map((n) => (
            <div
              key={n.id}
              className={`plan-note-item ${sel.has(n.id) ? "sel" : ""} ${n.addedAt ? "added" : ""}`}
            >
              <button
                type="button"
                className={`plan-note-check ${sel.has(n.id) ? "on" : ""}`}
                onClick={() => toggle(n.id)}
                title={sel.has(n.id) ? "선택 해제" : "선택"}
                aria-pressed={sel.has(n.id)}
              >
                {sel.has(n.id) && "✓"}
              </button>
              {editingId === n.id ? (
                <textarea
                  className="plan-note-edit"
                  autoFocus
                  defaultValue={n.text}
                  onBlur={(e) => {
                    onEdit(n.id, e.target.value);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      (e.target as HTMLTextAreaElement).blur();
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <span
                  className="plan-note-text"
                  title="더블클릭해서 편집"
                  onDoubleClick={() => setEditingId(n.id)}
                  onClick={() => toggle(n.id)}
                >
                  {n.text}
                </span>
              )}
              {n.addedAt && (
                <span className="plan-note-badge" title="플랜에 이미 추가한 메모예요">
                  ✓ 추가됨
                </span>
              )}
              <button className="plan-note-del" title="메모 삭제" onClick={() => onRemove(n.id)}>
                ✕
              </button>
            </div>
            ))}
      </div>

      <div className="plan-notes-foot">
        <span className="plan-notes-selinfo">{sel.size}개 선택</span>
        <button className="btn primary" disabled={!sel.size || planning} onClick={runPlan}>
          {planning ? "구성 중…" : "선택 메모로 플랜 구성"}
        </button>
      </div>
    </div>
  );
}
