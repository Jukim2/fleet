import { useEffect, useMemo, useRef, useState } from "react";
import { Preset, PresetBody } from "../../types";
import { presetBody } from "../../lib/presets";
import { AttentionItem } from "../attention/AttentionPeek";
import "./blocks.css";
import "../presets/presets.css";

type Item =
  | { type: "preset"; key: string; presetId: string; name: string; kind: Preset["kind"]; sub: string }
  | { type: "jump"; key: string; projectId: string; termId: string; name: string; sub: string };

/**
 * ⌘K command palette. Two things you can do from anywhere:
 *  - run a preset in the active project, or
 *  - jump to any terminal in any project (cross-project navigation).
 */
export default function CommandPalette({
  open,
  presets,
  bodies,
  jumpItems,
  activeProjectId,
  onClose,
  onRun,
  onJump,
}: {
  open: boolean;
  presets: Preset[];
  bodies: Record<string, PresetBody>;
  jumpItems: AttentionItem[];
  activeProjectId: string | null;
  onClose: () => void;
  onRun: (presetId: string) => void;
  onJump: (projectId: string, termId: string) => void;
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

  const items = useMemo<Item[]>(() => {
    const presetItems: Item[] = presets.map((p) => ({
      type: "preset",
      key: `p:${p.id}`,
      presetId: p.id,
      name: p.name,
      kind: p.kind,
      sub: presetBody(p, bodies[p.id]) || p.desc || "(미생성)",
    }));
    // Terminals in OTHER projects first (that's the cross-project win), each's
    // live activity as the subtitle so you can pick the right one.
    const jump: Item[] = [...jumpItems]
      .sort((a, b) => Number(a.projectId === activeProjectId) - Number(b.projectId === activeProjectId))
      .map((it) => ({
        type: "jump",
        key: `t:${it.termId}`,
        projectId: it.projectId,
        termId: it.termId,
        name: `${it.projectName} · ${it.title}`,
        sub: it.activity || "",
      }));
    return [...presetItems, ...jump];
  }, [presets, bodies, jumpItems, activeProjectId]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return items;
    return items.filter(
      (it) => it.name.toLowerCase().includes(needle) || it.sub.toLowerCase().includes(needle),
    );
  }, [items, q]);

  if (!open) return null;

  const run = (it: Item | undefined) => {
    if (!it) return;
    if (it.type === "preset") onRun(it.presetId);
    else onJump(it.projectId, it.termId);
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
          placeholder="프리셋 실행 · 세션으로 이동…  (Enter)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">일치하는 항목이 없어요.</div>}
          {filtered.map((it, i) => (
            <div
              key={it.key}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
            >
              <span className="palette-name">
                {it.type === "preset" ? (
                  <span className={`preset-tag ${it.kind}`}>{it.kind === "code" ? "코드" : "AI"}</span>
                ) : (
                  <span className="preset-tag jump">이동</span>
                )}
                {it.name}
              </span>
              {it.sub && <span className="palette-text">{it.sub}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
