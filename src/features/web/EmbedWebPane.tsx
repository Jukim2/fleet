import { useEffect, useLayoutEffect, useRef } from "react";
import { embedWebBounds, embedWebClose, embedWebCreate, embedWebShow } from "../../api/embed";
import "./embed.css";

/**
 * An in-window embedded web pane (prototype). Renders a DOM header + an empty
 * "slot" div; a native child webview is positioned over the slot's screen rect
 * by the backend (embed.rs). Because that webview always paints above the DOM,
 * the pane is HIDDEN whenever an overlay should be on top (`hidden` prop) — the
 * inherent tradeoff of embedding these (un-iframe-able) sites in one window.
 */
export default function EmbedWebPane({
  label,
  url,
  profile,
  hidden,
  title,
  sites,
  onPickSite,
  onClose,
}: {
  label: string;
  url: string;
  profile: string;
  /** true → hide the native webview (an overlay is on top, or pane not visible) */
  hidden: boolean;
  title: string;
  sites: { name: string; url: string }[];
  onPickSite: (url: string) => void;
  onClose: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const lastRect = useRef<string>("");

  // Read the slot's on-screen rect (CSS px == window logical coords, since the
  // main webview fills the window content) and push it to the native webview.
  const pushBounds = () => {
    const el = slotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (key === lastRect.current) return;
    lastRect.current = key;
    embedWebBounds(label, r.left, r.top, r.width, r.height).catch(() => {});
  };

  // Create the child webview once (for this url), keep its rect in sync, and
  // destroy it on unmount / url change.
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    lastRect.current = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    embedWebCreate(label, url, r.left, r.top, r.width, r.height, profile).catch(() => {});

    const ro = new ResizeObserver(() => pushBounds());
    ro.observe(el);
    const onWinResize = () => pushBounds();
    window.addEventListener("resize", onWinResize);
    // A couple of delayed pushes catch layout settling right after open.
    const t1 = window.setTimeout(pushBounds, 60);
    const t2 = window.setTimeout(pushBounds, 300);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      embedWebClose(label).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, url]);

  // Hide/show the native surface as overlays come and go. While hidden, the
  // backend parks the webview off-screen (so a lingering surface can't eat
  // clicks); clearing the cached rect forces the next show to re-push its real
  // bounds (pushBounds skips when the rect key is unchanged).
  useEffect(() => {
    if (hidden) {
      lastRect.current = "";
      embedWebShow(label, false).catch(() => {});
    } else {
      embedWebShow(label, true).catch(() => {});
      pushBounds();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, label]);

  return (
    <div className="embedweb">
      <div className="embedweb-head">
        <select
          className="embedweb-site"
          value={url}
          onChange={(e) => onPickSite(e.target.value)}
          title="사이트 선택"
        >
          {sites.map((s) => (
            <option key={s.url} value={s.url}>
              {s.name}
            </option>
          ))}
          {!sites.some((s) => s.url === url) && <option value={url}>{title || url}</option>}
        </select>
        <span className="embedweb-spacer" />
        <button className="icon-btn" title="웹 pane 닫기" onClick={onClose}>
          ✕
        </button>
      </div>
      {/* The native webview overlays this slot. The hint shows only if it fails
          to cover the slot (e.g. still loading / blocked). */}
      <div className="embedweb-slot" ref={slotRef}>
        <span className="embedweb-hint">웹 pane 로딩 중…</span>
      </div>
    </div>
  );
}
