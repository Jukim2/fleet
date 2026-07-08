import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Project, SavedToolRun, ToolJob } from "../../types";
import { defaultValues, ToolManifest, ToolOption, ToolValues } from "../../lib/tools";
import { listToolOutputs, ToolFile } from "../../api/tools";
import "./tools.css";

const fmtSize = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

/**
 * The GUI face of one external tool run: pick a mode + options (generated from
 * the manifest schema), launch, watch live progress, then browse the results in
 * a thumbnail canvas and pull selected files back into the Fleet project.
 */
export default function ToolRunModal({
  project,
  manifest,
  toolRoot,
  preset,
  toolJobs,
  initialJobId,
  onSetToolRoot,
  onRun,
  onCancel,
  onImport,
  onClose,
}: {
  project: Project;
  manifest: ToolManifest;
  toolRoot?: string;
  preset?: SavedToolRun;
  toolJobs: Record<string, ToolJob>;
  /** reopen an already-running/finished job instead of the setup form */
  initialJobId?: string;
  onSetToolRoot: (manifestId: string, path: string) => void;
  onRun: (mode: string, inputDir: string, values: ToolValues) => Promise<string | null>;
  onCancel: (jobId: string) => void;
  onImport: (jobId: string, files: string[], destSub: string) => Promise<void>;
  onClose: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const job = jobId ? toolJobs[jobId] : undefined;

  // --- setup form state (mode / input folder / option values) ---
  const [modeId, setModeId] = useState(
    preset?.mode && manifest.modes.some((m) => m.id === preset.mode)
      ? preset.mode
      : manifest.modes[0].id,
  );
  const mode = manifest.modes.find((m) => m.id === modeId) ?? manifest.modes[0];
  const [values, setValues] = useState<ToolValues>(() => ({
    ...defaultValues(mode),
    ...(preset?.mode === mode.id ? preset.values : {}),
  }));
  const [inputDir, setInputDir] = useState(preset?.inputDir || project.path);
  const [launching, setLaunching] = useState(false);
  const pickMode = (id: string) => {
    const m = manifest.modes.find((x) => x.id === id)!;
    setModeId(id);
    setValues({ ...defaultValues(m), ...(preset?.mode === id ? preset.values : {}) });
  };

  const pickFolder = async (current: string, apply: (p: string) => void) => {
    const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
    if (picked && typeof picked === "string") apply(picked);
  };

  const run = async () => {
    if (!toolRoot || !inputDir.trim() || launching) return;
    setLaunching(true);
    const id = await onRun(modeId, inputDir.trim(), values);
    setLaunching(false);
    if (id) setJobId(id);
  };

  // --- results: scan the job's output dir once it settles ---
  const [files, setFiles] = useState<ToolFile[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [destSub, setDestSub] = useState(`assets/${manifest.id}`);
  const [importing, setImporting] = useState(false);
  const finished = job && job.status !== "running";
  useEffect(() => {
    if (!job || job.status === "running") return;
    let alive = true;
    listToolOutputs(job.outDir, job.startedAt - 10_000)
      .then((fs) => {
        if (!alive) return;
        setFiles(fs);
        setSel(new Set(fs.map((f) => f.path)));
      })
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, jobId]);

  // log tail sticks to the bottom while running
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.lines.length]);

  const toggleFile = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const doImport = async () => {
    if (!jobId || !sel.size || importing) return;
    setImporting(true);
    await onImport(jobId, [...sel], destSub.trim() || `assets/${manifest.id}`);
    setImporting(false);
    onClose();
  };

  const statusLabel = !job
    ? ""
    : job.status === "running"
      ? "실행 중"
      : job.status === "done"
        ? "완료"
        : job.status === "killed"
          ? "중단됨"
          : "실패";

  const pct = job?.total ? Math.min(100, Math.round(((job.done + job.failed) / job.total) * 100)) : null;

  const optionField = (o: ToolOption) => {
    const v = values[o.key] ?? o.default;
    if (o.type === "bool")
      return (
        <label className="sf-opt sf-opt-bool" key={o.key} title={o.hint}>
          <input
            type="checkbox"
            checked={v === true}
            onChange={(e) => setValues((m) => ({ ...m, [o.key]: e.target.checked }))}
          />
          <span>{o.label}</span>
        </label>
      );
    return (
      <label className="sf-opt" key={o.key} title={o.hint}>
        <span className="sf-opt-label">{o.label}</span>
        {o.type === "select" ? (
          <select
            value={String(v)}
            onChange={(e) => setValues((m) => ({ ...m, [o.key]: e.target.value }))}
          >
            {o.choices!.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : o.type === "color" ? (
          <input
            type="color"
            value={String(v)}
            onChange={(e) => setValues((m) => ({ ...m, [o.key]: e.target.value }))}
          />
        ) : o.type === "number" ? (
          <input
            type="number"
            value={String(v)}
            min={o.min}
            max={o.max}
            step={o.step ?? 1}
            onChange={(e) => setValues((m) => ({ ...m, [o.key]: Number(e.target.value) }))}
          />
        ) : (
          <input
            type="text"
            value={String(v)}
            placeholder={String(o.default) || undefined}
            onChange={(e) => setValues((m) => ({ ...m, [o.key]: e.target.value }))}
          />
        )}
      </label>
    );
  };

  return (
    <div className="sf-overlay" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
      <div className="sf-modal" onClick={(e) => e.stopPropagation()}>
        <header className="sf-head">
          <span className="sf-title">
            {manifest.name}
            <span className="sf-title-mode">
              {job ? ` · ${manifest.modes.find((m) => m.id === job.mode)?.label ?? job.mode}` : ""}
            </span>
          </span>
          <span className="sf-project">{project.name}</span>
          {job && <span className={`sf-status ${job.status}`}>{statusLabel}</span>}
          {finished && (
            <button className="btn" onClick={() => setJobId(null)}>
              새 실행
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        {!job ? (
          /* ---------- setup form ---------- */
          <div className="sf-body">
            {!toolRoot && (
              <div className="sf-note">
                <span>
                  <b>{manifest.name}</b> 폴더를 먼저 연결하세요 (예: SpriteForge 저장소 루트).
                </span>
                <button
                  className="btn primary"
                  onClick={() => pickFolder("", (p) => onSetToolRoot(manifest.id, p))}
                >
                  폴더 선택
                </button>
              </div>
            )}
            {toolRoot && (
              <div className="sf-root" title={toolRoot}>
                툴 위치: <code>{toolRoot}</code>
                <button
                  className="sf-root-change"
                  onClick={() => pickFolder(toolRoot, (p) => onSetToolRoot(manifest.id, p))}
                >
                  변경
                </button>
              </div>
            )}

            <div className="sf-modes">
              {manifest.modes.map((m) => (
                <button
                  key={m.id}
                  className={`sf-mode ${m.id === modeId ? "on" : ""}`}
                  onClick={() => pickMode(m.id)}
                  title={m.desc}
                >
                  <span className="sf-mode-icon">{m.icon}</span>
                  <span className="sf-mode-label">{m.label}</span>
                </button>
              ))}
            </div>
            <div className="sf-mode-desc">{mode.desc}</div>

            <label className="sf-opt sf-input-dir">
              <span className="sf-opt-label">입력 폴더</span>
              <input
                type="text"
                value={inputDir}
                onChange={(e) => setInputDir(e.target.value)}
                placeholder={project.path}
              />
              <button
                className="btn"
                onClick={() => pickFolder(inputDir || project.path, setInputDir)}
                title="폴더 선택"
              >
                📁
              </button>
            </label>

            <div className="sf-opts">{mode.options.map(optionField)}</div>

            <footer className="sf-foot">
              <span className="sf-hint">
                결과물은 <code>입력 폴더/{manifest.outDirName}</code>에 생겨요 — 원본은 건드리지 않아요.
              </span>
              <button
                className="btn primary"
                disabled={!toolRoot || !inputDir.trim() || launching}
                onClick={run}
              >
                {launching ? "시작 중…" : "▶ 실행"}
              </button>
            </footer>
          </div>
        ) : (
          /* ---------- running / results ---------- */
          <div className="sf-body">
            <div className="sf-progress">
              <div className="sf-bar">
                <div
                  className={`sf-bar-fill ${job.status === "running" && pct === null ? "indet" : ""} ${
                    job.status === "error" ? "err" : ""
                  }`}
                  style={pct !== null ? { width: `${pct}%` } : undefined}
                />
              </div>
              <span className="sf-progress-text">
                {job.done}
                {job.total ? `/${job.total}` : ""} 처리
                {job.failed > 0 ? ` · 실패 ${job.failed}` : ""}
              </span>
              {job.status === "running" && (
                <button className="btn danger" onClick={() => onCancel(job.id)}>
                  중단
                </button>
              )}
            </div>

            {(job.status === "running" || job.status === "error" || !files?.length) && (
              <pre className="sf-log" ref={logRef}>
                {job.lines.join("\n") || "출력 대기 중…"}
              </pre>
            )}

            {finished && files && files.length > 0 && (
              <>
                <div className="sf-results-head">
                  <span>
                    결과물 {files.length}개 · 선택 {sel.size}
                  </span>
                  <button className="btn" onClick={() => setSel(new Set(files.map((f) => f.path)))}>
                    전체 선택
                  </button>
                  <button className="btn" onClick={() => setSel(new Set())}>
                    해제
                  </button>
                </div>
                <div className="sf-grid">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      className={`sf-thumb ${sel.has(f.path) ? "sel" : ""}`}
                      onClick={() => toggleFile(f.path)}
                      title={`${f.rel} · ${fmtSize(f.size)}`}
                    >
                      <img src={convertFileSrc(f.path)} alt={f.name} loading="lazy" />
                      <span className="sf-thumb-name">{f.name}</span>
                    </button>
                  ))}
                </div>
                <footer className="sf-foot">
                  <label className="sf-dest">
                    <span>가져올 위치</span>
                    <code>{project.name}/</code>
                    <input
                      type="text"
                      value={destSub}
                      onChange={(e) => setDestSub(e.target.value)}
                    />
                  </label>
                  <button
                    className="btn primary"
                    disabled={!sel.size || importing}
                    onClick={doImport}
                  >
                    {importing ? "복사 중…" : `← 프로젝트로 가져오기 (${sel.size})`}
                  </button>
                </footer>
              </>
            )}

            {finished && files && files.length === 0 && (
              <div className="sf-empty">결과물을 찾지 못했어요 — 위 로그를 확인해 주세요.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
