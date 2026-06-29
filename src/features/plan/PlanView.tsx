import { useEffect, useMemo, useState } from "react";
import { Plan, PlanStep, Project, TaskStatus, Terminal, TermStatus } from "../../types";
import { gitIsRepo } from "../../api/git";
import { RunTarget } from "../../lib/plan";
import { layoutPlan, NODE_H } from "../../lib/planLayout";
import { PHASE_LABEL, WtRun, WtStep, wtProgress } from "../../lib/worktree";
import "./plan.css";

type StepState = "done" | "running" | "ready" | "blocked";
function stepState(s: PlanStep, ts: Record<string, TaskStatus>): StepState {
  if (ts[s.id] === "done") return "done";
  if (ts[s.id] === "running") return "running";
  return s.deps.every((d) => ts[d] === "done") ? "ready" : "blocked";
}
const STATE_LABEL: Record<StepState, string> = {
  done: "완료",
  running: "실행 중",
  ready: "대기",
  blocked: "선행 대기",
};

export default function PlanView({
  project,
  plan,
  taskStatus,
  statuses,
  terminals,
  planning,
  onRequestPlan,
  onLoadPlan,
  onRunSteps,
  onToggleCollapse,
  onRemovePlan,
  onAddTheme,
  onAddFeature,
  onAddStep,
  onRenameNode,
  onEditStep,
  onRemoveNode,
  wtRun,
  wtMsg,
  onStopWtRun,
  onShowStep,
  onClearWtMsg,
  onClose,
}: {
  project: Project;
  plan: Plan | undefined;
  taskStatus: Record<string, TaskStatus>;
  statuses: Record<string, TermStatus>;
  terminals: Terminal[];
  planning: boolean;
  wtRun?: WtRun;
  wtMsg?: string;
  onStopWtRun: () => void;
  onShowStep: (termId: string) => void;
  onClearWtMsg: () => void;
  onRequestPlan: (goal: string) => void;
  onLoadPlan: () => void;
  onRunSteps: (stepIds: string[], target: RunTarget) => void;
  onToggleCollapse: (nodeId: string, current: boolean) => void;
  onRemovePlan: () => void;
  onAddTheme: () => void;
  onAddFeature: (themeId: string) => void;
  onAddStep: (featureId: string) => void;
  onRenameNode: (id: string, title: string) => void;
  onEditStep: (id: string, patch: { title?: string; prompt?: string }) => void;
  onRemoveNode: (id: string) => void;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [runOpen, setRunOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // inline title rename
  const [stepEdit, setStepEdit] = useState<PlanStep | null>(null); // step editor modal
  const [gitRepo, setGitRepo] = useState<boolean | null>(null); // is the project a git repo?

  useEffect(() => {
    let alive = true;
    gitIsRepo(project.path)
      .then((r) => alive && setGitRepo(r))
      .catch(() => alive && setGitRepo(false));
    return () => {
      alive = false;
    };
  }, [project.path]);

  // step ids grouped under each feature / theme (for progress + group-select)
  const { stepIdsUnderFeature, stepIdsUnderTheme } = useMemo(() => {
    const sbf: Record<string, PlanStep[]> = {};
    for (const s of plan?.steps ?? []) (sbf[s.featureId] ??= []).push(s);
    const underFeat: Record<string, string[]> = {};
    for (const [fid, steps] of Object.entries(sbf)) underFeat[fid] = steps.map((s) => s.id);
    const underTheme: Record<string, string[]> = {};
    for (const f of plan?.features ?? [])
      (underTheme[f.themeId] ??= []).push(...(underFeat[f.id] ?? []));
    return { stepIdsUnderFeature: underFeat, stepIdsUnderTheme: underTheme };
  }, [plan]);

  // Effective status: live task status, plus steps persisted as completed in the
  // plan (so done-state survives restarts and accumulates in the graph).
  const effTs = useMemo(() => {
    const m: Record<string, TaskStatus> = { ...taskStatus };
    for (const id of Object.keys(plan?.completed ?? {})) m[id] = "done";
    return m;
  }, [taskStatus, plan]);

  const doneOf = (ids: string[]) => ids.filter((id) => effTs[id] === "done").length;

  // effective collapse: explicit state, else auto-collapse when that node's steps are all done
  const isCollapsed = (nodeId: string, ids: string[]) => {
    const explicit = plan?.collapsed?.[nodeId];
    if (explicit !== undefined) return explicit;
    return ids.length > 0 && doneOf(ids) === ids.length;
  };

  const layout = useMemo(() => {
    if (!plan) return null;
    return layoutPlan(plan, (id) => {
      const ids = stepIdsUnderTheme[id] ?? stepIdsUnderFeature[id] ?? [];
      return isCollapsed(id, ids);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, effTs, stepIdsUnderTheme, stepIdsUnderFeature]);

  const total = plan?.steps.length ?? 0;
  const done = (plan?.steps ?? []).filter((s) => effTs[s.id] === "done").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const hasGraph = !!plan && (plan.themes.length > 0 || plan.steps.length > 0);

  const toggleStep = (id: string) =>
    setSel((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleGroup = (ids: string[]) =>
    setSel((s) => {
      const next = new Set(s);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) (allOn ? next.delete(id) : next.add(id));
      return next;
    });

  const stepById = useMemo(
    () => Object.fromEntries((plan?.steps ?? []).map((s) => [s.id, s])),
    [plan],
  );
  const wtByStep = useMemo(() => {
    const m: Record<string, WtStep> = {};
    for (const s of wtRun?.steps ?? []) m[s.stepId] = s;
    return m;
  }, [wtRun]);
  const wtProg = wtRun ? wtProgress(wtRun) : null;

  // inline rename input shared by theme/feature nodes
  const renameInput = (id: string, title: string) => (
    <input
      className="plan-node-edit"
      autoFocus
      defaultValue={title}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        onRenameNode(id, e.target.value.trim() || title);
        setEditingId(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditingId(null);
      }}
    />
  );

  return (
    <div className="plan-overlay" onMouseDown={onClose}>
      <div className="plan" onMouseDown={(e) => e.stopPropagation()}>
        <header className="plan-head">
          <strong>{project.name} · 플랜 그래프</strong>
          {hasGraph && total > 0 && (
            <div className="plan-progress">
              <div className="plan-bar">
                <div className="plan-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="plan-pct">
                {done}/{total} · {pct}%
              </span>
            </div>
          )}
          <button className="btn" onClick={onAddTheme} title="테마를 직접 추가">
            ＋ 테마
          </button>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        {/* Goal input — generate (merges into the graph) or load a plan */}
        <div className="plan-goal">
          <input
            className="plan-goal-in"
            placeholder="요청을 입력하면 테마→기능→단계로 분해해 그래프에 더해요  (예: UI 개선 — 다크모드)"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && !planning && goal.trim() && (onRequestPlan(goal.trim()), setGoal(""))
            }
            disabled={planning}
          />
          <button
            className="btn primary"
            disabled={planning || !goal.trim()}
            onClick={() => {
              onRequestPlan(goal.trim());
              setGoal("");
            }}
          >
            {planning ? "구성 중…" : "요청 추가"}
          </button>
          <button className="btn" onClick={onLoadPlan} title="이미 만들어진 .fleet/plan.json 읽기">
            불러오기
          </button>
        </div>
        {planning && (
          <div className="plan-note">
            플래너 세션이 <code>.fleet/plan.json</code>을 작성하는 중… 완료되면 그래프에 자동 반영돼요.
          </div>
        )}
        {wtMsg ? (
          <div className="plan-note plan-note-warn" onClick={onClearWtMsg} title="클릭해 닫기">
            ⚠ {wtMsg}
          </div>
        ) : null}

        {/* Worktree run banner */}
        {wtRun && wtProg && (
          <div className="plan-wt-banner">
            <span className={`plan-wt-dot ${wtProg.error ? "err" : wtProg.active ? "go" : "idle"}`} />
            <span className="plan-wt-label">
              worktree 실행 · <code>{wtRun.branch}</code>
            </span>
            <div className="plan-bar plan-wt-bar">
              <div
                className="plan-bar-fill"
                style={{ width: `${wtProg.total ? (wtProg.done / wtProg.total) * 100 : 0}%` }}
              />
            </div>
            <span className="plan-wt-stat">
              {wtProg.done}/{wtProg.total}
              {wtProg.active ? ` · ${wtProg.active} 진행` : ""}
              {wtProg.error ? ` · ${wtProg.error} 오류` : ""}
            </span>
            <button className="btn danger" onClick={onStopWtRun}>
              중지
            </button>
          </div>
        )}

        {/* Graph canvas */}
        <div className="plan-canvas">
          {!hasGraph || !layout ? (
            <div className="plan-empty">
              아직 플랜이 없어요. 위에 요청을 입력하고 <b>요청 추가</b>를 누르면 테마 → 기능 → 단계
              그래프로 쌓이고,
              <br />
              이어지는 요청도 같은 그래프에 붙어요. 직접 만들려면 <b>＋ 테마</b>로 시작하세요.
            </div>
          ) : (
            <div className="plan-graph" style={{ width: layout.width, height: layout.height }}>
              <svg className="plan-edges" width={layout.width} height={layout.height}>
                <defs>
                  <marker
                    id="plan-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L8,4 L0,8 z" className="plan-arrow-fill" />
                  </marker>
                </defs>
                {layout.edges.map((e) => (
                  <path
                    key={e.id}
                    d={e.d}
                    className={`plan-edge ${e.kind}`}
                    markerEnd={e.kind === "dep" ? "url(#plan-arrow)" : undefined}
                  />
                ))}
              </svg>

              {layout.nodes.map((n) => {
                if (n.kind === "step") {
                  const s = stepById[n.id];
                  if (!s) return null;
                  const st = stepState(s, effTs);
                  const wt = wtByStep[n.id];
                  const cls = wt ? `wt-${wt.phase}` : st;
                  const label = wt ? PHASE_LABEL[wt.phase] : STATE_LABEL[st];
                  const liveTerm = wt?.resolveTermId ?? wt?.termId;
                  const on = sel.has(n.id);
                  return (
                    <div
                      key={n.id}
                      className={`plan-node step ${cls} ${on ? "sel" : ""}`}
                      style={{ left: n.x, top: n.y, width: n.w, height: NODE_H }}
                      title={wt?.note || s.prompt || "(prompt 비어있음 — 더블클릭해 작성)"}
                      onClick={() => toggleStep(n.id)}
                      onDoubleClick={() => setStepEdit(s)}
                    >
                      <span className="plan-node-title">{n.title}</span>
                      <span className={`plan-node-state ${cls}`}>{label}</span>
                      <span className="plan-node-actions">
                        {liveTerm && (
                          <button
                            className="plan-node-act"
                            title="이 단계 세션 보기"
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowStep(liveTerm);
                            }}
                          >
                            👁
                          </button>
                        )}
                        <button
                          className="plan-node-act"
                          title="편집"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStepEdit(s);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="plan-node-act del"
                          title="삭제"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveNode(n.id);
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  );
                }
                // theme / feature node
                const ids = n.kind === "theme" ? stepIdsUnderTheme[n.id] ?? [] : stepIdsUnderFeature[n.id] ?? [];
                const collapsed = isCollapsed(n.id, ids);
                const d = doneOf(ids);
                const allDone = ids.length > 0 && d === ids.length;
                const allSel = ids.length > 0 && ids.every((id) => sel.has(id));
                return (
                  <div
                    key={n.id}
                    className={`plan-node ${n.kind} ${allDone ? "done" : ""} ${allSel ? "sel" : ""}`}
                    style={{ left: n.x, top: n.y, width: n.w, height: NODE_H }}
                  >
                    <button
                      className="plan-node-caret"
                      title={collapsed ? "펼치기" : "접기"}
                      onClick={() => onToggleCollapse(n.id, collapsed)}
                    >
                      {collapsed ? "▸" : "▾"}
                    </button>
                    {editingId === n.id ? (
                      renameInput(n.id, n.title)
                    ) : (
                      <span
                        className="plan-node-title"
                        onClick={() => toggleGroup(ids)}
                        onDoubleClick={() => setEditingId(n.id)}
                        title={`${n.title} — 클릭: 단계 전체 선택 · 더블클릭: 이름 변경`}
                      >
                        {n.title}
                      </span>
                    )}
                    <span className="plan-node-count">
                      {allDone ? "✓ " : ""}
                      {d}/{ids.length}
                    </span>
                    <span className="plan-node-actions">
                      <button
                        className="plan-node-act"
                        title={n.kind === "theme" ? "기능 추가" : "단계 추가"}
                        onClick={(e) => {
                          e.stopPropagation();
                          n.kind === "theme" ? onAddFeature(n.id) : onAddStep(n.id);
                        }}
                      >
                        ＋
                      </button>
                      <button
                        className="plan-node-act del"
                        title="삭제"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveNode(n.id);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selection action bar */}
        {hasGraph && total > 0 && (
          <footer className="plan-foot">
            <span className="plan-selinfo">{sel.size}개 단계 선택</span>
            <div className="plan-foot-actions">
              <button
                className="btn"
                onClick={() =>
                  setSel(new Set(plan!.steps.filter((s) => effTs[s.id] !== "done").map((s) => s.id)))
                }
              >
                남은 단계 전체
              </button>
              <button className="btn" onClick={() => setSel(new Set())} disabled={!sel.size}>
                선택 해제
              </button>
              <button className="btn danger" onClick={onRemovePlan}>
                플랜 삭제
              </button>
              <button className="btn primary" disabled={!sel.size} onClick={() => setRunOpen(true)}>
                선택 실행 ({sel.size})
              </button>
            </div>
          </footer>
        )}
      </div>

      {runOpen && plan && (
        <RunDialog
          steps={plan.steps.filter((s) => sel.has(s.id))}
          terminals={terminals}
          statuses={statuses}
          gitRepo={gitRepo}
          onClose={() => setRunOpen(false)}
          onRun={(target) => {
            onRunSteps([...sel], target);
            setRunOpen(false);
          }}
        />
      )}

      {stepEdit && (
        <StepEditor
          step={stepEdit}
          onClose={() => setStepEdit(null)}
          onSave={(patch) => {
            onEditStep(stepEdit.id, patch);
            setStepEdit(null);
          }}
        />
      )}
    </div>
  );
}

/** Edit a step's title + the prompt sent to its session. */
function StepEditor({
  step,
  onClose,
  onSave,
}: {
  step: PlanStep;
  onClose: () => void;
  onSave: (patch: { title: string; prompt: string }) => void;
}) {
  const [title, setTitle] = useState(step.title);
  const [prompt, setPrompt] = useState(step.prompt);
  return (
    <div className="plan-rd-overlay" onMouseDown={onClose}>
      <div className="plan-se" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plan-rd-head">단계 편집</div>
        <label className="plan-se-label">제목</label>
        <input className="plan-goal-in" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="plan-se-label">지시문 (세션에 전달될 prompt)</label>
        <textarea
          className="plan-se-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="이 단계를 수행할 세션에게 줄 지시문"
        />
        <div className="plan-rd-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" onClick={() => onSave({ title: title.trim() || step.title, prompt })}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

/** Hybrid target picker: a quick preset, with optional per-step overrides. */
function RunDialog({
  steps,
  terminals,
  statuses,
  gitRepo,
  onClose,
  onRun,
}: {
  steps: PlanStep[];
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  gitRepo: boolean | null;
  onClose: () => void;
  onRun: (target: RunTarget) => void;
}) {
  const [preset, setPreset] = useState<"each-new" | "one-new" | "existing">("each-new");
  const [existingTerm, setExistingTerm] = useState(terminals[0]?.id ?? "");
  const [perStep, setPerStep] = useState(false);
  const [auto, setAuto] = useState(true);
  const [worktree, setWorktree] = useState(false);
  const [assign, setAssign] = useState<Record<string, string>>({}); // stepId -> "inherit" | "new" | termId
  const wtDisabled = gitRepo === false;

  const run = () => {
    const base = { auto, worktree };
    if (worktree) {
      // worktree mode: each step gets its own worktree regardless of preset
      onRun({ mode: "each-new", ...base });
      return;
    }
    if (!perStep) {
      if (preset === "existing") {
        if (!existingTerm) return;
        onRun({ mode: "existing", termId: existingTerm, ...base });
      } else {
        onRun({ mode: preset, ...base });
      }
      return;
    }
    const inherit = preset === "existing" ? existingTerm || "new" : "new";
    const a: Record<string, string> = {};
    for (const s of steps) {
      const v = assign[s.id] ?? "inherit";
      a[s.id] = v === "inherit" ? inherit : v;
    }
    onRun({ mode: "per-step", assign: a, ...base });
  };

  const MODES = [
    { k: "each-new", t: "각각 새 세션", s: "병렬 실행, 의존 순서는 지킴" },
    { k: "one-new", t: "하나의 새 세션", s: "한 세션에서 순차 실행" },
    { k: "existing", t: "기존 세션", s: "이미 떠 있는 세션에 보내기" },
  ] as const;

  return (
    <div className="plan-rd-overlay" onMouseDown={onClose}>
      <div className="plan-rd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plan-rd-head">
          <span className="plan-rd-count">{steps.length}</span> 개 단계 실행
        </div>

        {/* worktree mode — recommended for plans */}
        <button
          type="button"
          className={`plan-rd-wtcard ${worktree ? "on" : ""} ${wtDisabled ? "disabled" : ""}`}
          disabled={wtDisabled}
          onClick={() => !wtDisabled && setWorktree((w) => !w)}
        >
          <span className="plan-rd-wticon">⎇</span>
          <span className="plan-rd-wtbody">
            <span className="plan-rd-wttitle">
              git worktree 모드
              {wtDisabled ? (
                <span className="plan-rd-tag off">사용 불가</span>
              ) : (
                <span className="plan-rd-tag">추천</span>
              )}
            </span>
            <span className="plan-rd-wtsub">
              {wtDisabled ? (
                "이 폴더는 git 저장소가 아니라 worktree 모드를 쓸 수 없어요. (git init 후 사용 가능)"
              ) : gitRepo === null ? (
                "git 저장소 확인 중…"
              ) : (
                <>
                  단계마다 자체 worktree에서 실행 → 커밋·통합 브랜치 병합 →{" "}
                  <b>완료되면 현재 브랜치로 자동 병합</b>. 충돌은 Claude가 해결.
                </>
              )}
            </span>
          </span>
          {!wtDisabled && (
            <span className={`plan-rd-toggle ${worktree ? "on" : ""}`}>
              <span className="plan-rd-knob" />
            </span>
          )}
        </button>

        {/* where to run (non-worktree) */}
        <div className={`plan-rd-modes ${worktree ? "dim" : ""}`}>
          <div className="plan-rd-modes-label">실행 위치</div>
          {MODES.map((m) => (
            <button
              type="button"
              key={m.k}
              className={`plan-rd-card ${!worktree && preset === m.k ? "sel" : ""}`}
              disabled={worktree}
              onClick={() => setPreset(m.k)}
            >
              <span className={`plan-rd-radio ${preset === m.k ? "on" : ""}`} />
              <span className="plan-rd-cardbody">
                <span className="plan-rd-cardtitle">{m.t}</span>
                <span className="plan-rd-cardsub">{m.s}</span>
              </span>
              {m.k === "existing" && preset === "existing" && (
                <select
                  className="plan-rd-sel"
                  value={existingTerm}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setExistingTerm(e.target.value)}
                >
                  {terminals.length === 0 && <option value="">(세션 없음)</option>}
                  {terminals.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} {statuses[t.id] ? `· ${statuses[t.id]}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </button>
          ))}

          <label className="plan-rd-perstep">
            <input
              type="checkbox"
              checked={perStep}
              disabled={worktree}
              onChange={(e) => setPerStep(e.target.checked)}
            />
            단계별로 개별 지정
          </label>
          {!worktree && perStep && (
            <div className="plan-rd-list">
              {steps.map((s) => (
                <div key={s.id} className="plan-rd-row">
                  <span className="plan-rd-step" title={s.prompt}>
                    {s.title}
                  </span>
                  <select
                    value={assign[s.id] ?? "inherit"}
                    onChange={(e) => setAssign((m) => ({ ...m, [s.id]: e.target.value }))}
                  >
                    <option value="inherit">기본값 따름</option>
                    <option value="new">새 세션</option>
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="plan-rd-switch">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>자동 승인 — 새 세션을 권한 확인(Enter) 없이 진행</span>
        </label>

        <div className="plan-rd-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" onClick={run}>
            {worktree ? "worktree로 실행" : "실행"}
          </button>
        </div>
      </div>
    </div>
  );
}
