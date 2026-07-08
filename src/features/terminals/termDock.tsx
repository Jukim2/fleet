// Terminal dock manager — invariant #1, generalized beyond the project stage.
//
// Each terminal owns ONE stable, imperatively-created container div; its xterm
// lives there via a portal (see TermPortals). UI surfaces that want to show a
// terminal (a project pane float, a live-canvas session node) "claim" it with
// a slot element + priority, and the container is appendChild-ed into the
// winning slot. Reparenting moves the SAME DOM subtree, so the xterm instance,
// its imeBridge listeners, and the scrollback all survive — the terminal is
// never remounted, only re-docked. With no claims the container is parked in a
// hidden, document-connected lot (never detached, so xterm writes stay safe).
import { useEffect, useRef } from "react";

type Claim = { key: string; el: HTMLElement; priority: number };

const containers = new Map<string, HTMLDivElement>();
const claims = new Map<string, Claim[]>();
const subs = new Set<() => void>();
let parking: HTMLElement | null = null;

export function termContainer(termId: string): HTMLDivElement {
  let c = containers.get(termId);
  if (!c) {
    c = document.createElement("div");
    c.className = "term-dock";
    containers.set(termId, c);
    if (parking) parking.appendChild(c);
  }
  return c;
}

function apply(termId: string) {
  const c = termContainer(termId);
  const list = claims.get(termId) ?? [];
  let top: Claim | null = null;
  for (const cl of list) if (!top || cl.priority >= top.priority) top = cl;
  const target = top?.el ?? parking;
  if (target && c.parentElement !== target) target.appendChild(c);
  for (const fn of subs) fn();
}

/** Register the hidden parking element (owned by TermPortals). */
export function setTermParking(el: HTMLElement | null) {
  parking = el;
  if (!el) return;
  for (const [id, c] of containers) {
    if (!c.parentElement) el.appendChild(c);
    void id;
  }
}

export function claimTerm(termId: string, key: string, el: HTMLElement, priority: number) {
  const next = (claims.get(termId) ?? []).filter((c) => c.key !== key);
  next.push({ key, el, priority });
  claims.set(termId, next);
  apply(termId);
}

export function releaseTerm(termId: string, key: string) {
  claims.set(termId, (claims.get(termId) ?? []).filter((c) => c.key !== key));
  apply(termId);
}

/** true while some surface is actually showing this terminal (not parked) */
export function isTermShown(termId: string): boolean {
  const c = containers.get(termId);
  return !!c && !!c.parentElement && c.parentElement !== parking;
}

/** re-render hook for components that derive state from docking (TermPortals) */
export function subscribeDock(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** drop containers of terminals that no longer exist */
export function pruneTermContainers(keep: Set<string>) {
  for (const [id, c] of [...containers]) {
    if (keep.has(id)) continue;
    c.remove();
    containers.delete(id);
    claims.delete(id);
  }
}

/**
 * A place a terminal can dock into. While `active`, this slot claims `termId`;
 * the highest-priority claimant gets the real xterm DOM appended inside.
 */
export function TermSlot({
  termId,
  slotKey,
  priority,
  active,
}: {
  termId: string;
  slotKey: string;
  priority: number;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    claimTerm(termId, slotKey, ref.current, priority);
    return () => releaseTerm(termId, slotKey);
  }, [termId, slotKey, priority, active]);
  return <div className="term-slot" ref={ref} />;
}
