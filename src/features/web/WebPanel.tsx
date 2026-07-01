import { useState } from "react";
import { WebTab, WebArtifact } from "../../types";
import { knownSites } from "../../lib/webAdapters";
import "./web.css";

export default function WebPanel({
  webTabs,
  artifacts,
  onClose,
  onAdd,
  onRemove,
  onOpen,
  onOpenAll,
  onSend,
  onBroadcast,
  onOpenArtifact,
  onClearArtifacts,
}: {
  webTabs: WebTab[];
  artifacts: WebArtifact[];
  onClose: () => void;
  onAdd: (name: string, url: string) => void;
  onRemove: (id: string) => void;
  onOpen: (t: WebTab) => void;
  onOpenAll: () => void;
  onSend: (t: WebTab, text: string) => void;
  onBroadcast: (text: string) => void;
  onOpenArtifact: (a: WebArtifact) => void;
  onClearArtifacts: () => void;
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
          <span className="web-sub">
            각 탭은 독립 로그인 세션이에요 — 같은 사이트를 여러 계정으로 쓰려면 탭을 여러 개 추가하세요
          </span>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        {/* Broadcast box */}
        <div className="web-cast">
          <textarea
            className="web-msg"
            placeholder="프롬프트 입력 → 열린 모든 AI 탭에 동시 전송…"
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

        {/* Artifact inbox — files harvested from web tabs (e.g. GPT images) */}
        {artifacts.length > 0 && (
          <div className="web-artifacts">
            <div className="web-art-head">
              <strong>산출물</strong>
              <span className="web-art-sub">웹 탭에서 받은 파일</span>
              <button className="btn sm" onClick={onClearArtifacts} title="목록 비우기">
                비우기
              </button>
            </div>
            <div className="web-art-list">
              {artifacts.map((a) => (
                <div className="web-art-row" key={a.id}>
                  <span className="web-art-name" title={a.path}>
                    {a.name}
                  </span>
                  <button className="btn sm" onClick={() => onOpenArtifact(a)} title="파일 열기">
                    열기
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab list */}
        <div className="web-list">
          {webTabs.length === 0 && (
            <div className="web-empty">아직 탭이 없어요. 아래에서 추가하세요.</div>
          )}
          {webTabs.map((t) => (
            <div className="web-row" key={t.id}>
              <div className="web-row-main" title={t.url}>
                <span className="web-name">{t.name}</span>
                <span className="web-url">{t.url}</span>
              </div>
              <button className="btn sm" onClick={() => onOpen(t)} title="탭 열기 / 포커스">
                열기
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
