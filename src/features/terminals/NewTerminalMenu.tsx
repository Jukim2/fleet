import { getAgent, AgentKind } from "../../lib/agents";

export default function NewTerminalMenu({
  onCreate,
  agent,
}: {
  onCreate: (startup: string, title: string) => void;
  /** the active agent CLI — its label + startup command back the first button */
  agent: AgentKind;
}) {
  const spec = getAgent(agent);
  // Two direct buttons (no dropdown) so a new terminal is one click, not two.
  return (
    <>
      <button
        className="newterm-btn"
        title={`새 ${spec.label} 터미널`}
        onClick={() => onCreate(spec.startup(), spec.label)}
      >
        ＋ {spec.label}
      </button>
      <button className="newterm-btn" title="새 셸 터미널" onClick={() => onCreate("", "Shell")}>
        ＋ 셸
      </button>
    </>
  );
}
