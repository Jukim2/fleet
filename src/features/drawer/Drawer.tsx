import { Preset, PresetOverride } from "../../types";
import PresetsPanel from "../presets/PresetsPanel";
import "./drawer.css";

export default function Drawer({
  open,
  onClose,
  projectName,
  presets,
  overrides,
  presetGen,
  onRun,
  onSetPresets,
  onSetOverride,
  onAiCreate,
  onRefill,
}: {
  open: boolean;
  onClose: () => void;
  projectName?: string;
  presets: Preset[];
  overrides: Record<string, PresetOverride>;
  presetGen: Record<string, boolean>;
  onRun: (presetId: string) => void;
  onSetPresets: (p: Preset[]) => void;
  onSetOverride: (presetId: string, ov: PresetOverride | null) => void;
  onAiCreate: (name: string, kind: Preset["kind"], description: string) => void;
  onRefill: (presetId: string) => void;
}) {
  if (!open) return null;
  return (
    <aside className="drawer">
      <div className="drawer-tabs">
        <button className="on">프리셋</button>
        <button className="drawer-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <PresetsPanel
          projectName={projectName}
          presets={presets}
          overrides={overrides}
          presetGen={presetGen}
          onRun={onRun}
          onSetPresets={onSetPresets}
          onSetOverride={onSetOverride}
          onAiCreate={onAiCreate}
          onRefill={onRefill}
        />
      </div>
    </aside>
  );
}
