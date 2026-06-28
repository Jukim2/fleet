import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectRail from "./features/projects/ProjectRail";
import ProjectView from "./features/terminals/ProjectView";
import CommandPalette from "./features/blocks/CommandPalette";
import Drawer from "./features/drawer/Drawer";
import QueueBoard from "./features/board/QueueBoard";
import { useFleet } from "./hooks/useFleet";

type DrawerSection = "blocks" | "schedule";

export default function App() {
  const f = useFleet();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSection, setDrawerSection] = useState<DrawerSection>("blocks");
  const [boardOpen, setBoardOpen] = useState(false);

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

  const pickFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "프로젝트 폴더 선택" });
    if (picked && typeof picked === "string") f.addProject(picked);
  };

  const openDrawer = (section: "blocks" | "queue" | "schedule") => {
    if (section === "queue") {
      setBoardOpen(true);
      return;
    }
    setDrawerSection(section);
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
        sessions={f.sessions}
        sessionsLoading={f.sessionsLoading}
        onSelect={f.selectProject}
        onAdd={pickFolder}
        onRemove={f.removeProject}
        onReorder={f.reorderProjects}
        onRefreshSessions={f.refreshSessions}
        onResume={f.resume}
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
              />
            ))
        )}
      </main>

      <Drawer
        open={drawerOpen}
        section={drawerSection}
        setSection={setDrawerSection}
        onClose={() => setDrawerOpen(false)}
        blocks={f.config.blocks}
        onChangeBlocks={f.setBlocks}
        projects={f.config.projects}
        schedules={f.config.schedules}
        onChangeSchedules={f.setSchedules}
      />

      {boardOpen && activeProject && activeBoard && (
        <QueueBoard
          project={activeProject}
          terminals={f.config.terminals.filter((t) => t.projectId === activeProject.id)}
          statuses={f.statuses}
          board={activeBoard}
          taskStatus={f.taskStatus}
          blocks={f.config.blocks}
          onClose={() => setBoardOpen(false)}
          onAddLane={(tid) => f.addLane(activeProject.id, tid)}
          onRemoveLane={(tid) => f.removeLane(activeProject.id, tid)}
          onAddTask={(tid, text) => f.addTask(activeProject.id, tid, text)}
          onRemoveTask={(taskId) => f.removeTask(activeProject.id, taskId)}
          onSetDeps={(taskId, deps) => f.setTaskDeps(activeProject.id, taskId, deps)}
          onAddBlock={(text) =>
            f.setBlocks([...f.config.blocks, { id: crypto.randomUUID(), name: text.slice(0, 24), text }])
          }
          onToggleRunning={() => f.toggleBoardRunning(activeProject.id)}
          onReset={() => f.resetBoard(activeProject.id)}
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
    </div>
  );
}
