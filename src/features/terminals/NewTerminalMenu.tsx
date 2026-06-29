export default function NewTerminalMenu({
  onCreate,
}: {
  onCreate: (startup: string, title: string) => void;
}) {
  // Two direct buttons (no dropdown) so a new terminal is one click, not two.
  return (
    <>
      <button
        className="newterm-btn"
        title="새 Claude 터미널"
        onClick={() => onCreate("claude", "Claude")}
      >
        ＋ Claude
      </button>
      <button className="newterm-btn" title="새 셸 터미널" onClick={() => onCreate("", "Shell")}>
        ＋ 셸
      </button>
    </>
  );
}
