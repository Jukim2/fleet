# 코딩 에이전트 연결 정책 (fleet-agent.json)

Fleet은 각 PTY에서 대화형 코딩 에이전트 CLI(claude, codex, …)를 구동한다. 어떤 에이전트를
쓸지는 **전역 설정**(`FleetConfig.agent`)으로 고르고, 새 세션·리줌 목록·상태 감지가 그
에이전트를 따른다. 이미 열려 있는 터미널은 자기가 실행한 CLI를 그대로 유지한다.

에이전트는 **코드가 아니라 데이터(매니페스트)로 기술**한다. `fleet-agent.json` 하나를
추가하면 코드 수정·재빌드 없이 새 에이전트가 붙는다. claude/codex도 내장 매니페스트일 뿐이다.

연결·관리는 **설정 패널의 "코딩 에이전트" 섹션**에서 한다 (＋에이전트 → fleet-agent.json 폴더 선택).

## 요건

- **필수**: `id`, `label`, `bin`.
- 나머지는 `claude` 같은 CLI 기준의 합리적 기본값이 적용된다.

## 상태 감지(status) — 유일하게 "순수 데이터가 아닌" 부분

매니페스트는 Fleet이 구현한 **고정된 전략 집합** 중 하나를 고른다:

- `hooks` — Claude Code 라이프사이클 hook (`~/.claude/settings.json` + `FLEET_TERM_ID`).
  Fleet이 hook을 머지 설치한다. (claude)
- `rollout` — 에이전트가 세션마다 남기는 **구조화된 이벤트 로그(jsonl)** 를 tail 해서
  `task_started`→작업중, `task_complete`/`turn_complete`→대기, `*_approval_request`→승인필요,
  `user_message`→프롬프트(제목), `session_id`→리줌으로 매핑한다. 화면을 읽지 않으므로
  **언어·TUI 버전 변경에 안 깨진다.** (codex)
- `screen` — xterm 화면을 정규식으로 스캔(가장 취약, 폴백용).

`rollout`/`hooks` 에이전트도 `status.busy`/`status.waiting` 정규식을 넣어두면, 구조화 소스가
붙기 전까지의 **화면 스캔 폴백**으로 쓰인다.

## fleet-agent.json 스키마

```jsonc
{
  "id": "gemini",               // 소문자·숫자·하이픈, 전역 고유 (필수)
  "label": "Gemini",            // 표시명 + 기본 터미널 제목 (필수)
  "bin": "gemini",              // 셸에 입력되는 실행 명령(첫 단어) (필수)

  // 모드별로 덧붙는 플래그 조각. effort는 {v} 템플릿.
  "flags": {
    "auto":   "--yolo",                       // 완전 자동(승인 스킵)
    "accept": "--approval-mode auto_edit",    // 파일 편집만 자동
    "effort": "-c reasoning={v}"              // 추론 강도
  },
  "effortMap": { "xhigh": "high", "max": "high" }, // (선택) 강도 값 리맵

  "resume": "gemini --resume {id}",  // 리줌 명령 템플릿({id}). 기본 `<bin> --resume {id}`
  "resumeIdRe": "--resume\\s+(\\S+)", // (선택) startup에서 리줌 id 뽑는 정규식(그룹 1개)
  "resumeStripRe": "--resume\\s+\\S+",// (선택) 리줌 재작성 시 기존 리줌 절 제거 정규식

  "status": {
    "mode": "rollout",                 // "hooks" | "rollout" | "screen"
    "rolloutDir": "",                  // rollout: 로그 폴더(비우면 백엔드 기본 ~/.codex/sessions)
    "busy": "esc to interrupt",        // screen(또는 폴백): 작업중 표시 정규식
    "waiting": "allow .* to run"       // screen(또는 폴백): 승인대기 정규식
  },

  "sessions": "codex"   // 리줌 목록 탐색: "claude" | "codex" | "none"(기본)
}
```

내장 claude/codex 매니페스트가 좋은 참조 예시다 (`src/lib/agents.ts`의 `BUILTIN_AGENT_MANIFESTS`).

## 한계

- 실행/리줌은 순수 데이터로 표현되지만, **상태 감지 방식**은 위 고정 전략 중 하나여야 한다.
  기존 전략(hooks/rollout/screen)에 맞는 CLI는 매니페스트만으로 끝나고, 완전히 새로운
  감지 방식이 필요한 CLI는 Fleet 코드에 전략 추가가 필요하다.
- `rollout` 전략은 현재 로그 폴더 스캔으로 세션 파일을 cwd+생성시각으로 바인딩한다. 로그가
  세션마다 별도 jsonl로, 이벤트마다 증분 기록되는 CLI에 적합하다(codex가 그렇다).
