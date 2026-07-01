// Turn a Claude Code PreToolUse (tool name + detail) into a short, glanceable
// line like "config.rs 편집" or "$ npm run build", shown in the attention peek
// and command palette so you can tell what a session is doing without opening it.

/** last path segment of a file path (handles both / and \) */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function clip(s: string, n = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Human, Korean-leaning label for a live tool call. Empty string = unknown. */
export function describeActivity(tool: string, detail: string): string {
  if (!tool) return "";
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return detail ? `${baseName(detail)} 편집` : "파일 편집";
    case "Read":
      return detail ? `${baseName(detail)} 읽는 중` : "파일 읽는 중";
    case "Bash":
      return detail ? `$ ${clip(detail)}` : "명령 실행";
    case "Grep":
      return detail ? `검색: ${clip(detail, 32)}` : "검색 중";
    case "Glob":
      return detail ? `파일 찾기: ${clip(detail, 32)}` : "파일 찾기";
    case "Task":
      return detail ? `에이전트: ${clip(detail, 32)}` : "에이전트 실행";
    case "WebFetch":
    case "WebSearch":
      return detail ? `웹: ${clip(detail, 32)}` : "웹 검색";
    default:
      return detail ? `${tool}: ${clip(detail, 32)}` : tool;
  }
}
