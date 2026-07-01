import { useState } from "react";
import { Preset, PresetBody } from "../../types";
import { presetBody } from "../../lib/presets";
import "./presets.css";

/** Horizontal row of one-click preset buttons. Presets are global; `bodies`
 *  holds the current project's executable body per preset. */
export default function PresetBar({
  presets,
  bodies,
  onRun,
  onManage,
}: {
  presets: Preset[];
  bodies: Record<string, PresetBody>;
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
                    ? `코드 · ${presetBody(p, bodies[p.id]) || "(미생성)"}`
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
