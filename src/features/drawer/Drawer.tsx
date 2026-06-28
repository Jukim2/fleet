import { Block } from "../../types";
import BlocksPanel from "./BlocksPanel";
import "./drawer.css";

export default function Drawer({
  open,
  onClose,
  blocks,
  onChangeBlocks,
}: {
  open: boolean;
  onClose: () => void;
  blocks: Block[];
  onChangeBlocks: (b: Block[]) => void;
}) {
  if (!open) return null;
  return (
    <aside className="drawer">
      <div className="drawer-tabs">
        <button className="on">블럭</button>
        <button className="drawer-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <BlocksPanel blocks={blocks} onChange={onChangeBlocks} />
      </div>
    </aside>
  );
}
