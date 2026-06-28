import { useEffect, useRef, useState } from "react";

export default function NewTerminalMenu({
  onCreate,
}: {
  onCreate: (startup: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (startup: string, title: string) => {
    onCreate(startup, title);
    setOpen(false);
  };

  return (
    <div className="newterm" ref={ref}>
      <button className="newterm-btn" onClick={() => setOpen((o) => !o)}>
        ＋ 터미널 ▾
      </button>
      {open && (
        <div className="menu">
          <button onClick={() => pick("claude", "Claude")}>◇ 새 Claude</button>
          <button onClick={() => pick("", "Shell")}>› 새 셸</button>
        </div>
      )}
    </div>
  );
}
