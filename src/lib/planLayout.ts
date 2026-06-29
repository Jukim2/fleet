// Pure layout for the plan graph: a tidy left→right tree (theme → feature →
// step) plus dashed dependency arcs between steps. Geometry only — the view
// computes per-node status/progress. No external graph library.
import { Plan } from "../types";

export const THEME_W = 150;
export const FEAT_W = 158;
export const STEP_W = 210;
export const NODE_H = 46;
export const ROW_GAP = 14;
export const COL_GAP = 56;
export const THEME_GAP = 26; // extra vertical space between themes

const COL_THEME = 0;
const COL_FEAT = THEME_W + COL_GAP;
const COL_STEP = THEME_W + COL_GAP + FEAT_W + COL_GAP;

export type GNodeKind = "theme" | "feature" | "step";
export type GNode = {
  id: string;
  kind: GNodeKind;
  title: string;
  x: number;
  y: number;
  w: number;
};
export type GEdge = { id: string; d: string; kind: "hier" | "dep" };
export type PlanLayout = { nodes: GNode[]; edges: GEdge[]; width: number; height: number };

const widthOf = (k: GNodeKind) => (k === "theme" ? THEME_W : k === "feature" ? FEAT_W : STEP_W);
const cx = (n: GNode) => n.x + n.w;
const cy = (n: GNode) => n.y + NODE_H / 2;

/** Build positioned nodes + edges. `collapsed(id)` hides a node's children. */
export function layoutPlan(plan: Plan, collapsed: (id: string) => boolean): PlanLayout {
  const featByTheme: Record<string, typeof plan.features> = {};
  for (const f of plan.features) (featByTheme[f.themeId] ??= []).push(f);
  const stepByFeat: Record<string, typeof plan.steps> = {};
  for (const s of plan.steps) (stepByFeat[s.featureId] ??= []).push(s);

  const nodes: GNode[] = [];
  const byId: Record<string, GNode> = {};
  const push = (n: GNode) => {
    nodes.push(n);
    byId[n.id] = n;
    return n;
  };
  const place = (id: string, kind: GNodeKind, title: string, x: number, yCenter: number) =>
    push({ id, kind, title, x, y: yCenter - NODE_H / 2, w: widthOf(kind) });

  let cursor = NODE_H / 2; // y of the next leaf's center

  for (const theme of plan.themes) {
    const tCollapsed = collapsed(theme.id);
    const feats = featByTheme[theme.id] ?? [];
    const featCenters: number[] = [];

    if (!tCollapsed) {
      for (const feat of feats) {
        const steps = stepByFeat[feat.id] ?? [];
        const fCollapsed = collapsed(feat.id) || steps.length === 0;
        if (fCollapsed) {
          place(feat.id, "feature", feat.title, COL_FEAT, cursor);
          featCenters.push(cursor);
          cursor += NODE_H + ROW_GAP;
        } else {
          const stepCenters: number[] = [];
          for (const step of steps) {
            place(step.id, "step", step.title, COL_STEP, cursor);
            stepCenters.push(cursor);
            cursor += NODE_H + ROW_GAP;
          }
          const c = avg(stepCenters);
          place(feat.id, "feature", feat.title, COL_FEAT, c);
          featCenters.push(c);
        }
      }
    }

    const themeCenter = featCenters.length ? avg(featCenters) : cursor;
    if (!featCenters.length) cursor += NODE_H + ROW_GAP; // collapsed/empty theme takes a row
    place(theme.id, "theme", theme.title, COL_THEME, themeCenter);
    cursor += THEME_GAP;
  }

  // Edges: hierarchy (theme→feature, feature→step) + deps (step→step).
  const edges: GEdge[] = [];
  const hier = (from: GNode, to: GNode) => {
    const x1 = cx(from);
    const y1 = cy(from);
    const x2 = to.x;
    const y2 = cy(to);
    edges.push({
      id: `h-${from.id}-${to.id}`,
      kind: "hier",
      d: `M${x1},${y1} C${x1 + COL_GAP / 2},${y1} ${x2 - COL_GAP / 2},${y2} ${x2},${y2}`,
    });
  };
  for (const f of plan.features) {
    const t = byId[f.themeId];
    const fn = byId[f.id];
    if (t && fn) hier(t, fn);
  }
  for (const s of plan.steps) {
    const f = byId[s.featureId];
    const sn = byId[s.id];
    if (f && sn) hier(f, sn);
    // deps: bow out to the right of the step column so same-column links stay legible
    for (const dep of s.deps) {
      const dn = byId[dep];
      if (!dn || !sn) continue;
      const x = cx(sn);
      const y1 = cy(dn);
      const y2 = cy(sn);
      const bow = 34 + Math.min(60, Math.abs(y2 - y1) / 3);
      edges.push({
        id: `d-${dep}-${s.id}`,
        kind: "dep",
        d: `M${x},${y1} C${x + bow},${y1} ${x + bow},${y2} ${x},${y2}`,
      });
    }
  }

  // dep arcs bow out to the right of the step column (up to ~94px); leave room so
  // they aren't clipped by the scroll area.
  const width = COL_STEP + STEP_W + 130;
  const height = Math.max(NODE_H, cursor) + ROW_GAP;
  return { nodes, edges, width, height };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
