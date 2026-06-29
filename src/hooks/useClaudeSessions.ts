import { useCallback, useEffect, useRef, useState } from "react";
import { deleteClaudeSession, listClaudeSessions } from "../api/claude";
import { ClaudeSession, Project } from "../types";

/** Loads (and caches) the resumable Claude sessions for the active project. */
export function useClaudeSessions(activeProjectId: string | null, projects: Project[]) {
  const [byProject, setByProject] = useState<Record<string, ClaudeSession[]>>({});
  const [loading, setLoading] = useState(false);

  // Keep latest projects/activeId in refs so the load/refresh callbacks can stay
  // stable — useFleet wires `refresh` into an effect, and a new identity each
  // render would make that effect churn.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // Mirror of byProject for the cache check inside the stable `load` callback.
  const byProjectRef = useRef(byProject);
  byProjectRef.current = byProject;

  const load = useCallback(
    // `silent` skips the loading-spinner toggle — used by the periodic poll so
    // the list refreshes without flicker.
    async (projectId: string, force = false, silent = false) => {
      const proj = projectsRef.current.find((p) => p.id === projectId);
      if (!proj) return;
      if (!force && byProjectRef.current[projectId]) return; // already cached
      if (!silent) setLoading(true);
      try {
        const list = await listClaudeSessions(proj.path);
        setByProject((s) => ({ ...s, [projectId]: list }));
      } catch (e) {
        // Don't leave `sessions` as null on error — that renders a blank panel
        // (no loading, no empty-state, no rows). Fall back to an empty list so
        // the "저장된 세션이 없어요" message shows, and surface the cause.
        console.error("[fleet] list_claude_sessions failed:", e);
        setByProject((s) => ({ ...s, [projectId]: [] }));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeProjectId) load(activeProjectId);
  }, [activeProjectId, projects.length, load]);

  // Periodically re-scan the active project's transcripts so newly created or
  // updated sessions show up without a manual refresh.
  useEffect(() => {
    if (!activeProjectId) return;
    const id = setInterval(() => load(activeProjectId, true, true), 30_000);
    return () => clearInterval(id);
  }, [activeProjectId, load]);

  const refresh = useCallback(() => {
    if (activeProjectId) load(activeProjectId, true);
  }, [activeProjectId, load]);

  const remove = useCallback(
    async (session: ClaudeSession) => {
      if (!activeProjectId) return;
      const proj = projectsRef.current.find((p) => p.id === activeProjectId);
      if (!proj) return;
      const pid = activeProjectId;
      // Optimistically drop the row; re-sync from disk if the delete fails.
      setByProject((s) => ({
        ...s,
        [pid]: (s[pid] ?? []).filter((x) => x.id !== session.id),
      }));
      try {
        await deleteClaudeSession(proj.path, session.id);
      } catch (e) {
        console.error("[fleet] delete_claude_session failed:", e);
        load(pid, true);
      }
    },
    [activeProjectId, load],
  );

  return {
    sessions: activeProjectId ? byProject[activeProjectId] ?? null : null,
    loading,
    refresh,
    remove,
  };
}
