import { useState } from "react";
import { Preset, PresetBody } from "../../types";
import { presetBody, hasBody } from "../../lib/presets";
import "./presets.css";

type Draft = { name: string; kind: Preset["kind"]; desc: string; body: string };
const emptyDraft: Draft = { name: "", kind: "code", desc: "", body: "" };

/** lucide-style stroke icons — keeps the panel free of emoji. */
const svg = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const Wand = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" {...svg}>
    <path d="m3 21 9-9" />
    <path d="M15 4V2M15 10V8M8 9h2M20 9h2M17.8 6.2 19 5M12.2 6.2 11 5M17.8 11.8 19 13" />
  </svg>
);
const Pencil = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" {...svg}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const Trash = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" {...svg}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
const Play = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

/**
 * Manage presets. A preset's **name / kind / 설명(desc)** are GLOBAL — every
 * project shares them. The **실행될 내용(body)** is created per project: press the
 * wand to have AI inspect this project and fill it, or type it in the editor.
 * The create/edit form is hidden until requested so it never clutters the list.
 */
export default function PresetsPanel({
  presets,
  bodies,
  presetGen,
  onRun,
  onAddPreset,
  onUpdatePreset,
  onRemovePreset,
  onSetBody,
  onGenerate,
}: {
  presets: Preset[];
  bodies: Record<string, PresetBody>;
  presetGen: Record<string, boolean>;
  onRun: (presetId: string) => void;
  onAddPreset: (name: string, kind: Preset["kind"], description: string, body?: string) => void;
  onUpdatePreset: (presetId: string, patch: Partial<Omit<Preset, "id">>) => void;
  onRemovePreset: (presetId: string) => void;
  onSetBody: (presetId: string, body: PresetBody | null) => void;
  onGenerate: (presetId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState<Draft>(emptyDraft);
  const [flashId, setFlashId] = useState<string | null>(null);

  const open = adding || editingId !== null;
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const canSave = d.name.trim() !== "" && d.desc.trim() !== "";

  const close = () => {
    setEditingId(null);
    setAdding(false);
    setD(emptyDraft);
  };

  const startAdd = () => {
    setEditingId(null);
    setAdding(true);
    setD(emptyDraft);
  };

  const startEdit = (p: Preset) => {
    setAdding(false);
    setEditingId(p.id);
    setD({ name: p.name, kind: p.kind, desc: p.desc, body: presetBody(p, bodies[p.id]) });
  };

  const save = () => {
    if (!canSave) return;
    if (editingId) {
      onUpdatePreset(editingId, { name: d.name.trim(), kind: d.kind, desc: d.desc.trim() });
      const body = d.body.trim();
      onSetBody(editingId, body ? (d.kind === "code" ? { command: body } : { prompt: body }) : null);
    } else {
      onAddPreset(d.name.trim(), d.kind, d.desc.trim(), d.body.trim() || undefined);
    }
    close();
  };

  const run = (id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 420);
    onRun(id);
  };

  return (
    <div className="panel">
      <div className="preset-head">
        <div className="preset-head-title">
          프리셋
          <span className="preset-help" tabIndex={0}>
            ?
            <span className="preset-tip">
              이름·설명은 모든 프로젝트가 공유해요. <b>실행 내용</b>은 프로젝트마다 AI로 따로 만들어요.
              <span className="preset-tip-legend">
                <span>
                  <i className="dot code" />코드 — 셸 명령 단발 실행
                </span>
                <span>
                  <i className="dot ai" />AI — 현재 터미널로 프롬프트 전송
                </span>
              </span>
            </span>
          </span>
        </div>
        {!open && (
          <button className="preset-new" onClick={startAdd}>
            ＋ 새 프리셋
          </button>
        )}
      </div>

      {open && (
        <div className="form preset-form">
          <div className="preset-form-title">{editingId ? "프리셋 수정" : "새 프리셋"}</div>
          <div className="preset-kind-toggle">
            <button className={d.kind === "code" ? "on" : ""} onClick={() => set({ kind: "code" })}>
              코드
            </button>
            <button className={d.kind === "ai" ? "on" : ""} onClick={() => set({ kind: "ai" })}>
              AI
            </button>
          </div>
          <input
            placeholder="이름"
            value={d.name}
            autoFocus
            onChange={(e) => set({ name: e.target.value })}
          />
          <label className="preset-field-label">설명</label>
          <textarea
            placeholder={d.kind === "code" ? "예: 개발 서버를 켠다" : "예: 변경사항을 커밋하고 푸시한다"}
            rows={2}
            value={d.desc}
            onChange={(e) => set({ desc: e.target.value })}
          />
          <label className="preset-field-label">
            실행 내용 <span className="preset-opt">선택</span>
          </label>
          <textarea
            placeholder={d.kind === "code" ? "예: npm run dev" : "터미널로 보낼 프롬프트"}
            rows={2}
            value={d.body}
            onChange={(e) => set({ body: e.target.value })}
          />
          <div className="preset-form-actions">
            <button className="ghost" onClick={close}>
              취소
            </button>
            <button className="add" onClick={save} disabled={!canSave}>
              {editingId ? "저장" : "추가"}
            </button>
          </div>
        </div>
      )}

      <div className="rows">
        {presets.length === 0 && !open && (
          <div className="preset-empty">
            <p>아직 프리셋이 없어요.</p>
            <button className="preset-new" onClick={startAdd}>
              ＋ 첫 프리셋 만들기
            </button>
          </div>
        )}
        {presets.map((p) => {
          const gen = !!presetGen[p.id];
          const ready = hasBody(p, bodies[p.id]);
          return (
            <div className={`row preset-row ${editingId === p.id ? "on" : ""}`} key={p.id}>
              <button
                className={`preset-run ${flashId === p.id ? "flash" : ""}`}
                title={ready ? "클릭하면 실행" : "먼저 AI 생성으로 이 프로젝트용 내용을 만드세요"}
                onClick={() => run(p.id)}
              >
                <span className={`preset-tag ${p.kind}`}>{p.kind === "code" ? "코드" : "AI"}</span>
                <span className="row-main">
                  <strong>
                    {p.name}
                    <span className={`preset-badge ${ready ? "ok" : ""}`}>
                      {ready ? "준비됨" : "미생성"}
                    </span>
                  </strong>
                  <span className="row-sub">{p.desc || "(설명 없음)"}</span>
                  <span className="row-body">
                    {gen
                      ? "AI 생성 중…"
                      : ready
                        ? presetBody(p, bodies[p.id])
                        : "이 프로젝트용 실행 내용이 아직 없어요"}
                  </span>
                </span>
                <span className="preset-play">
                  <Play />
                </span>
              </button>
              <div className="preset-actions-col">
                <button
                  className="iconbtn gen"
                  title="이 프로젝트용 내용 AI 생성"
                  disabled={gen}
                  onClick={() => onGenerate(p.id)}
                >
                  {gen ? <span className="spin" /> : <Wand />}
                </button>
                <button className="iconbtn" title="이름·설명 수정 / 내용 직접 편집" onClick={() => startEdit(p)}>
                  <Pencil />
                </button>
                <button
                  className="iconbtn danger"
                  title="삭제"
                  onClick={() => {
                    onRemovePreset(p.id);
                    if (editingId === p.id) close();
                  }}
                >
                  <Trash />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
