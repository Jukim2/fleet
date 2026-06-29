import { Component, ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Catches render-time exceptions so a thrown component shows a readable error
 *  with a reload button instead of silently blanking the whole window. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Fleet render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          color: "#e5e7eb",
          background: "#0b0b0f",
          textAlign: "center",
        }}
      >
        <h2 style={{ margin: 0 }}>화면을 표시하는 중 오류가 났어요</h2>
        <pre
          style={{
            maxWidth: 720,
            maxHeight: 240,
            overflow: "auto",
            fontSize: 12,
            color: "#fca5a5",
            background: "#16161d",
            padding: 12,
            borderRadius: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {String(error?.stack || error?.message || error)}
        </pre>
        <button
          className="primary"
          onClick={() => location.reload()}
          style={{ padding: "8px 16px", cursor: "pointer" }}
        >
          다시 시도
        </button>
      </div>
    );
  }
}
