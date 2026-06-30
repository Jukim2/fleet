import { useState } from "react";
import { Preset, PresetOverride } from "../../types";
import { effectiveBody } from "../../lib/presets";
import "./presets.css";

/** Horizontal row of one-click preset buttons. Presets are global; `overrides`
 *  tunes the body shown/run for the current project. */
export default function PresetBar({
  presets,
  overrides,
  onRun,
  onManage,
}: {
  presets: Preset[];
  overrides: Record<string, PresetOverride>;
  onRun: (presetId: string) => void;
  onManage: () => void;
}) {
  const [flashId, setFlashId] = useState<string | null>(null);
  const run = (id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 420);
    onRun(id);
  };
  return (
    <div className="preset-bar">
      {presets.length === 0 ? (
        <button className="preset-add-inline" onClick={onManage} title="프리셋 추가">
          ＋ 프리셋
        </button>
      ) : (
        <>
          <div className="preset-scroll">
            {presets.map((p) => (
              <button
                key={p.id}
                className={`preset-btn preset-${p.kind} ${flashId === p.id ? "flash" : ""}`}
                onClick={() => run(p.id)}
                title={
                  p.kind === "code"
                    ? `코드 · ${effectiveBody(p, overrides[p.id])}`
                    : `AI · 현재 터미널로 전송`
                }
              >
                <span className="preset-name">{p.name}</span>
              </button>
            ))}
          </div>
          <button className="preset-manage" onClick={onManage} title="프리셋 관리">
            관리
          </button>
        </>
      )}
    </div>
  );
}
