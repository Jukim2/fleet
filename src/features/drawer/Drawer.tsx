import { Block, Project, Schedule } from "../../types";
import BlocksPanel from "./BlocksPanel";
import SchedulePanel from "./SchedulePanel";
import "./drawer.css";

type Section = "blocks" | "schedule";

export default function Drawer({
  open,
  section,
  setSection,
  onClose,
  blocks,
  onChangeBlocks,
  projects,
  schedules,
  onChangeSchedules,
}: {
  open: boolean;
  section: Section;
  setSection: (s: Section) => void;
  onClose: () => void;
  blocks: Block[];
  onChangeBlocks: (b: Block[]) => void;
  projects: Project[];
  schedules: Schedule[];
  onChangeSchedules: (s: Schedule[]) => void;
}) {
  if (!open) return null;
  return (
    <aside className="drawer">
      <div className="drawer-tabs">
        {(["blocks", "schedule"] as Section[]).map((s) => (
          <button key={s} className={section === s ? "on" : ""} onClick={() => setSection(s)}>
            {s === "blocks" ? "블럭" : "예약"}
          </button>
        ))}
        <button className="drawer-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        {section === "blocks" && <BlocksPanel blocks={blocks} onChange={onChangeBlocks} />}
        {section === "schedule" && (
          <SchedulePanel
            schedules={schedules}
            projects={projects}
            blocks={blocks}
            onChange={onChangeSchedules}
          />
        )}
      </div>
    </aside>
  );
}
