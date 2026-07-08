import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ProjectRail from "./features/projects/ProjectRail";
import ProjectView from "./features/terminals/ProjectView";
import TermPortals from "./features/terminals/TermPortals";
import CommandPalette from "./features/blocks/CommandPalette";
import Drawer from "./features/drawer/Drawer";
import AttentionPeek, { AttentionItem } from "./features/attention/AttentionPeek";
import OverviewPanel, { OverviewGroup } from "./features/overview/OverviewPanel";
import SettingsPanel from "./features/settings/SettingsPanel";
import WebPanel from "./features/web/WebPanel";
import PlanView from "./features/plan/PlanView";
import "./features/presets/presets.css";
import { ensureHookInstalled } from "./api/pty";
import { wtProgress } from "./lib/worktree";
import { checkForUpdate, UpdateAvailable } from "./api/system";
import { useFleet } from "./hooks/useFleet";

export default function App() {
  const f = useFleet();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchUpdate, setLaunchUpdate] = useState<UpdateAvailable | null>(null);

  // One-shot update check on launch; surfaces a pill if a new version is out.
  useEffect(() => {
    checkForUpdate().then(setLaunchUpdate).catch(() => {});
  }, []);

  // An OS file dropped outside a pane would make the webview NAVIGATE to the
  // file (blank window). Panes handle their own drops in the target phase;
  // this window-level catch just neutralizes the misses.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Keep the latest store in a ref so the global key handler stays subscription-stable.
  const fRef = useRef(f);
  fRef.current = f;

  // Global shortcuts: ⌘K palette · ⌘T new terminal · ⌘W close · ⌘1–9 switch project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const fl = fRef.current;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (k === "j") {
        e.preventDefault();
        // ⌘J quick triage peek · ⌘⇧J the full cross-project overview
        if (e.shiftKey) setOverviewOpen((o) => !o);
        else setPeekOpen((o) => !o);
      } else if (k === "t" && fl.activeProjectId) {
        e.preventDefault();
        fl.newTerm(fl.activeProjectId, "claude", "Claude");
      } else if (k === "w" && fl.activeProjectId && fl.focusedTermId) {
        e.preventDefault();
        fl.closeTerm(fl.activeProjectId, fl.focusedTermId);
      } else if (k >= "1" && k <= "9") {
        const p = fl.config.projects[Number(k) - 1];
        if (p) {
          e.preventDefault();
          fl.selectProject(p.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pickFolder = async (): Promise<boolean> => {
    const picked = await open({ directory: true, multiple: false, title: "프로젝트 폴더 선택" });
    if (picked && typeof picked === "string") {
      f.addProject(picked);
      return true;
    }
    return false;
  };

  const relinkProject = async (projectId: string) => {
    const picked = await open({ directory: true, multiple: false, title: "폴더 다시 연결" });
    if (picked && typeof picked === "string") f.relinkProject(projectId, picked);
  };

  const activeProject = f.config.projects.find((p) => p.id === f.activeProjectId) ?? null;

  // Live sessions across every project, sorted so the ones needing you surface
  // first (waiting → done/idle → busy). Feeds the ⌘J attention peek.
  const attentionItems = useMemo<AttentionItem[]>(() => {
    const rank: Record<string, number> = { waiting: 0, idle: 1, busy: 2 };
    const nameOf = (pid: string) => f.config.projects.find((p) => p.id === pid)?.name ?? "";
    return f.config.terminals
      .map((t) => ({ t, status: f.statuses[t.id] }))
      .filter((x) => x.status && x.status !== "stopped")
      .map(({ t, status }) => ({
        projectId: t.projectId,
        projectName: nameOf(t.projectId),
        termId: t.id,
        title: t.title,
        status: status!,
        activity: f.activity[t.id],
      }))
      .sort((a, b) => rank[a.status] - rank[b.status]);
  }, [f.config.terminals, f.config.projects, f.statuses, f.activity]);

  // Every terminal (any status), for the ⌘K palette's cross-project "jump to…".
  const jumpItems = useMemo<AttentionItem[]>(() => {
    const nameOf = (pid: string) => f.config.projects.find((p) => p.id === pid)?.name ?? "";
    return f.config.terminals.map((t) => ({
      projectId: t.projectId,
      projectName: nameOf(t.projectId),
      termId: t.id,
      title: t.title,
      status: f.statuses[t.id] ?? "stopped",
      activity: f.activity[t.id],
    }));
  }, [f.config.terminals, f.config.projects, f.statuses, f.activity]);

  // Per-project session groups + plan/board progress for the ⌘⇧J overview.
  const overviewGroups = useMemo<OverviewGroup[]>(() => {
    const rank: Record<string, number> = { waiting: 0, idle: 1, busy: 2, stopped: 3 };
    return f.config.projects.map((p) => {
      const sessions = f.config.terminals
        .filter((t) => t.projectId === p.id)
        .map((t) => ({
          projectId: p.id,
          projectName: p.name,
          termId: t.id,
          title: t.title,
          status: f.statuses[t.id] ?? "stopped",
          activity: f.activity[t.id],
        }))
        .sort((a, b) => rank[a.status] - rank[b.status]);
      const plan = f.config.plans[p.id];
      const total = plan?.steps.length ?? 0;
      const done = total ? plan!.steps.filter((s) => plan!.completed?.[s.id]).length : 0;
      return {
        projectId: p.id,
        projectName: p.name,
        sessions,
        plan: total > 0 ? { done, total } : undefined,
        boardRunning: !!f.config.boards[p.id]?.running,
      };
    });
  }, [f.config.projects, f.config.terminals, f.config.plans, f.config.boards, f.statuses, f.activity]);

  const overviewCounts = useMemo(() => {
    const c = { waiting: 0, busy: 0, idle: 0 };
    for (const it of attentionItems) {
      if (it.status === "waiting") c.waiting++;
      else if (it.status === "busy") c.busy++;
      else if (it.status === "idle") c.idle++;
    }
    return c;
  }, [attentionItems]);

  // Reflect the number of sessions awaiting approval in the window title (and dock/
  // taskbar badge where supported) so you know even when Fleet isn't focused.
  const waitingTotal = attentionItems.filter((i) => i.status === "waiting").length;
  useEffect(() => {
    const w = getCurrentWindow();
    w.setTitle(waitingTotal > 0 ? `Fleet · 승인 대기 ${waitingTotal}` : "Fleet").catch(() => {});
    const anyW = w as unknown as { setBadgeCount?: (n?: number) => Promise<void> };
    anyW.setBadgeCount?.(waitingTotal || undefined)?.catch?.(() => {});
  }, [waitingTotal]);

  return (
    <div className={`app ${railOpen ? "rail-open" : ""} ${drawerOpen ? "drawer-open" : ""}`}>
      <div className="rail-slot" aria-hidden={!railOpen}>
        <ProjectRail
          projects={f.config.projects}
          activeId={f.activeProjectId}
          liveByProject={f.liveByProject}
          projectStatus={f.projectStatus}
          waitingByProject={f.waitingByProject}
          sessions={f.sessions}
          sessionsLoading={f.sessionsLoading}
          onSelect={f.selectProject}
          onAdd={pickFolder}
          onRemove={f.removeProject}
          onReorder={f.reorderProjects}
          onRefreshSessions={f.refreshSessions}
          onResume={f.resume}
          onDeleteSession={f.deleteSession}
          openSessionTerm={f.openSessionTerm}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenOverview={() => setOverviewOpen(true)}
          onCollapse={() => setRailOpen(false)}
        />
      </div>
      {!railOpen && (
        <button className="edge-toggle left" title="사이드바 열기" onClick={() => setRailOpen(true)}>
          ›
        </button>
      )}

      <main className="stage-wrap">
        {f.config.projects.length === 0 ? (
          <div className="welcome">
            <h1>Fleet</h1>
            <p>폴더를 추가하면 그 안에서 여러 터미널과 claude 세션을 관리할 수 있어요.</p>
            <button className="primary" onClick={pickFolder}>
              ＋ 폴더 추가
            </button>
          </div>
        ) : (
          f.config.projects
            .filter((p) => f.visited[p.id])
            .map((p) => (
              <ProjectView
                key={p.id}
                project={p}
                terminals={f.config.terminals.filter((t) => t.projectId === p.id)}
                layout={f.config.layouts[p.id]}
                focusedPaneId={f.focusedPane[p.id] ?? null}
                statuses={f.statuses}
                visible={p.id === f.activeProjectId}
                onActivateTerm={(tid) => f.activateTerm(p.id, tid)}
                onReorderTerms={f.reorderTerms}
                onNewTerm={(startup, title) => f.newTerm(p.id, startup, title)}
                onCloseTerm={(tid) => f.closeTerm(p.id, tid)}
                onRenameTerm={f.renameTerm}
                onFocusPane={(paneId) => f.focusPane(p.id, paneId)}
                onSetRatio={(splitId, ratio) => f.setPaneRatio(p.id, splitId, ratio)}
                onSplit={(paneId, dir) => f.splitPane(p.id, paneId, dir)}
                onClosePane={(paneId) => f.closePane(p.id, paneId)}
                onSetLeafTerm={(paneId, tid) => f.setLeafTermAt(p.id, paneId, tid)}
                onSplitWithTerm={(paneId, dir, before, tid) =>
                  f.splitWithTerm(p.id, paneId, dir, before, tid)
                }
                onMovePane={(source, target, zone) => f.movePane(p.id, source, target, zone)}
                onOpenWeb={() => setWebOpen(true)}
                onOpenPlan={() => setPlanOpen(true)}
                presetsOpen={drawerOpen}
                onTogglePresets={() => setDrawerOpen((o) => !o)}
                wtActive={f.wtRuns[p.id] ? wtProgress(f.wtRuns[p.id]) : undefined}
              />
            ))
        )}
        {/* Every terminal's xterm lives here exactly once (portaled into its
            dock container) and moves between pane floats and live-canvas nodes
            without remounting. */}
        <TermPortals
          terminals={f.config.terminals}
          projects={f.config.projects}
          visited={f.visited}
          woken={f.woken}
          onStatus={f.setStatus}
          onNotice={f.pushToast}
        />
      </main>

      <div className="drawer-slot" aria-hidden={!drawerOpen}>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        presets={f.config.presets}
        bodies={activeProject ? f.config.presetBodies[activeProject.id] ?? {} : {}}
        presetGen={f.presetGen}
        onRun={(presetId) => activeProject && f.runPreset(activeProject.id, presetId)}
        onAddPreset={(name, kind, description, body) =>
          f.addPreset(name, kind, description, activeProject?.id, body)
        }
        onUpdatePreset={(presetId, patch) => f.updatePreset(presetId, patch)}
        onRemovePreset={(presetId) => f.removePreset(presetId)}
        onSetBody={(presetId, body) =>
          activeProject && f.setPresetBody(activeProject.id, presetId, body)
        }
        onGenerate={(presetId) => activeProject && f.generatePresetBody(activeProject.id, presetId)}
      />
      </div>

      {planOpen && activeProject && (
        <PlanView
          project={activeProject}
          plan={f.config.plans[activeProject.id]}
          taskStatus={f.taskStatus}
          statuses={f.statuses}
          terminals={f.config.terminals.filter((t) => t.projectId === activeProject.id)}
          planning={f.planning === activeProject.id}
          onRequestPlan={(goal) => f.requestPlan(activeProject.id, goal)}
          notes={f.config.notes[activeProject.id] ?? []}
          onAddNote={(text) => f.addNote(activeProject.id, text)}
          onEditNote={(id, text) => f.editNote(activeProject.id, id, text)}
          onRemoveNote={(id) => f.removeNote(activeProject.id, id)}
          onPlanFromNotes={(ids) => f.planFromNotes(activeProject.id, ids)}
          notesUi={{ open: f.config.planNotesOpen ?? true, width: f.config.planNotesW ?? 340 }}
          onSetNotesUi={f.setPlanNotesUi}
          onRunSteps={(stepIds, target) => f.runSteps(activeProject.id, stepIds, target)}
          onToggleCollapse={(nodeId, current) => f.toggleCollapsed(activeProject.id, nodeId, current)}
          onRemovePlan={() => f.removePlan(activeProject.id)}
          onAddTheme={() => f.addTheme(activeProject.id)}
          onAddFeature={(themeId) => f.addFeature(activeProject.id, themeId)}
          onAddStep={(featureId) => f.addStep(activeProject.id, featureId)}
          onRenameNode={(id, title) => f.renameNode(activeProject.id, id, title)}
          onEditStep={(id, patch) => f.editStep(activeProject.id, id, patch)}
          onRemoveNode={(id) => f.removePlanNode(activeProject.id, id)}
          onSetStepDeps={(stepId, deps) => f.setStepDeps(activeProject.id, stepId, deps)}
          onSetStepFeature={(stepId, featureId) =>
            f.setStepFeature(activeProject.id, stepId, featureId)
          }
          wtRun={f.wtRuns[activeProject.id]}
          wtLastRun={f.wtLastRun[activeProject.id]}
          wtMsg={f.wtMsg[activeProject.id]}
          wtFix={f.wtFix[activeProject.id]}
          onResolveFinalize={() => f.resolveFinalize(activeProject.id)}
          cardScale={f.config.planCardScale ?? 1}
          onSetCardScale={f.setPlanCardScale}
          board={f.config.boards[activeProject.id]}
          savedView={f.config.planViews?.[activeProject.id]}
          onSetView={(v) => f.setPlanView(activeProject.id, v)}
          focusIds={
            ((raw) => (Array.isArray(raw) ? raw : raw ? [raw] : []))(
              f.config.planFocus?.[activeProject.id],
            )
          }
          onSetFocus={(ids) => f.setPlanFocus(activeProject.id, ids)}
          dir={f.config.planDir ?? "LR"}
          sort={f.config.planSort ?? "added"}
          onSetDir={f.setPlanDir}
          onSetSort={f.setPlanSort}
          onJumpToStep={(termId) => {
            f.showWtStep(activeProject.id, termId);
            setPlanOpen(false);
          }}
          onStopWtRun={() => f.stopWtRun(activeProject.id)}
          onStopBoardRun={() => f.stopBoardRun(activeProject.id)}
          onClearWtLastRun={() => f.clearWtLastRun(activeProject.id)}
          onClearWtMsg={() => f.clearWtMsg(activeProject.id)}
          live={{
            projects: f.config.projects,
            terminals: f.config.terminals,
            statuses: f.statuses,
            activity: f.activity,
            liveTool: f.liveTool,
            manifests: f.toolManifests,
            liveCanvas: f.config.liveCanvas,
            onPlaceFrames: f.placeLiveFrames,
            onRemoveFrame: f.removeLiveFrame,
            onMoveNode: f.moveLiveNode,
            onSetCanvasView: f.setLiveCanvasView,
            onSetSideW: f.setLiveSideW,
            onNewSession: (pid) => f.wakeTerm(f.newTerm(pid, "claude", "Claude")),
            onNewShell: (pid) => f.wakeTerm(f.newTerm(pid, "", "셸")),
            onWakeTerm: f.wakeTerm,
            onResumeSession: f.resumeInto,
            onCloseTerm: f.closeTerm,
            onJumpTerm: (pid, tid) => {
              f.jumpToTerm(pid, tid);
              setPlanOpen(false);
            },
            onDismissLiveTool: f.dismissLiveTool,
          }}
          onClose={() => setPlanOpen(false)}
        />
      )}

      {webOpen && (
        <WebPanel
          webTabs={f.config.webTabs}
          artifacts={f.artifacts}
          onClose={() => setWebOpen(false)}
          onAdd={f.addWebTab}
          onRemove={f.removeWebTab}
          onOpen={f.openTab}
          onOpenAll={f.openAllWebTabs}
          onSend={f.sendToWebTab}
          onBroadcast={f.broadcastToWebTabs}
          onOpenArtifact={f.openArtifact}
          onClearArtifacts={f.clearArtifacts}
        />
      )}

      <AttentionPeek
        open={peekOpen}
        items={attentionItems}
        onJump={f.jumpToTerm}
        onClose={() => setPeekOpen(false)}
      />

      <OverviewPanel
        open={overviewOpen}
        groups={overviewGroups}
        counts={overviewCounts}
        onJump={f.jumpToTerm}
        onSelectProject={f.selectProject}
        onClose={() => setOverviewOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        presets={f.config.presets}
        bodies={activeProject ? f.config.presetBodies[activeProject.id] ?? {} : {}}
        jumpItems={jumpItems}
        activeProjectId={f.activeProjectId}
        onClose={() => setPaletteOpen(false)}
        onRun={(presetId) => activeProject && f.runPreset(activeProject.id, presetId)}
        onJump={f.jumpToTerm}
      />

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          projects={f.config.projects}
          onRelink={relinkProject}
          onReinstallHooks={ensureHookInstalled}
          manifests={f.toolManifests}
          toolRoots={f.config.toolRoots ?? {}}
          customToolIds={Object.keys(f.config.customTools ?? {})}
          onAddCustomTool={f.addCustomTool}
          onRemoveCustomTool={f.removeCustomTool}
          onScanTools={f.scanProjectTools}
          onRegisterToolViaAI={f.registerToolViaAI}
          onCloseAfterAction={() => setSettingsOpen(false)}
        />
      )}

      {launchUpdate && !settingsOpen && (
        <button className="update-pill" onClick={() => setSettingsOpen(true)}>
          새 버전 <b>v{launchUpdate.version}</b> 사용 가능 · 설치
        </button>
      )}

      {f.toasts.length > 0 && (
        <div className="toast-wrap">
          {f.toasts.map((t) => (
            <div
              key={t.id}
              className={`toast ${t.kind} ${t.action ? "clickable" : ""}`}
              onClick={
                t.action
                  ? () => {
                      f.jumpToTerm(t.action!.projectId, t.action!.termId);
                      f.dismissToast(t.id);
                    }
                  : undefined
              }
            >
              <span className="toast-text">{t.text}</span>
              {t.action && <span className="toast-go">이동 ›</span>}
              <button
                className="toast-x"
                onClick={(e) => {
                  e.stopPropagation();
                  f.dismissToast(t.id);
                }}
                title="닫기"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
