// Pure helpers for the recursive split-layout tree (immutable updates).
import { Leaf, LayoutNode, Split } from "../types";

const uid = () => crypto.randomUUID();

export const newLeaf = (termId: string | null): Leaf => ({
  kind: "leaf",
  id: uid(),
  termId,
});

export function firstLeaf(node: LayoutNode): Leaf {
  return node.kind === "leaf" ? node : firstLeaf(node.a);
}

/** All leaves, left-to-right / top-to-bottom. */
export function leaves(node: LayoutNode): Leaf[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export function setLeafTerm(node: LayoutNode, leafId: string, termId: string | null): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id === leafId) return { ...node, termId };
    // A terminal lives in at most one pane: clear it elsewhere.
    if (termId && node.termId === termId) return { ...node, termId: null };
    return node;
  }
  return { ...node, a: setLeafTerm(node.a, leafId, termId), b: setLeafTerm(node.b, leafId, termId) };
}

/**
 * Assign termIds to leaves by id, RAW (no dedup). Used to swap two panes'
 * terminals in one pass — dedup would clear one side mid-swap.
 */
export function setLeafTermsRaw(
  node: LayoutNode,
  map: Record<string, string | null>,
): LayoutNode {
  if (node.kind === "leaf") {
    return node.id in map ? { ...node, termId: map[node.id] } : node;
  }
  return { ...node, a: setLeafTermsRaw(node.a, map), b: setLeafTermsRaw(node.b, map) };
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

/** Split a leaf, the new sibling shows the pre-built leaf (caller knows its id). */
export function splitLeafWith(
  node: LayoutNode,
  leafId: string,
  dir: "row" | "col",
  sibling: Leaf,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== leafId) return node;
    return { kind: "split", id: uid(), dir, ratio: 0.5, a: node, b: sibling } as Split;
  }
  return {
    ...node,
    a: splitLeafWith(node.a, leafId, dir, sibling),
    b: splitLeafWith(node.b, leafId, dir, sibling),
  };
}

/** Split a leaf, placing an EXISTING terminal's leaf on the given side (before = left/top). */
export function splitLeafWithSide(
  node: LayoutNode,
  leafId: string,
  dir: "row" | "col",
  before: boolean,
  sibling: Leaf,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== leafId) {
      // Dedup: the moved terminal must not remain in another pane.
      if (sibling.termId && node.termId === sibling.termId) return { ...node, termId: null };
      return node;
    }
    return {
      kind: "split",
      id: uid(),
      dir,
      ratio: 0.5,
      a: before ? sibling : node,
      b: before ? node : sibling,
    };
  }
  return {
    ...node,
    a: splitLeafWithSide(node.a, leafId, dir, before, sibling),
    b: splitLeafWithSide(node.b, leafId, dir, before, sibling),
  };
}

/**
 * Drop every leaf that has no terminal, collapsing siblings up. Run after any
 * move that may have emptied a leaf via dedup, so we never show a blank pane.
 */
export function compact(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.termId ? node : null;
  const a = compact(node.a);
  const b = compact(node.b);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** Remove a leaf; its sibling collapses up. Returns null if the root leaf is removed. */
export function removeLeaf(node: LayoutNode, leafId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.id === leafId ? null : node;
  const a = removeLeaf(node.a, leafId);
  const b = removeLeaf(node.b, leafId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/**
 * Ensure a layout references only valid terminals. A leaf whose terminal is
 * gone is DROPPED (its sibling collapses up) — we never keep empty panes.
 * Returns null when nothing is left to show.
 */
export function normalize(
  node: LayoutNode | undefined | null,
  validTerms: Set<string>,
): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") {
    return node.termId && validTerms.has(node.termId) ? node : null;
  }
  const a = normalize(node.a, validTerms);
  const b = normalize(node.b, validTerms);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}
