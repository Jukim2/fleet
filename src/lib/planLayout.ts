// Pure layout for the plan graph: a tidy tree (대블럭 → 중블럭 → 소블럭) plus
// dashed dependency arcs between 소블럭s. The flow direction (LR/RL/TB/BT) and
// sibling order are configurable. Geometry only — the view computes per-node
// status/progress. No external graph library.
import { Plan, PlanDir, PlanSort } from "../types";

export const THEME_W = 150;
export const FEAT_W = 158;
export const STEP_W = 210;
export const NODE_H = 46;
/** Step nodes are taller so the instruction (지시문) shows inline under the title. */
export const STEP_H = 104;
export const ROW_GAP = 14; // gap between siblings (cross axis)
export const COL_GAP = 56; // gap between hierarchy levels (depth axis)
export const THEME_GAP = 26; // extra space between 대블럭s

export type GNodeKind = "theme" | "feature" | "step";
export type GNode = {
  id: string;
  kind: GNodeKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type GEdge = {
  id: string;
  d: string;
  kind: "hier" | "dep";
  /** for dep edges only: the prerequisite step (`from`) and the dependent step (`to`) */
  from?: string;
  to?: string;
};
export type PlanLayout = { nodes: GNode[]; edges: GEdge[]; width: number; height: number };

const BOW_PAD = 130; // room reserved on the steps' far side for dep arcs

/** Restrict a plan to the subtrees of `focusIds` — each id is a 대블럭 theme
 *  (its whole subtree) or a 중블럭 feature (just that feature + its 소블럭s).
 *  Multiple ids union their subtrees; a theme focused as a whole wins over a
 *  sibling feature of the same theme. Steps keep only deps that stay inside the
 *  kept set, so dep arcs never point at hidden nodes. Empty/all-stale → whole plan. */
export function focusPlan(plan: Plan, focusIds?: string[]): Plan {
  if (!focusIds?.length) return plan;
  const themeSet = new Set(plan.themes.map((t) => t.id));
  const featById = new Map(plan.features.map((f) => [f.id, f]));
  const wholeThemes = new Set<string>(); // themes shown with all their features
  const focusedFeats = new Set<string>(); // individually-focused features
  for (const id of focusIds) {
    if (themeSet.has(id)) wholeThemes.add(id);
    else if (featById.has(id)) focusedFeats.add(id);
  }
  const showThemes = new Set(wholeThemes);
  for (const fid of focusedFeats) showThemes.add(featById.get(fid)!.themeId);
  if (showThemes.size === 0) return plan; // every focused id is stale → show all
  const themes = plan.themes.filter((t) => showThemes.has(t.id));
  const features = plan.features.filter(
    (f) => showThemes.has(f.themeId) && (wholeThemes.has(f.themeId) || focusedFeats.has(f.id)),
  );
  const featIds = new Set(features.map((f) => f.id));
  const kept = plan.steps.filter((s) => featIds.has(s.featureId));
  const stepIds = new Set(kept.map((s) => s.id));
  const steps = kept.map((s) => ({ ...s, deps: s.deps.filter((d) => stepIds.has(d)) }));
  return { ...plan, themes, features, steps };
}

/** Build positioned nodes + edges. `collapsed(id)` hides a node's children.
 *  `scale` enlarges step cards. `dir` is the layout mode; `sort` orders siblings.
 *  `focusIds` (optional) restricts the layout to those 대블럭/중블럭 subtrees.
 *  Single-direction modes use the linear tree; two-sided / radial / grid modes
 *  use the forest layout. */
export function layoutPlan(
  plan: Plan,
  collapsed: (id: string) => boolean,
  scale = 1,
  dir: PlanDir = "LR",
  sort: PlanSort = "added",
  focusIds?: string[],
): PlanLayout {
  const p = focusPlan(plan, focusIds);
  if (dir === "H2" || dir === "V2" || dir === "RAD" || dir === "GRID")
    return layoutForest(p, collapsed, scale, dir, sort);
  return layoutLinear(p, collapsed, scale, dir, sort);
}

/** Single-direction tree (LR/RL/TB/BT). */
function layoutLinear(
  plan: Plan,
  collapsed: (id: string) => boolean,
  scale: number,
  dir: PlanDir,
  sort: PlanSort,
): PlanLayout {
  const stepW = Math.round(STEP_W * scale);
  const stepH = Math.round(STEP_H * scale);
  const widthOf = (k: GNodeKind) => (k === "theme" ? THEME_W : k === "feature" ? FEAT_W : stepW);
  const heightOf = (k: GNodeKind) => (k === "step" ? stepH : NODE_H);

  // depth = along the flow (levels); cross = sibling spread, perpendicular to it
  const horizontal = dir === "LR" || dir === "RL";
  const depthSize = (k: GNodeKind) => (horizontal ? widthOf(k) : heightOf(k));
  const crossSize = (k: GNodeKind) => (horizontal ? heightOf(k) : widthOf(k));

  // depth offset of each level
  const dFeat = depthSize("theme") + COL_GAP;
  const dStep = dFeat + depthSize("feature") + COL_GAP;
  const maxDepth = dStep + depthSize("step");

  // sibling ordering (stable for "added")
  const cmp =
    sort === "title"
      ? (a: { title: string }, b: { title: string }) =>
          (a.title || "").localeCompare(b.title || "", "ko")
      : () => 0;
  const themes = [...plan.themes].sort(cmp);
  const featByTheme: Record<string, typeof plan.features> = {};
  for (const f of plan.features) (featByTheme[f.themeId] ??= []).push(f);
  for (const k in featByTheme) featByTheme[k].sort(cmp);
  const stepByFeat: Record<string, typeof plan.steps> = {};
  for (const s of plan.steps) (stepByFeat[s.featureId] ??= []).push(s);
  for (const k in stepByFeat) stepByFeat[k].sort(cmp);

  const nodes: GNode[] = [];
  const byId: Record<string, GNode> = {};
  // place a node at (depth offset, cross center) in the canonical orientation
  // (root at depth 0); RL/BT are produced by mirroring afterwards.
  const place = (id: string, kind: GNodeKind, title: string, depth: number, crossCenter: number) => {
    const w = widthOf(kind);
    const h = heightOf(kind);
    const crossStart = crossCenter - crossSize(kind) / 2;
    const x = horizontal ? depth : crossStart;
    const y = horizontal ? crossStart : depth;
    const n: GNode = { id, kind, title, x, y, w, h };
    nodes.push(n);
    byId[id] = n;
  };

  let cursor = crossSize("step") / 2; // center of the next leaf along the cross axis

  for (const theme of themes) {
    const tCollapsed = collapsed(theme.id);
    const feats = featByTheme[theme.id] ?? [];
    const featCenters: number[] = [];

    if (!tCollapsed) {
      for (const feat of feats) {
        const steps = stepByFeat[feat.id] ?? [];
        const fCollapsed = collapsed(feat.id) || steps.length === 0;
        if (fCollapsed) {
          place(feat.id, "feature", feat.title, dFeat, cursor);
          featCenters.push(cursor);
          cursor += crossSize("feature") + ROW_GAP;
        } else {
          const stepCenters: number[] = [];
          for (const step of steps) {
            place(step.id, "step", step.title, dStep, cursor);
            stepCenters.push(cursor);
            cursor += crossSize("step") + ROW_GAP;
          }
          const c = avg(stepCenters);
          place(feat.id, "feature", feat.title, dFeat, c);
          featCenters.push(c);
        }
      }
    }

    const themeCenter = featCenters.length ? avg(featCenters) : cursor;
    if (!featCenters.length) cursor += crossSize("feature") + ROW_GAP;
    place(theme.id, "theme", theme.title, 0, themeCenter);
    cursor += THEME_GAP;
  }

  const crossEnd = Math.max(crossSize("step"), cursor) + ROW_GAP;
  const depthEnd = maxDepth + BOW_PAD;
  const width = horizontal ? depthEnd : crossEnd;
  const height = horizontal ? crossEnd : depthEnd;

  // mirror for RL / BT so the root ends up on the far edge (bow padding follows)
  if (dir === "RL") for (const n of nodes) n.x = width - n.x - n.w;
  if (dir === "BT") for (const n of nodes) n.y = height - n.y - n.h;

  // Edges, built from final coords. Hierarchy connects the facing edges of
  // parent/child; deps bow out on the steps' far side along the cross axis.
  const edges: GEdge[] = [];
  const g = COL_GAP / 2;
  const hier = (p: GNode, c: GNode) => {
    let p1, p2, c1, c2;
    if (dir === "LR") {
      p1 = { x: p.x + p.w, y: p.y + p.h / 2 };
      p2 = { x: c.x, y: c.y + c.h / 2 };
      c1 = { x: p1.x + g, y: p1.y };
      c2 = { x: p2.x - g, y: p2.y };
    } else if (dir === "RL") {
      p1 = { x: p.x, y: p.y + p.h / 2 };
      p2 = { x: c.x + c.w, y: c.y + c.h / 2 };
      c1 = { x: p1.x - g, y: p1.y };
      c2 = { x: p2.x + g, y: p2.y };
    } else if (dir === "TB") {
      p1 = { x: p.x + p.w / 2, y: p.y + p.h };
      p2 = { x: c.x + c.w / 2, y: c.y };
      c1 = { x: p1.x, y: p1.y + g };
      c2 = { x: p2.x, y: p2.y - g };
    } else {
      p1 = { x: p.x + p.w / 2, y: p.y };
      p2 = { x: c.x + c.w / 2, y: c.y + c.h };
      c1 = { x: p1.x, y: p1.y - g };
      c2 = { x: p2.x, y: p2.y + g };
    }
    edges.push({
      id: `h-${p.id}-${c.id}`,
      kind: "hier",
      d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`,
    });
  };
  const dep = (dn: GNode, sn: GNode) => {
    let p1, p2, c1, c2;
    if (horizontal) {
      const edgeX = (n: GNode) => (dir === "LR" ? n.x + n.w : n.x);
      const dirSign = dir === "LR" ? 1 : -1;
      p1 = { x: edgeX(dn), y: dn.y + dn.h / 2 };
      p2 = { x: edgeX(sn), y: sn.y + sn.h / 2 };
      const bow = (34 + Math.min(60, Math.abs(p1.y - p2.y) / 3)) * dirSign;
      c1 = { x: p1.x + bow, y: p1.y };
      c2 = { x: p2.x + bow, y: p2.y };
    } else {
      const edgeY = (n: GNode) => (dir === "TB" ? n.y + n.h : n.y);
      const dirSign = dir === "TB" ? 1 : -1;
      p1 = { x: dn.x + dn.w / 2, y: edgeY(dn) };
      p2 = { x: sn.x + sn.w / 2, y: edgeY(sn) };
      const bow = (34 + Math.min(60, Math.abs(p1.x - p2.x) / 3)) * dirSign;
      c1 = { x: p1.x, y: p1.y + bow };
      c2 = { x: p2.x, y: p2.y + bow };
    }
    edges.push({
      id: `d-${dn.id}-${sn.id}`,
      kind: "dep",
      from: dn.id,
      to: sn.id,
      d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`,
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
    for (const d of s.deps) {
      const dn = byId[d];
      if (dn && sn) dep(dn, sn);
    }
  }

  return { nodes, edges, width, height };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

type SubDir = "R" | "L" | "U" | "D";
type BBox = { minX: number; minY: number; maxX: number; maxY: number };
const bboxOf = (ns: GNode[]): BBox => ({
  minX: Math.min(...ns.map((n) => n.x)),
  minY: Math.min(...ns.map((n) => n.y)),
  maxX: Math.max(...ns.map((n) => n.x + n.w)),
  maxY: Math.max(...ns.map((n) => n.y + n.h)),
});

/**
 * Forest layouts that spread in two directions or radially. Each 대블럭 becomes a
 * self-contained "unit" (theme centered, its 중블럭/소블럭 branching out); units are
 * then arranged — stacked along a shared spine (H2/V2) or packed into a grid
 * (RAD/GRID).
 */
function layoutForest(
  plan: Plan,
  collapsed: (id: string) => boolean,
  scale: number,
  mode: PlanDir,
  sort: PlanSort,
): PlanLayout {
  const stepW = Math.round(STEP_W * scale);
  const stepH = Math.round(STEP_H * scale);
  const widthOf = (k: GNodeKind) => (k === "theme" ? THEME_W : k === "feature" ? FEAT_W : stepW);
  const heightOf = (k: GNodeKind) => (k === "step" ? stepH : NODE_H);

  const cmp =
    sort === "title"
      ? (a: { title: string }, b: { title: string }) =>
          (a.title || "").localeCompare(b.title || "", "ko")
      : () => 0;
  const themes = [...plan.themes].sort(cmp);
  const featByTheme: Record<string, typeof plan.features> = {};
  for (const f of plan.features) (featByTheme[f.themeId] ??= []).push(f);
  for (const k in featByTheme) featByTheme[k].sort(cmp);
  const stepByFeat: Record<string, typeof plan.steps> = {};
  for (const s of plan.steps) (stepByFeat[s.featureId] ??= []).push(s);
  for (const k in stepByFeat) stepByFeat[k].sort(cmp);

  const stepCount = (f: { id: string }) => stepByFeat[f.id]?.length || 1;
  // split features into n groups, greedily balancing by step count, order kept
  const splitGroups = (feats: typeof plan.features, n: number) => {
    const groups: (typeof plan.features)[] = Array.from({ length: n }, () => []);
    const load = new Array(n).fill(0);
    for (const f of feats) {
      let lo = 0;
      for (let i = 1; i < n; i++) if (load[i] < load[lo]) lo = i;
      groups[lo].push(f);
      load[lo] += stepCount(f);
    }
    return groups;
  };

  // one theme's features+steps growing away from the theme in sub-direction `sd`,
  // returned as node centers relative to the theme center at (0,0)
  const branch = (feats: typeof plan.features, sd: SubDir) => {
    const vert = sd === "U" || sd === "D";
    const sign = sd === "R" || sd === "D" ? 1 : -1;
    const dsz = (k: GNodeKind) => (vert ? heightOf(k) : widthOf(k));
    const csz = (k: GNodeKind) => (vert ? widthOf(k) : heightOf(k));
    const featDC = dsz("theme") / 2 + COL_GAP + dsz("feature") / 2;
    const stepDC = dsz("theme") / 2 + COL_GAP + dsz("feature") + COL_GAP + dsz("step") / 2;
    let cur = 0;
    const placed: { id: string; kind: GNodeKind; title: string; dc: number; cc: number }[] = [];
    for (const feat of feats) {
      const steps = stepByFeat[feat.id] ?? [];
      const fcol = collapsed(feat.id) || !steps.length;
      if (fcol) {
        placed.push({ id: feat.id, kind: "feature", title: feat.title, dc: featDC, cc: cur + csz("feature") / 2 });
        cur += csz("feature") + ROW_GAP;
      } else {
        const sc: number[] = [];
        for (const step of steps) {
          const cc = cur + csz("step") / 2;
          placed.push({ id: step.id, kind: "step", title: step.title, dc: stepDC, cc });
          sc.push(cc);
          cur += csz("step") + ROW_GAP;
        }
        placed.push({ id: feat.id, kind: "feature", title: feat.title, dc: featDC, cc: avg(sc) });
      }
    }
    const shift = Math.max(0, cur - ROW_GAP) / 2; // center the stack on 0
    return placed.map((p) => {
      const depth = sign * p.dc;
      const cross = p.cc - shift;
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        cx: vert ? cross : depth,
        cy: vert ? depth : cross,
      };
    });
  };

  // build one theme's unit (theme + branches), as top-left GNodes with theme at center
  const themeUnit = (theme: { id: string; title: string }): { nodes: GNode[]; bbox: BBox } => {
    const feats = featByTheme[theme.id] ?? [];
    const centers = [{ id: theme.id, kind: "theme" as GNodeKind, title: theme.title, cx: 0, cy: 0 }];
    if (!collapsed(theme.id) && feats.length) {
      if (mode === "H2" || mode === "V2") {
        const [a, b] = splitGroups(feats, 2);
        const dirs: SubDir[] = mode === "H2" ? ["R", "L"] : ["D", "U"];
        centers.push(...branch(a, dirs[0]), ...branch(b, dirs[1]));
      } else if (mode === "RAD") {
        const g = splitGroups(feats, 4);
        (["R", "L", "D", "U"] as SubDir[]).forEach((sd, i) => centers.push(...branch(g[i], sd)));
      } else {
        centers.push(...branch(feats, "R")); // GRID: one-directional subtree
      }
    }
    const nodes = centers.map((c) => {
      const w = widthOf(c.kind);
      const h = heightOf(c.kind);
      return { id: c.id, kind: c.kind, title: c.title, w, h, x: c.cx - w / 2, y: c.cy - h / 2 };
    });
    return { nodes, bbox: bboxOf(nodes) };
  };

  const units = themes.map(themeUnit);
  const shiftUnit = (u: { nodes: GNode[] }, dx: number, dy: number) =>
    u.nodes.forEach((n) => {
      n.x += dx;
      n.y += dy;
    });

  const GAP = THEME_GAP + 16;
  if (mode === "H2" || mode === "V2") {
    if (mode === "H2") {
      // stack vertically, theme centers aligned on a vertical spine
      const spineX = Math.max(0, ...units.map((u) => -u.bbox.minX));
      let y = 0;
      for (const u of units) {
        shiftUnit(u, spineX, y - u.bbox.minY);
        y += u.bbox.maxY - u.bbox.minY + GAP;
      }
    } else {
      // arrange horizontally, theme centers aligned on a horizontal spine
      const spineY = Math.max(0, ...units.map((u) => -u.bbox.minY));
      let x = 0;
      for (const u of units) {
        shiftUnit(u, x - u.bbox.minX, spineY);
        x += u.bbox.maxX - u.bbox.minX + GAP;
      }
    }
  } else {
    // RAD / GRID: pack unit bounding boxes into a near-square grid (row-major)
    const n = units.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    let y = 0;
    for (let r = 0; r * cols < n; r++) {
      const row = units.slice(r * cols, r * cols + cols);
      const rowH = Math.max(0, ...row.map((u) => u.bbox.maxY - u.bbox.minY));
      let x = 0;
      for (const u of row) {
        shiftUnit(u, x - u.bbox.minX, y - u.bbox.minY);
        x += u.bbox.maxX - u.bbox.minX + GAP;
      }
      y += rowH + GAP;
    }
  }

  const nodes: GNode[] = [];
  const byId: Record<string, GNode> = {};
  for (const u of units)
    for (const n of u.nodes) {
      nodes.push(n);
      byId[n.id] = n;
    }

  // normalize to origin + padding BEFORE building edges (so edges match coords)
  const bb = bboxOf(nodes.length ? nodes : [{ x: 0, y: 0, w: NODE_H, h: NODE_H } as GNode]);
  const pad = 40;
  for (const n of nodes) {
    n.x += pad - bb.minX;
    n.y += pad - bb.minY;
  }

  // edges connect rectangle borders facing each other (works in any direction)
  const edges: GEdge[] = [];
  const border = (n: GNode, tx: number, ty: number) => {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(dx ? n.w / 2 / Math.abs(dx) : Infinity, dy ? n.h / 2 / Math.abs(dy) : Infinity);
    return { x: cx + dx * s, y: cy + dy * s };
  };
  const curve = (a: GNode, b: GNode, kind: "hier" | "dep", id: string, from?: string, to?: string) => {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = border(a, bc.x, bc.y);
    const p2 = border(b, ac.x, ac.y);
    const c1 = { x: p1.x + (p2.x - p1.x) * 0.4, y: p1.y + (p2.y - p1.y) * 0.4 };
    const c2 = { x: p1.x + (p2.x - p1.x) * 0.6, y: p1.y + (p2.y - p1.y) * 0.6 };
    edges.push({ id, kind, from, to, d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}` });
  };
  for (const f of plan.features) {
    const t = byId[f.themeId];
    const fn = byId[f.id];
    if (t && fn) curve(t, fn, "hier", `h-${t.id}-${fn.id}`);
  }
  for (const s of plan.steps) {
    const f = byId[s.featureId];
    const sn = byId[s.id];
    if (f && sn) curve(f, sn, "hier", `h-${f.id}-${sn.id}`);
    for (const d of s.deps) {
      const dn = byId[d];
      if (dn && sn) curve(dn, sn, "dep", `d-${dn.id}-${sn.id}`, dn.id, sn.id);
    }
  }

  return {
    nodes,
    edges,
    width: bb.maxX - bb.minX + pad * 2,
    height: bb.maxY - bb.minY + pad * 2,
  };
}

/**
 * The critical path through the step dependency DAG: the longest chain of
 * prerequisite→dependent steps (by count). It's the bottleneck — its length is
 * the minimum number of sequential stages the plan can finish in. Returns the
 * node ids on that chain and the `${dep}->${id}` edge keys connecting them.
 */
export function criticalPath(plan: Plan): {
  nodes: Set<string>;
  edges: Set<string>;
  length: number;
} {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>(); // longest chain length ending at id (incl. id)
  const lp = (id: string, seen: Set<string> = new Set()): number => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (seen.has(id)) return 0; // defensive: cycles shouldn't exist (guarded on edit)
    seen.add(id);
    const deps = byId.get(id)?.deps.filter((d) => byId.has(d)) ?? [];
    const v = 1 + (deps.length ? Math.max(...deps.map((d) => lp(d, seen))) : 0);
    seen.delete(id);
    memo.set(id, v);
    return v;
  };

  let best = "";
  let bestLen = 0;
  for (const s of plan.steps) {
    const v = lp(s.id);
    if (v > bestLen) {
      bestLen = v;
      best = s.id;
    }
  }

  const nodes = new Set<string>();
  const edges = new Set<string>();
  let cur = best;
  while (cur) {
    nodes.add(cur);
    const deps = (byId.get(cur)?.deps ?? []).filter((d) => byId.has(d));
    if (!deps.length) break;
    // step back along the dep that carries the longest chain
    let next = "";
    let nextLen = -1;
    for (const d of deps) {
      const v = lp(d);
      if (v > nextLen) {
        nextLen = v;
        next = d;
      }
    }
    if (!next) break;
    edges.add(`${next}->${cur}`);
    cur = next;
  }
  return { nodes, edges, length: bestLen };
}
