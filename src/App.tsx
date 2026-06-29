import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectRail from "./features/projects/ProjectRail";
import ProjectView from "./features/terminals/ProjectView";
import CommandPalette from "./features/blocks/CommandPalette";
import Drawer from "./features/drawer/Drawer";
import QueueBoard from "./features/board/QueueBoard";
import SettingsPanel from "./features/settings/SettingsPanel";
import WebPanel from "./features/web/WebPanel";
import PlanView from "./features/plan/PlanView";
import { ensureHookInstalled } from "./api/pty";
import { wtProgress } from "./lib/worktree";
import { checkForUpdate, UpdateAvailable } from "./api/system";
import { useFleet } from "./hooks/useFleet";

export default function App() {
  const f = useFleet();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchUpdate, setLaunchUpdate] = useState<UpdateAvailable | null>(null);

  // One-shot update check on launch; surfaces a pill if a new version is out.
  useEffect(() => {
    checkForUpdate().then(setLaunchUpdate).catch(() => {});
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

  const openDrawer = (section: "blocks" | "queue") => {
    if (section === "queue") {
      setBoardOpen(true);
      return;
    }
    setDrawerOpen(true);
  };

  const activeProject = f.config.projects.find((p) => p.id === f.activeProjectId) ?? null;
  const activeBoard = f.activeProjectId
    ? f.config.boards[f.activeProjectId] ?? { running: false, lanes: [], tasks: [] }
    : null;

  return (
    <div className={`app ${drawerOpen ? "drawer-open" : ""}`}>
      <ProjectRail
        projects={f.config.projects}
        activeId={f.activeProjectId}
        liveByProject={f.liveByProject}
        projectStatus={f.projectStatus}
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
      />

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
                onStatus={f.setStatus}
                onOpenPalette={() => setPaletteOpen(true)}
                onOpenDrawer={openDrawer}
                onOpenWeb={() => setWebOpen(true)}
                onOpenPlan={() => setPlanOpen(true)}
                wtActive={f.wtRuns[p.id] ? wtProgress(f.wtRuns[p.id]) : undefined}
              />
            ))
        )}
      </main>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        blocks={f.config.blocks}
        onChangeBlocks={f.setBlocks}
      />

      {boardOpen && activeProject && activeBoard && (
        <QueueBoard
          project={activeProject}
          terminals={f.config.terminals.filter((t) => t.projectId === activeProject.id)}
          statuses={f.statuses}
          board={activeBoard}
          taskStatus={f.taskStatus}
          blocks={f.config.blocks}
          projects={f.config.projects}
          boards={f.config.boards}
          allTerminals={f.config.terminals}
          onClose={() => setBoardOpen(false)}
          onAddLane={(target, title) => f.addLane(activeProject.id, target, title)}
          onRemoveLane={(laneId) => f.removeLane(activeProject.id, laneId)}
          onAddTask={(laneId, text) => f.addTask(activeProject.id, laneId, text)}
          onRemoveTask={(taskId) => f.removeTask(activeProject.id, taskId)}
          onSetDeps={(taskId, deps) => f.setTaskDeps(activeProject.id, taskId, deps)}
          onAddBlock={(text) =>
            f.setBlocks([...f.config.blocks, { id: crypto.randomUUID(), name: text.slice(0, 24), text }])
          }
          onToggleRunningProject={f.toggleBoardRunning}
          onResetProject={f.resetBoard}
          onOpenProject={f.selectProject}
          onAddProject={pickFolder}
        />
      )}

      {planOpen && activeProject && (
        <PlanView
          project={activeProject}
          plan={f.config.plans[activeProject.id]}
          taskStatus={f.taskStatus}
          statuses={f.statuses}
          terminals={f.config.terminals.filter((t) => t.projectId === activeProject.id)}
          planning={f.planning === activeProject.id}
          onRequestPlan={(goal) => f.requestPlan(activeProject.id, goal)}
          onLoadPlan={() => f.loadPlan(activeProject.id)}
          onRunSteps={(stepIds, target) => f.runSteps(activeProject.id, stepIds, target)}
          onToggleCollapse={(nodeId, current) => f.toggleCollapsed(activeProject.id, nodeId, current)}
          onRemovePlan={() => f.removePlan(activeProject.id)}
          onAddTheme={() => f.addTheme(activeProject.id)}
          onAddFeature={(themeId) => f.addFeature(activeProject.id, themeId)}
          onAddStep={(featureId) => f.addStep(activeProject.id, featureId)}
          onRenameNode={(id, title) => f.renameNode(activeProject.id, id, title)}
          onEditStep={(id, patch) => f.editStep(activeProject.id, id, patch)}
          onRemoveNode={(id) => f.removePlanNode(activeProject.id, id)}
          wtRun={f.wtRuns[activeProject.id]}
          wtLastRun={f.wtLastRun[activeProject.id]}
          wtMsg={f.wtMsg[activeProject.id]}
          wtFix={f.wtFix[activeProject.id]}
          onResolveFinalize={() => f.resolveFinalize(activeProject.id)}
          cardScale={f.config.planCardScale ?? 1}
          onSetCardScale={f.setPlanCardScale}
          onStopWtRun={() => f.stopWtRun(activeProject.id)}
          onClearWtLastRun={() => f.clearWtLastRun(activeProject.id)}
          onShowStep={(termId) => f.showWtStep(activeProject.id, termId)}
          onClearWtMsg={() => f.clearWtMsg(activeProject.id)}
          onClose={() => setPlanOpen(false)}
        />
      )}

      {webOpen && (
        <WebPanel
          webTabs={f.config.webTabs}
          onClose={() => setWebOpen(false)}
          onAdd={f.addWebTab}
          onRemove={f.removeWebTab}
          onOpen={f.openTab}
          onOpenAll={f.openAllWebTabs}
          onSend={f.sendToWebTab}
          onBroadcast={f.broadcastToWebTabs}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        blocks={f.config.blocks}
        hasTarget={!!f.focusedTermId}
        onClose={() => setPaletteOpen(false)}
        onSend={f.sendBlock}
        onBroadcast={f.broadcastBlock}
      />

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          projects={f.config.projects}
          onRelink={relinkProject}
          onReinstallHooks={ensureHookInstalled}
        />
      )}

      {launchUpdate && !settingsOpen && (
        <button className="update-pill" onClick={() => setSettingsOpen(true)}>
          새 버전 <b>v{launchUpdate.version}</b> 사용 가능 · 설치
        </button>
      )}
    </div>
  );
}
