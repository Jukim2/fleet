import { useEffect, useMemo, useRef, useState } from "react";
import { Preset, PresetOverride } from "../../types";
import { effectiveBody } from "../../lib/presets";
import "./blocks.css";
import "../presets/presets.css";

export default function CommandPalette({
  open,
  presets,
  overrides,
  onClose,
  onRun,
}: {
  open: boolean;
  presets: Preset[];
  overrides: Record<string, PresetOverride>;
  onClose: () => void;
  onRun: (presetId: string) => void;
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
      presets.filter(
        (p) =>
          p.name.toLowerCase().includes(q.toLowerCase()) ||
          effectiveBody(p, overrides[p.id]).toLowerCase().includes(q.toLowerCase()),
      ),
    [presets, overrides, q],
  );

  if (!open) return null;

  const run = (p: Preset | undefined) => {
    if (!p) return;
    onRun(p.id);
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
      run(filtered[sel]);
    }
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="프리셋 검색…  (Enter: 실행)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {presets.length === 0 && (
            <div className="palette-empty">아직 프리셋이 없어요. 프리셋 패널에서 추가하세요.</div>
          )}
          {presets.length > 0 && filtered.length === 0 && (
            <div className="palette-empty">일치하는 프리셋이 없어요.</div>
          )}
          {filtered.map((p, i) => (
            <div
              key={p.id}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(p)}
            >
              <span className="palette-name">
                <span className={`preset-tag ${p.kind}`}>{p.kind === "code" ? "코드" : "AI"}</span>
                {p.name}
              </span>
              <span className="palette-text">{effectiveBody(p, overrides[p.id])}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
