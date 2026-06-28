import { useRef } from "react";
import { LayoutNode, Split, Leaf, Terminal as Term, TermStatus } from "../../types";

type Ctx = {
  focusedPaneId: string | null;
  termsById: Record<string, Term>;
  statuses: Record<string, TermStatus>;
  canClose: boolean;
  onFocusPane: (id: string) => void;
  onSetRatio: (splitId: string, ratio: number) => void;
  onSplit: (paneId: string, dir: "row" | "col") => void;
  onClosePane: (paneId: string) => void;
  onPaneDragStart: (e: React.DragEvent, paneId: string, termId: string) => void;
  onPaneDragEnd: () => void;
};

function PaneBox({ leaf, ctx }: { leaf: Leaf; ctx: Ctx }) {
  const term = leaf.termId ? ctx.termsById[leaf.termId] : null;
  const status: TermStatus = leaf.termId ? ctx.statuses[leaf.termId] ?? "stopped" : "stopped";
  const focused = ctx.focusedPaneId === leaf.id;
  return (
    <div className={`pane ${focused ? "focused" : ""}`}>
      <div
        className={`pane-bar ${leaf.termId ? "draggable" : ""}`}
        draggable={!!leaf.termId}
        onMouseDown={() => ctx.onFocusPane(leaf.id)}
        onDragStart={(e) => leaf.termId && ctx.onPaneDragStart(e, leaf.id, leaf.termId)}
        onDragEnd={ctx.onPaneDragEnd}
      >
        <span className={`tdot ${status}`} />
        <span className="pane-name">{term?.title ?? "터미널"}</span>
        <span className="pane-tools">
          <button title="좌우 분할" onClick={() => ctx.onSplit(leaf.id, "row")}>
            ⊞
          </button>
          <button title="상하 분할" onClick={() => ctx.onSplit(leaf.id, "col")}>
            ⊟
          </button>
          {ctx.canClose && (
            <button title="패널 닫기" onClick={() => ctx.onClosePane(leaf.id)}>
              ✕
            </button>
          )}
        </span>
      </div>
      {/* Terminal floats over this body (positioned by ProjectView). */}
      <div className="pane-body" data-pane-id={leaf.id} data-term-id={leaf.termId ?? ""} />
    </div>
  );
}

function SplitBox({ node, ctx }: { node: Split; ctx: Ctx }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const r =
        node.dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      ctx.onSetRatio(node.id, r);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={wrapRef} className={`split split-${node.dir}`}>
      <div className="split-cell" style={{ flexGrow: node.ratio }}>
        <NodeBox node={node.a} ctx={ctx} />
      </div>
      <div className={`divider divider-${node.dir}`} onMouseDown={onDown} />
      <div className="split-cell" style={{ flexGrow: 1 - node.ratio }}>
        <NodeBox node={node.b} ctx={ctx} />
      </div>
    </div>
  );
}

function NodeBox({ node, ctx }: { node: LayoutNode; ctx: Ctx }) {
  return node.kind === "leaf" ? <PaneBox leaf={node} ctx={ctx} /> : <SplitBox node={node} ctx={ctx} />;
}

export default function SplitLayout({ node, ctx }: { node: LayoutNode; ctx: Ctx }) {
  return (
    <div className="splitroot">
      <NodeBox node={node} ctx={ctx} />
    </div>
  );
}

export type { Ctx as SplitCtx };
