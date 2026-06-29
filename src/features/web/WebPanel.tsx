import { useState } from "react";
import { WebTab } from "../../types";
import { embedBlocked, knownSites } from "../../lib/webAdapters";
import "./web.css";

export default function WebPanel({
  webTabs,
  onClose,
  onAdd,
  onRemove,
  onOpen,
  onOpenAll,
  onSend,
  onBroadcast,
}: {
  webTabs: WebTab[];
  onClose: () => void;
  onAdd: (name: string, url: string) => void;
  onRemove: (id: string) => void;
  onOpen: (t: WebTab) => void;
  onOpenAll: () => void;
  onSend: (t: WebTab, text: string) => void;
  onBroadcast: (text: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");

  const add = () => {
    if (!url.trim()) return;
    onAdd(name, url);
    setName("");
    setUrl("");
  };

  return (
    <div className="web-overlay" onMouseDown={onClose}>
      <div className="web" onMouseDown={(e) => e.stopPropagation()}>
        <header className="web-head">
          <strong>웹 AI 탭</strong>
          <span className="web-sub">로그인된 사이트에 한 번에 같은 프롬프트를 보내요</span>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        {/* ChatGPT etc. — driven via a Fleet-controlled Chrome (no install) */}
        <details className="web-bridge" open>
          <summary>ChatGPT 등 (<span className="web-badge">브라우저</span> 표시) 사용법 — 설치 불필요</summary>
          <p className="web-bridge-note">
            ChatGPT는 임베드가 막혀서, <b>“브라우저로 열기”</b>를 누르면 Fleet 전용 Chrome 창이
            하나 뜹니다. 평소 쓰는 브라우저와는 <b>별개의 창</b>이라 <b>그 창에서 한 번만 로그인</b>
            하면 되고, 이후엔 로그인이 유지돼 다시 안 해도 됩니다. (브라우저 보안상 평소 창에는 직접
            붙을 수 없어요.)
          </p>
          <ol className="web-steps">
            <li>해당 행의 <b>“브라우저로 열기”</b> → 뜬 Chrome 창에서 로그인 (최초 1회만)</li>
            <li>그 창은 그냥 열어둔 채로 — Fleet이 그 탭에 직접 입력합니다</li>
            <li>아래 칸에 프롬프트 입력 후 <b>“전체 전송”</b> → 열린 모든 탭(임베드 + 그 Chrome)에 동시 입력</li>
          </ol>
        </details>

        {/* Broadcast box */}
        <div className="web-cast">
          <textarea
            className="web-msg"
            placeholder="프롬프트 입력 → 열린 모든 AI 탭(임베드 + Chrome)에 동시 전송…"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onBroadcast(msg);
                setMsg("");
              }
            }}
          />
          <div className="web-cast-actions">
            <button className="btn" onClick={onOpenAll} disabled={!webTabs.length}>
              모두 열기
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onBroadcast(msg);
                setMsg("");
              }}
              disabled={!msg.trim() || !webTabs.length}
            >
              전체 전송 (⌘↵)
            </button>
          </div>
        </div>

        {/* Tab list */}
        <div className="web-list">
          {webTabs.length === 0 && (
            <div className="web-empty">아직 탭이 없어요. 아래에서 추가하세요.</div>
          )}
          {webTabs.map((t) => (
            <div className="web-row" key={t.id}>
              <div className="web-row-main" title={t.url}>
                <span className="web-name">
                  {t.name}
                  {embedBlocked(t.url) && <span className="web-badge">브라우저</span>}
                </span>
                <span className="web-url">{t.url}</span>
              </div>
              <button
                className="btn sm"
                onClick={() => onOpen(t)}
                title={
                  embedBlocked(t.url)
                    ? "임베드가 막힌 사이트 — 기본 브라우저에서 엽니다 (유저스크립트 필요)"
                    : "임베드 창 열기 / 포커스"
                }
              >
                {embedBlocked(t.url) ? "브라우저로 열기" : "열기"}
              </button>
              <button
                className="btn sm"
                onClick={() => msg.trim() && onSend(t, msg)}
                disabled={!msg.trim()}
                title="이 탭에만 위 프롬프트 전송"
              >
                전송
              </button>
              <button className="btn sm danger" onClick={() => onRemove(t.id)} title="삭제">
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Add */}
        <div className="web-add">
          <div className="web-presets">
            {knownSites.map((s) => (
              <button key={s.name} className="chip" onClick={() => onAdd(s.name, s.url)}>
                ＋ {s.name}
              </button>
            ))}
          </div>
          <div className="web-add-row">
            <input
              className="web-in"
              placeholder="이름 (예: 업무용 GPT)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="web-in grow"
              placeholder="https://..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="btn" onClick={add} disabled={!url.trim()}>
              추가
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
