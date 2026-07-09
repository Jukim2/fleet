import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project } from "../../types";
import { AgentKind, AgentSpec } from "../../lib/agents";
import { ToolManifest } from "../../lib/tools";
import { THEME_LIST, ThemeId, themeSwatch } from "../../lib/themes";
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
  onScanTools,
  onRegisterToolViaAI,
  onCloseAfterAction,
  agent,
  agents,
  onSetAgent,
  customAgentIds,
  onAddCustomAgent,
  onRemoveCustomAgent,
  theme,
  onSetTheme,
}: {
  onClose: () => void;
  projects: Project[];
  /** the active coding-agent id (global) */
  agent: AgentKind;
  /** every registered agent (built-in + connected manifests) */
  agents: AgentSpec[];
  onSetAgent: (agent: AgentKind) => void;
  /** ids of user-connected (removable) agents */
  customAgentIds: string[];
  onAddCustomAgent: (root: string) => Promise<boolean>;
  onRemoveCustomAgent: (agentId: string) => void;
  /** selected UI theme id + setter */
  theme: string;
  onSetTheme: (id: ThemeId) => void;
  onRelink: (projectId: string) => void;
  onReinstallHooks: () => Promise<void>;
  manifests: Record<string, ToolManifest>;
  toolRoots: Record<string, string>;
  customToolIds: string[];
  onAddCustomTool: (root: string) => Promise<boolean>;
  onRemoveCustomTool: (manifestId: string) => void;
  onScanTools: () => Promise<{ root: string; name: string; id: string }[]>;
  onRegisterToolViaAI: (folder: string) => void;
  onCloseAfterAction: () => void;
}) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [reinstalling, setReinstalling] = useState(false);
  const [rootExists, setRootExists] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"general" | "appearance" | "tools">("general");
  const [found, setFound] = useState<{ root: string; name: string; id: string }[]>([]);

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

  /** connect a coding agent by picking a folder holding fleet-agent.json */
  const connectAgent = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "에이전트 폴더 선택 (fleet-agent.json 포함)",
    });
    if (picked && typeof picked === "string") await onAddCustomAgent(picked);
  };

  /** connect a new tool by picking its fleet-tool.json folder */
  const connectTool = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "툴 폴더 선택 (fleet-tool.json 포함)",
    });
    if (picked && typeof picked === "string") await onAddCustomTool(picked);
  };
  /** AI registration: pick the tool's folder, hand off to a claude session */
  const registerAI = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "툴 폴더 선택 — AI가 fleet-tool.json을 작성해요",
    });
    if (picked && typeof picked === "string") {
      onRegisterToolViaAI(picked);
      onCloseAfterAction(); // close settings so the spawned claude session is visible
    }
  };

  // auto-scan registered project folders for unconnected fleet-tool.json once the
  // tools tab is opened (and after manifests change, e.g. a connect happened)
  useEffect(() => {
    if (tab !== "tools") return;
    let alive = true;
    onScanTools()
      .then((f) => alive && setFound(f))
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
    // onScanTools identity changes each render — scan only on tab/manifest change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, manifests]);

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
          <span>설정</span>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === "general" ? "on" : ""}`}
            onClick={() => setTab("general")}
          >
            일반 · 진단
          </button>
          <button
            className={`settings-tab ${tab === "appearance" ? "on" : ""}`}
            onClick={() => setTab("appearance")}
          >
            테마
          </button>
          <button
            className={`settings-tab ${tab === "tools" ? "on" : ""}`}
            onClick={() => setTab("tools")}
          >
            외부 툴
            {Object.keys(manifests).length > 0 && (
              <span className="settings-tab-count">{Object.keys(manifests).length}</span>
            )}
          </button>
        </div>

        <div className="settings-body" style={{ display: tab === "general" ? "block" : "none" }}>
          {/* Active agent CLI + connected agent manifests */}
          <section className="settings-sec">
            <h3>코딩 에이전트</h3>
            <p className="set-note">
              새 세션·리줌 목록·상태 감지가 선택한 에이전트를 따릅니다. 이미 열려 있는 터미널은 원래
              실행한 CLI를 그대로 유지해요. 새 에이전트는 <code>fleet-agent.json</code> 매니페스트만
              추가하면 코드 수정 없이 연결됩니다.
            </p>
            <div className="set-row" style={{ gap: 8, flexWrap: "wrap" }}>
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={agent === a.id ? "primary" : "btn"}
                  onClick={() => onSetAgent(a.id)}
                  title={
                    a.statusMode === "hooks"
                      ? "상태: Claude Code hook"
                      : a.statusMode === "rollout"
                        ? "상태: 세션 이벤트 로그(구조화)"
                        : "상태: 화면 스캔"
                  }
                >
                  {a.label}
                  {customAgentIds.includes(a.id) && (
                    <span
                      title="연결 해제"
                      style={{ marginLeft: 6, opacity: 0.6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveCustomAgent(a.id);
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
              ))}
              <button className="btn" onClick={connectAgent} title="fleet-agent.json 폴더 연결">
                ＋ 에이전트
              </button>
            </div>
            <p className="set-note">
              상태 감지 방식 — <b>Claude</b>: Code hook. <b>Codex</b>: 세션 이벤트 로그(rollout)를 읽어
              작업 중/대기/승인을 구조적으로 파악(화면 스캔 아님 → 언어·버전에 안 깨짐). 그 외 매니페스트
              에이전트는 매니페스트가 지정한 방식(hook/로그/화면)을 씁니다.
            </p>
          </section>

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
            <div className="set-row">
              <span className="set-key">Codex 세션</span>
              <span className="set-val mono">{diag?.codexSessionsDir || "-"}</span>
            </div>
          </section>

          {/* Hooks (Claude only) */}
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
              설치 후 새로 여는 Claude 터미널부터 상태·알림이 적용됩니다. (Codex는 이 hook을 쓰지 않고
              세션 이벤트 로그로 상태를 파악하므로 별도 설치가 필요 없어요.)
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

        {/* ---- Appearance tab: theme picker ---- */}
        <div
          className="settings-body"
          style={{ display: tab === "appearance" ? "block" : "none" }}
        >
          <section className="settings-sec">
            <h3>테마</h3>
            <p className="set-note">
              전체 UI 색상과 터미널 색을 함께 바꿉니다. 선택은 바로 적용되고 저장돼요.
            </p>
            <div className="theme-grid">
              {THEME_LIST.map((t) => {
                const sw = themeSwatch(t.id);
                const on = (theme || "slate") === t.id;
                return (
                  <button
                    key={t.id}
                    className={`theme-card ${on ? "on" : ""}`}
                    onClick={() => onSetTheme(t.id)}
                    title={t.name}
                    aria-pressed={on}
                  >
                    <div
                      className="theme-preview"
                      style={{ background: sw.bg, borderColor: sw.surface }}
                    >
                      <span className="theme-bar" style={{ background: sw.surface }}>
                        <i style={{ background: sw.accent }} />
                        <i style={{ background: sw.idle }} />
                        <i style={{ background: sw.waiting }} />
                      </span>
                      <span className="theme-lines">
                        <em style={{ background: sw.text }} />
                        <em style={{ background: sw.accent, width: "40%" }} />
                      </span>
                    </div>
                    <div className="theme-name">
                      {t.name}
                      <span className="theme-group">{t.group === "light" ? "라이트" : "다크"}</span>
                      {on && <span className="theme-check">✓</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        {/* ---- Tools tab: concept → contract → add(2 ways) → cards ---- */}
        <div className="settings-body" style={{ display: tab === "tools" ? "block" : "none" }}>
          {/* 1. concept */}
          <section className="settings-sec">
            <h3>외부 툴이란</h3>
            <p className="tool-lead">
              Fleet이 띄운 claude 세션이 <b>어떤 CLI를 실행하면</b>, Fleet이 hook으로 그 명령을 보고{" "}
              <code>detect</code>에 걸리면 라이브 캔버스의 세션 노드에 <b>툴 노드</b>를 매달아
              보여줘요. 명령 형태에 제약이 없고, 한 툴에 여러 CLI도 담을 수 있어요. 클로드는
              Fleet을 모르고, Fleet이 <b>관찰만</b> 합니다 (직접 실행하지 않음).
            </p>
          </section>

          {/* 2. requirements — detection only */}
          <section className="settings-sec">
            <h3>등록 요건</h3>
            <p className="tool-lead">
              <code>id</code>, <code>name</code>,{" "}
              <code>detect</code>(그 툴을 실행하는 명령을 알아볼 정규식 — 문자열 하나 또는 배열)만
              있으면 돼요. 실행 폼·옵션 같은 건 필요 없어요.
            </p>
            <p className="tool-req-sub">
              결과 미리보기(입력→결과 썸네일)를 노드에 띄우려면, 그 CLI가 결과물을{" "}
              <b>입력 폴더 아래의 하위 폴더</b>(<code>outDirName</code>, 기본 <code>_out</code>)에
              쓰면 Fleet이 그걸 찾아 보여줘요. (선택 — 없어도 노드는 뜸)
            </p>
            <p className="set-note">
              전체 규격: 저장소의 <code>docs/EXTERNAL_TOOLS.md</code>.
            </p>
          </section>

          {/* 3. add — two ways + auto-discovered */}
          <section className="settings-sec">
            <h3>툴 추가</h3>
            <div className="tool-add-ways">
              <div className="tool-add-way">
                <div className="tool-add-way-title">🤖 AI로 등록</div>
                <p>
                  툴 폴더를 고르면 claude 세션이 그 CLI를 분석해 <code>fleet-tool.json</code>을
                  작성하고, 저장되는 순간 Fleet이 자동으로 연결해요. 구독 세션이라 추가 비용 없음.
                </p>
                <button className="primary sm" onClick={registerAI}>
                  AI로 툴 등록
                </button>
              </div>
              <div className="tool-add-way">
                <div className="tool-add-way-title">✍️ 직접 연결</div>
                <p>
                  이미 <code>fleet-tool.json</code>이 있는 폴더를 직접 선택해 연결해요.
                </p>
                <button className="btn sm" onClick={connectTool}>
                  ＋ 폴더 연결
                </button>
              </div>
            </div>
            {found.length > 0 && (
              <div className="tool-found">
                <div className="tool-found-title">프로젝트 폴더에서 발견됨 — 연결할 수 있어요</div>
                {found.map((f) => (
                  <div className="tool-found-row" key={f.root}>
                    <span className="set-proj-dot ok" />
                    <span className="set-proj-name">{f.name}</span>
                    <span className="set-proj-path mono" title={f.root}>
                      {f.root}
                    </span>
                    <button className="btn sm" onClick={() => onAddCustomTool(f.root)}>
                      연결
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 4. connected tools — cards */}
          <section className="settings-sec">
            <h3>연결된 툴</h3>
            {Object.keys(manifests).length === 0 ? (
              <p className="set-muted">아직 연결된 툴이 없어요 — 위에서 추가하세요.</p>
            ) : (
              <div className="tool-cards">
                {Object.values(manifests).map((m) => {
                  const custom = customToolIds.includes(m.id);
                  const root = toolRoots[m.id];
                  const ok = root ? rootExists[m.id] : undefined;
                  const detects = Array.isArray(m.detect) ? m.detect : m.detect ? [m.detect] : [];
                  return (
                    <div className="tool-card" key={m.id}>
                      <div className="tool-card-head">
                        <span className="set-proj-dot ok" />
                        <span className="tool-card-name">{m.name}</span>
                        <span className="set-tool-tag">{custom ? "커스텀" : "내장"}</span>
                        {detects.length > 0 && (
                          <span
                            className="tool-card-detect"
                            title="claude 세션의 명령을 자동 감지해 라이브 노드로 표시"
                          >
                            자동 감지
                          </span>
                        )}
                        <span className="tool-card-spacer" />
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

                      {m.desc && <div className="tool-card-desc">{m.desc}</div>}

                      {detects.length > 0 && (
                        <div className="tool-card-cmd mono" title="이 패턴에 걸리는 명령을 감지해요">
                          감지: {detects.map((re) => re.source).join("  ·  ")}
                        </div>
                      )}

                      {custom && root && (
                        <div className="tool-card-row">
                          <span className="tool-card-key">위치</span>
                          <span className="set-proj-path mono" title={root}>
                            {root}
                          </span>
                          {ok === false && <span className="warn sm">폴더 없음</span>}
                          {ok && (
                            <button className="btn sm" onClick={() => openPath(root)}>
                              열기
                            </button>
                          )}
                        </div>
                      )}

                      {m.modes.length > 0 && (
                        <>
                          <div className="tool-card-modes-title">기능 {m.modes.length}가지</div>
                          <div className="tool-modes">
                            {m.modes.map((mode) => (
                              <div className="tool-mode" key={mode.id} title={mode.desc}>
                                <span className="tool-mode-icon">{mode.icon}</span>
                                <span className="tool-mode-body">
                                  <span className="tool-mode-label">{mode.label}</span>
                                  {mode.desc && <span className="tool-mode-desc">{mode.desc}</span>}
                                </span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {/* how the live node will look */}
                      <div className="tool-nodeinfo">
                        <span className="tool-nodeinfo-mock">
                          <span className="tool-nodeinfo-box">입력</span>
                          <span className="tool-nodeinfo-arrow">→</span>
                          <span className="tool-nodeinfo-box out">결과</span>
                          <span className="tool-nodeinfo-mini">▫▫▫ +N</span>
                        </span>
                        <span className="tool-nodeinfo-text">
                          claude가 이 툴을 쓰면 라이브 노드에 <b>대표 입력→결과 1쌍</b>이 크게,
                          나머지 결과가 작은 썸네일로 떠요 (결과를{" "}
                          <code>&lt;입력&gt;/{m.outDirName}</code>에 쓰는 경우).
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
