import { useEffect, useState } from "react";
import { listClaudeSessions } from "../api/claude";
import { ClaudeSession, Project } from "../types";

/** Loads (and caches) the resumable Claude sessions for the active project. */
export function useClaudeSessions(activeProjectId: string | null, projects: Project[]) {
  const [byProject, setByProject] = useState<Record<string, ClaudeSession[]>>({});
  const [loading, setLoading] = useState(false);

  const load = async (projectId: string, force = false) => {
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return;
    if (!force && byProject[projectId]) return;
    setLoading(true);
    try {
      const list = await listClaudeSessions(proj.path);
      setByProject((s) => ({ ...s, [projectId]: list }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeProjectId) load(activeProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projects.length]);

  return {
    sessions: activeProjectId ? byProject[activeProjectId] ?? null : null,
    loading,
    refresh: () => activeProjectId && load(activeProjectId, true),
  };
}
