import { Preset, PresetBody } from "../../types";
import PresetsPanel from "../presets/PresetsPanel";
import "./drawer.css";

export default function Drawer({
  open,
  onClose,
  presets,
  bodies,
  presetGen,
  onRun,
  onAddPreset,
  onUpdatePreset,
  onRemovePreset,
  onSetBody,
  onGenerate,
}: {
  open: boolean;
  onClose: () => void;
  presets: Preset[];
  bodies: Record<string, PresetBody>;
  presetGen: Record<string, boolean>;
  onRun: (presetId: string) => void;
  onAddPreset: (name: string, kind: Preset["kind"], description: string, body?: string) => void;
  onUpdatePreset: (presetId: string, patch: Partial<Omit<Preset, "id">>) => void;
  onRemovePreset: (presetId: string) => void;
  onSetBody: (presetId: string, body: PresetBody | null) => void;
  onGenerate: (presetId: string) => void;
}) {
  return (
    <aside className="drawer" aria-hidden={!open}>
      <div className="drawer-tabs">
        <button className="on">프리셋</button>
        <button className="drawer-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <PresetsPanel
          presets={presets}
          bodies={bodies}
          presetGen={presetGen}
          onRun={onRun}
          onAddPreset={onAddPreset}
          onUpdatePreset={onUpdatePreset}
          onRemovePreset={onRemovePreset}
          onSetBody={onSetBody}
          onGenerate={onGenerate}
        />
      </div>
    </aside>
  );
}
