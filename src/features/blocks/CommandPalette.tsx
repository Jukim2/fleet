import { useEffect, useMemo, useRef, useState } from "react";
import { Block } from "../../types";
import "./blocks.css";

export default function CommandPalette({
  open,
  blocks,
  hasTarget,
  onClose,
  onSend,
  onBroadcast,
}: {
  open: boolean;
  blocks: Block[];
  hasTarget: boolean;
  onClose: () => void;
  onSend: (b: Block) => void;
  onBroadcast: (b: Block) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = useMemo(
    () =>
      blocks.filter(
        (b) =>
          b.name.toLowerCase().includes(q.toLowerCase()) ||
          b.text.toLowerCase().includes(q.toLowerCase()),
      ),
    [blocks, q],
  );

  if (!open) return null;

  const run = (b: Block | undefined, broadcast: boolean) => {
    if (!b) return;
    if (broadcast) onBroadcast(b);
    else onSend(b);
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
      run(filtered[sel], e.shiftKey);
    }
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="블럭 검색…  (Enter: 현재 터미널, Shift+Enter: 전체 전송)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {blocks.length === 0 && (
            <div className="palette-empty">저장된 블럭이 없어요. 우측 드로어에서 추가하세요.</div>
          )}
          {blocks.length > 0 && filtered.length === 0 && (
            <div className="palette-empty">일치하는 블럭이 없어요.</div>
          )}
          {filtered.map((b, i) => (
            <div
              key={b.id}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={(e) => run(b, e.shiftKey)}
            >
              <span className="palette-name">{b.name}</span>
              <span className="palette-text">{b.text}</span>
            </div>
          ))}
        </div>
        {!hasTarget && <div className="palette-foot">전송할 터미널이 없어요 (전체 전송만 가능)</div>}
      </div>
    </div>
  );
}
