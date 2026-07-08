import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project } from "../../types";
import { ToolManifest } from "../../lib/tools";
import {
  appDiagnostics,
  checkForUpdate,
  Diagnostics,
  openPath,
  pathExists,
  UpdateAvailable,
} from "../../api/system";
import "./settings.css";

export default function SettingsPanel({
  onClose,
  projects,
  onRelink,
  onReinstallHooks,
  manifests,
  toolRoots,
  customToolIds,
  onAddCustomTool,
  onRemoveCustomTool,
  onSetToolRoot,
}: {
  onClose: () => void;
  projects: Project[];
  onRelink: (projectId: string) => void;
  onReinstallHooks: () => Promise<void>;
  manifests: Record<string, ToolManifest>;
  toolRoots: Record<string, string>;
  customToolIds: string[];
  onAddCustomTool: (root: string) => Promise<boolean>;
  onRemoveCustomTool: (manifestId: string) => void;
  onSetToolRoot: (manifestId: string, path: string) => void;
}) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [reinstalling, setReinstalling] = useState(false);
  const [rootExists, setRootExists] = useState<Record<string, boolean>>({});

  // Update state
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [updErr, setUpdErr] = useState<string | null>(null);

  const loadDiag = async () => setDiag(await appDiagnostics());
  const checkPaths = async () => {
    const entries = await Promise.all(
      projects.map(async (p) => [p.id, await pathExists(p.path)] as const),
    );
    setExists(Object.fromEntries(entries));
  };

  useEffect(() => {
    loadDiag();
    checkPaths();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // verify each connected tool's root folder still exists
  useEffect(() => {
    const roots = Object.entries(toolRoots).filter(([, v]) => v);
    Promise.all(roots.map(async ([id, path]) => [id, await pathExists(path)] as const)).then(
      (entries) => setRootExists(Object.fromEntries(entries)),
    );
  }, [toolRoots]);

  /** connect a new tool by picking its fleet-tool.json folder */
  const connectTool = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "툴 폴더 선택 (fleet-tool.json 포함)",
    });
    if (picked && typeof picked === "string") await onAddCustomTool(picked);
  };
  /** set / change a tool's root folder */
  const pickRoot = async (manifestId: string, current?: string) => {
    const picked = await open({ directory: true, multiple: false, defaultPath: current || undefined });
    if (picked && typeof picked === "string") onSetToolRoot(manifestId, picked);
  };

  const reinstall = async () => {
    setReinstalling(true);
    try {
      await onReinstallHooks();
      await loadDiag();
    } finally {
      setReinstalling(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    setUpdErr(null);
    try {
      const u = await checkForUpdate();
      setUpdate(u);
      setChecked(true);
    } catch (e) {
      setUpdErr(String(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setInstallPct(0);
    setUpdErr(null);
    try {
      await update.install((pct) => setInstallPct(pct));
      // app relaunches on success; nothing after this runs
    } catch (e) {
      setUpdErr(String(e));
      setInstallPct(null);
    }
  };

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span>설정 · 진단</span>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* Update */}
          <section className="settings-sec">
            <h3>업데이트</h3>
            <div className="set-row">
              <span className="set-key">현재 버전</span>
              <span className="set-val">{diag?.version ?? "-"}</span>
            </div>
            {update ? (
              <div className="upd-box">
                <div className="upd-line">
                  새 버전 <b>v{update.version}</b> 사용 가능
                </div>
                {update.notes && <pre className="upd-notes">{update.notes}</pre>}
                {installPct === null ? (
                  <button className="primary" onClick={install}>
                    지금 설치하고 재시작
                  </button>
                ) : (
                  <div className="upd-progress">
                    설치 중… {installPct}%
                    <div className="upd-bar">
                      <div className="upd-bar-fill" style={{ width: `${installPct}%` }} />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="set-row">
                <button className="btn" onClick={runCheck} disabled={checking}>
                  {checking ? "확인 중…" : "업데이트 확인"}
                </button>
                {checked && !update && <span className="set-muted">최신 버전이에요.</span>}
              </div>
            )}
            {updErr && <div className="set-err">{updErr}</div>}
          </section>

          {/* Paths */}
          <section className="settings-sec">
            <h3>시스템 경로</h3>
            <div className="set-row">
              <span className="set-key">홈</span>
              <span className="set-val mono">{diag?.home || "-"}</span>
            </div>
            <div className="set-row">
              <span className="set-key">설정 파일</span>
              <span className="set-val mono">{diag?.configPath || "-"}</span>
              {diag?.configPath && (
                <button
                  className="btn sm"
                  onClick={() => openPath(diag.configPath.replace(/[\\/][^\\/]*$/, ""))}
                >
                  열기
                </button>
              )}
            </div>
            <div className="set-row">
              <span className="set-key">Claude 세션</span>
              <span className="set-val mono">{diag?.claudeProjectsDir || "-"}</span>
            </div>
          </section>

          {/* Hooks */}
          <section className="settings-sec">
            <h3>Claude 연동 (hook)</h3>
            <div className="set-row">
              <span className="set-key">상태 포트</span>
              <span className="set-val">127.0.0.1:{diag?.hookPort ?? "-"}</span>
            </div>
            <div className="set-row">
              <span className="set-key">hook 설치</span>
              <span className="set-val">
                {diag?.hookInstalled ? (
                  <span className="ok">✓ 설치됨</span>
                ) : (
                  <span className="warn">⚠ 미설치</span>
                )}
              </span>
              <button className="btn sm" onClick={reinstall} disabled={reinstalling}>
                {reinstalling ? "설치 중…" : "재설치"}
              </button>
            </div>
            <p className="set-note">
              설치 후 새로 여는 Claude 터미널부터 상태·알림이 적용됩니다.
            </p>
          </section>

          {/* External tools registry */}
          <section className="settings-sec">
            <div className="set-sec-head">
              <h3>외부 툴</h3>
              <button className="btn sm" onClick={connectTool}>
                ＋ 툴 연결
              </button>
            </div>
            {Object.keys(manifests).length === 0 && (
              <p className="set-muted">연결된 툴이 없어요.</p>
            )}
            {Object.values(manifests).map((m) => {
              const custom = customToolIds.includes(m.id);
              const root = toolRoots[m.id];
              const ok = root ? rootExists[m.id] : undefined;
              return (
                <div className="set-tool" key={m.id}>
                  <div className="set-tool-main">
                    <span className={`set-proj-dot ${ok === false ? "warn" : ok ? "ok" : ""}`} />
                    <span className="set-proj-name">{m.name}</span>
                    <span className="set-tool-tag">{custom ? "커스텀" : "내장"}</span>
                    <span className="set-muted sm">모드 {m.modes.length}개</span>
                  </div>
                  <div className="set-tool-root">
                    {root ? (
                      <>
                        <span className="set-proj-path mono" title={root}>
                          {root}
                        </span>
                        {ok === false && <span className="warn sm">폴더 없음</span>}
                        {ok && (
                          <button className="btn sm" onClick={() => openPath(root)}>
                            열기
                          </button>
                        )}
                        <button className="btn sm" onClick={() => pickRoot(m.id, root)}>
                          경로 변경
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="set-muted sm">폴더 미연결</span>
                        <button className="btn sm" onClick={() => pickRoot(m.id)}>
                          폴더 지정
                        </button>
                      </>
                    )}
                    {custom && (
                      <button
                        className="btn sm danger"
                        onClick={() => onRemoveCustomTool(m.id)}
                        title="이 툴 연결 해제"
                      >
                        삭제
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {/* Project paths */}
          <section className="settings-sec">
            <h3>프로젝트 폴더</h3>
            {projects.length === 0 && <p className="set-muted">추가된 프로젝트가 없어요.</p>}
            {projects.map((p) => {
              const ok = exists[p.id];
              return (
                <div className="set-proj" key={p.id}>
                  <div className="set-proj-main">
                    <span className={`set-proj-dot ${ok === false ? "warn" : ok ? "ok" : ""}`} />
                    <span className="set-proj-name">{p.name}</span>
                    <span className="set-proj-path mono" title={p.path}>
                      {p.path}
                    </span>
                  </div>
                  <div className="set-proj-actions">
                    {ok === false && <span className="warn sm">폴더 없음</span>}
                    {ok && (
                      <button className="btn sm" onClick={() => openPath(p.path)}>
                        열기
                      </button>
                    )}
                    <button className="btn sm" onClick={() => onRelink(p.id)}>
                      다시 연결
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}
