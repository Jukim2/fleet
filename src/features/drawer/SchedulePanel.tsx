import { useState } from "react";
import { Block, Project, Schedule } from "../../types";

export default function SchedulePanel({
  schedules,
  projects,
  blocks,
  onChange,
}: {
  schedules: Schedule[];
  projects: Project[];
  blocks: Block[];
  onChange: (s: Schedule[]) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [blockId, setBlockId] = useState("");
  const [kind, setKind] = useState<"interval" | "daily">("interval");
  const [intervalMin, setIntervalMin] = useState(60);
  const [time, setTime] = useState("09:00");
  const [action, setAction] = useState<"send" | "enqueue">("enqueue");

  const pName = (id: string) => projects.find((p) => p.id === id)?.name ?? "?";
  const bName = (id: string) => blocks.find((b) => b.id === id)?.name ?? "?";
  const when = (s: Schedule) => (s.kind === "interval" ? `매 ${s.intervalMin}분` : `매일 ${s.time}`);

  const add = () => {
    if (!projectId || !blockId) return;
    onChange([
      ...schedules,
      {
        id: crypto.randomUUID(),
        projectId,
        blockId,
        kind,
        intervalMin,
        time,
        action,
        enabled: true,
        lastRun: kind === "interval" ? Date.now() : undefined,
      },
    ]);
  };

  return (
    <div className="panel">
      <p className="hint">정해진 시각·주기에 블럭을 프로젝트로 자동 실행.</p>
      <div className="rows">
        {schedules.length === 0 && <div className="empty">예약이 없어요.</div>}
        {schedules.map((s) => (
          <div className={`row ${s.enabled ? "" : "dim"}`} key={s.id}>
            <div className="row-main">
              <strong>{pName(s.projectId)}</strong>
              <span className="row-sub">
                {bName(s.blockId)} · {when(s)} · {s.action === "send" ? "즉시" : "큐"}
              </span>
            </div>
            <button
              className="iconbtn"
              onClick={() =>
                onChange(schedules.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))
              }
            >
              {s.enabled ? "⏸" : "▶"}
            </button>
            <button className="iconbtn" onClick={() => onChange(schedules.filter((x) => x.id !== s.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="form">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">프로젝트…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
          <option value="">블럭…</option>
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="form-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
            <option value="interval">주기</option>
            <option value="daily">매일</option>
          </select>
          {kind === "interval" ? (
            <label className="inline">
              매
              <input
                type="number"
                min={1}
                value={intervalMin}
                onChange={(e) => setIntervalMin(Math.max(1, Number(e.target.value)))}
              />
              분
            </label>
          ) : (
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value as any)}>
          <option value="enqueue">큐에 추가</option>
          <option value="send">즉시 전송</option>
        </select>
        <button className="add" onClick={add} disabled={!projectId || !blockId}>
          ＋ 예약 추가
        </button>
      </div>
    </div>
  );
}
