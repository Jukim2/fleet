import { useState } from "react";
import { Block } from "../../types";
import { mod } from "../../lib/platform";

export default function BlocksPanel({
  blocks,
  onChange,
}: {
  blocks: Block[];
  onChange: (b: Block[]) => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const add = () => {
    if (!name.trim() || !text.trim()) return;
    onChange([...blocks, { id: crypto.randomUUID(), name: name.trim(), text: text.trim() }]);
    setName("");
    setText("");
  };
  return (
    <div className="panel">
      <p className="hint">자주 쓰는 프롬프트. {mod("K")}로 빠르게 현재 터미널에 보낼 수 있어요.</p>
      <div className="rows">
        {blocks.length === 0 && <div className="empty">아직 블럭이 없어요.</div>}
        {blocks.map((b) => (
          <div className="row" key={b.id}>
            <div className="row-main">
              <strong>{b.name}</strong>
              <span className="row-sub">{b.text}</span>
            </div>
            <button className="iconbtn" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="form">
        <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder="프롬프트 내용…"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="add" onClick={add}>
          ＋ 블럭 추가
        </button>
      </div>
    </div>
  );
}
