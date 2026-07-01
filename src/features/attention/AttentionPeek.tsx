import { useEffect, useMemo, useRef, useState } from "react";
import { TermStatus } from "../../types";
import "./attention.css";

export type AttentionItem = {
  projectId: string;
  projectName: string;
  termId: string;
  title: string;
  status: TermStatus;
  activity?: string;
};

const STATUS_LABEL: Record<TermStatus, string> = {
  waiting: "승인 필요",
  idle: "완료 · 대기",
  busy: "실행 중",
  stopped: "종료됨",
};

/**
 * ⌘J triage overlay: every live Claude session across ALL projects, sorted so
 * the ones needing you (permission prompts, then just-finished) float to the top.
 * Pick one to jump straight to it — the core loop of running many at once.
 */
export default function AttentionPeek({
  open,
  items,
  onJump,
  onClose,
}: {
  open: boolean;
  items: AttentionItem[];
  onJump: (projectId: string, termId: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return items.filter(
      (it) =>
        !needle ||
        it.projectName.toLowerCase().includes(needle) ||
        it.title.toLowerCase().includes(needle) ||
        (it.activity ?? "").toLowerCase().includes(needle),
    );
  }, [items, q]);

  if (!open) return null;

  const go = (it: AttentionItem | undefined) => {
    if (!it) return;
    onJump(it.projectId, it.termId);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(filtered[sel]);
    }
  };

  const waiting = items.filter((i) => i.status === "waiting").length;

  return (
    <div className="peek-overlay" onMouseDown={onClose}>
      <div className="peek" onMouseDown={(e) => e.stopPropagation()}>
        <div className="peek-head">
          <span className="peek-title">세션 현황</span>
          {waiting > 0 && <span className="peek-badge">승인 대기 {waiting}</span>}
        </div>
        <input
          ref={inputRef}
          className="peek-input"
          placeholder="프로젝트 · 세션 검색…  (↑↓ 이동 · Enter 점프)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        <div className="peek-list">
          {items.length === 0 && (
            <div className="peek-empty">지금 살아있는 세션이 없어요.</div>
          )}
          {items.length > 0 && filtered.length === 0 && (
            <div className="peek-empty">일치하는 세션이 없어요.</div>
          )}
          {filtered.map((it, i) => (
            <div
              key={it.termId}
              className={`peek-item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(it)}
            >
              <span className={`peek-status ${it.status}`}>{STATUS_LABEL[it.status]}</span>
              <span className="peek-main">
                <span className="peek-where">
                  <b>{it.projectName}</b>
                  <span className="peek-sep">·</span>
                  {it.title}
                </span>
                {it.activity && <span className="peek-activity">{it.activity}</span>}
              </span>
              <span className="peek-go">›</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
