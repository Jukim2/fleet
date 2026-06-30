import { useState } from "react";
import { Preset, PresetOverride } from "../../types";
import { effectiveBody, isOverridden } from "../../lib/presets";
import "./presets.css";

type Draft = { name: string; kind: Preset["kind"]; def: string; override: string };
const emptyDraft: Draft = { name: "", kind: "code", def: "", override: "" };

/**
 * Manage GLOBAL presets (visible in every project) plus this project's
 * behavior overrides. Three things per preset: name + kind (global), the default
 * body (global), and an optional per-project body override. AI can generate a
 * project-tuned body in one shot.
 */
export default function PresetsPanel({
  projectName,
  presets,
  overrides,
  presetGen,
  onRun,
  onSetPresets,
  onSetOverride,
  onAiCreate,
  onRefill,
}: {
  projectName?: string;
  presets: Preset[];
  overrides: Record<string, PresetOverride>;
  presetGen: Record<string, boolean>;
  onRun: (presetId: string) => void;
  onSetPresets: (p: Preset[]) => void;
  onSetOverride: (presetId: string, ov: PresetOverride | null) => void;
  onAiCreate: (name: string, kind: Preset["kind"], description: string) => void;
  onRefill: (presetId: string) => void;
}) {
  const [mode, setMode] = useState<"manual" | "ai">("manual");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [d, setD] = useState<Draft>(emptyDraft);
  const [flashId, setFlashId] = useState<string | null>(null);
  // AI-create form
  const [aiName, setAiName] = useState("");
  const [aiKind, setAiKind] = useState<Preset["kind"]>("code");
  const [aiDesc, setAiDesc] = useState("");

  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const canSave = d.name.trim() !== "" && (d.def.trim() !== "" || d.override.trim() !== "");

  const reset = () => {
    setEditingId(null);
    setD(emptyDraft);
  };

  const startEdit = (p: Preset) => {
    setMode("manual");
    setEditingId(p.id);
    const ov = overrides[p.id];
    setD({
      name: p.name,
      kind: p.kind,
      def: (p.kind === "code" ? p.command : p.prompt) ?? "",
      override: (p.kind === "code" ? ov?.command : ov?.prompt) ?? "",
    });
  };

  const save = () => {
    if (!canSave) return;
    const id = editingId ?? crypto.randomUUID();
    const def = d.def.trim();
    const next: Preset = {
      id,
      name: d.name.trim(),
      kind: d.kind,
      ...(d.kind === "code" ? { command: def } : { prompt: def }),
      // keep the AI description if this preset already had one
      desc: presets.find((p) => p.id === id)?.desc,
    };
    onSetPresets(editingId ? presets.map((p) => (p.id === editingId ? next : p)) : [...presets, next]);
    const ovBody = d.override.trim();
    onSetOverride(id, ovBody ? (d.kind === "code" ? { command: ovBody } : { prompt: ovBody }) : null);
    reset();
  };

  const remove = (id: string) => {
    onSetPresets(presets.filter((p) => p.id !== id));
    if (editingId === id) reset();
  };

  const run = (id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 420);
    onRun(id);
  };

  const submitAi = () => {
    if (!aiDesc.trim()) return;
    onAiCreate(aiName, aiKind, aiDesc);
    setAiName("");
    setAiDesc("");
  };

  return (
    <div className="panel">
      <p className="hint">
        전역 프리셋 — 모든 프로젝트에 보여요. {projectName ? <b>{projectName}</b> : "각 프로젝트"}에서
        명령을 덮어쓸 수 있어요.
        <br />
        <span className="muted">코드 = 셸 명령 단발 실행 · AI = 현재 터미널로 프롬프트 전송</span>
      </p>

      <div className="rows">
        {presets.length === 0 && <div className="empty">아직 프리셋이 없어요.</div>}
        {presets.map((p) => {
          const overridden = isOverridden(p, overrides[p.id]);
          const gen = !!presetGen[p.id];
          return (
            <div className={`row preset-row ${editingId === p.id ? "on" : ""}`} key={p.id}>
              <button
                className={`preset-run ${flashId === p.id ? "flash" : ""}`}
                title="클릭하면 실행"
                onClick={() => run(p.id)}
              >
                <span className={`preset-tag ${p.kind}`}>{p.kind === "code" ? "코드" : "AI"}</span>
                <span className="row-main">
                  <strong>
                    {p.name}
                    {overridden && <span className="preset-badge">이 프로젝트 전용</span>}
                  </strong>
                  <span className="row-sub">
                    {gen ? "AI 생성 중…" : effectiveBody(p, overrides[p.id]) || "(명령 비어 있음)"}
                  </span>
                </span>
                <span className="preset-play">▶</span>
              </button>
              <button
                className="iconbtn"
                title="이 프로젝트용으로 AI 채우기"
                disabled={gen}
                onClick={() => onRefill(p.id)}
              >
                {gen ? "…" : "✨"}
              </button>
              <button className="iconbtn" title="수정" onClick={() => startEdit(p)}>
                ✎
              </button>
              <button className="iconbtn" title="삭제" onClick={() => remove(p.id)}>
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="preset-mode-toggle">
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
          직접 추가
        </button>
        <button
          className={mode === "ai" ? "on" : ""}
          onClick={() => {
            setMode("ai");
            reset();
          }}
        >
          ✨ AI 생성
        </button>
      </div>

      {mode === "manual" ? (
        <div className="form">
          <div className="preset-kind-toggle">
            <button className={d.kind === "code" ? "on" : ""} onClick={() => set({ kind: "code" })}>
              코드
            </button>
            <button className={d.kind === "ai" ? "on" : ""} onClick={() => set({ kind: "ai" })}>
              AI
            </button>
          </div>
          <input
            placeholder="이름 (예: 개발 서버 켜기)"
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <label className="preset-field-label">전역 기본 {d.kind === "code" ? "명령" : "프롬프트"}</label>
          <textarea
            placeholder={d.kind === "code" ? "셸 명령 (예: npm run dev)" : "현재 터미널로 보낼 프롬프트…"}
            rows={2}
            value={d.def}
            onChange={(e) => set({ def: e.target.value })}
          />
          <label className="preset-field-label">
            {projectName ?? "이 프로젝트"} 전용 — 비우면 기본 사용
          </label>
          <textarea
            placeholder={`이 프로젝트에서만 쓸 ${d.kind === "code" ? "명령" : "프롬프트"} (선택)`}
            rows={2}
            value={d.override}
            onChange={(e) => set({ override: e.target.value })}
          />
          <div className="preset-form-actions">
            {editingId && (
              <button className="ghost" onClick={reset}>
                취소
              </button>
            )}
            <button className="add" onClick={save} disabled={!canSave}>
              {editingId ? "저장" : "＋ 프리셋 추가"}
            </button>
          </div>
        </div>
      ) : (
        <div className="form">
          <div className="preset-kind-toggle">
            <button className={aiKind === "code" ? "on" : ""} onClick={() => setAiKind("code")}>
              코드
            </button>
            <button className={aiKind === "ai" ? "on" : ""} onClick={() => setAiKind("ai")}>
              AI
            </button>
          </div>
          <input
            placeholder="이름 (선택 · 비우면 설명에서 자동)"
            value={aiName}
            onChange={(e) => setAiName(e.target.value)}
          />
          <label className="preset-field-label">무엇을 하는 프리셋인가요?</label>
          <textarea
            placeholder="예: 개발 서버를 켜는 프리셋 만들어줘"
            rows={3}
            value={aiDesc}
            onChange={(e) => setAiDesc(e.target.value)}
          />
          <p className="hint muted">
            현재 프로젝트를 살펴본 뒤 이 프로젝트에 맞는 {aiKind === "code" ? "명령" : "프롬프트"}을 채워요.
          </p>
          <div className="preset-form-actions">
            <button className="add" onClick={submitAi} disabled={!aiDesc.trim()}>
              ✨ AI로 생성
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
