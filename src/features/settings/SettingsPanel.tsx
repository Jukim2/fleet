import { useEffect, useState } from "react";
import { Project } from "../../types";
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
}: {
  onClose: () => void;
  projects: Project[];
  onRelink: (projectId: string) => void;
  onReinstallHooks: () => Promise<void>;
}) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [reinstalling, setReinstalling] = useState(false);

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
