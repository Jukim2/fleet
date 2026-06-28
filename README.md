# Fleet

여러 프로젝트의 `claude` 세션을 한 화면에서 관리하는 데스크탑 앱 (Mac / Windows).

각 프로젝트는 **독립된 PTY 터미널**에서 실제 인터랙티브 `claude`를 실행합니다.
헤드리스(`claude -p`)가 아니라 로그인된 구독 세션을 그대로 쓰므로 추가 API 과금이 없습니다.

## 스택

- **Tauri 2** (Rust 백엔드 + React/TS 프론트엔드)
- **portable-pty** — 크로스플랫폼 PTY (macOS openpty / Windows ConPTY)
- **xterm.js** — 터미널 렌더링

## 구조 (기능별)

```
src-tauri/src/lib.rs        PTY 세션 매니저 + 커맨드 + claude 세션 검색 + 설정 저장

src/api/        pty.ts · config.ts · claude.ts      (Rust 커맨드 래퍼)
src/lib/        layout.ts                            (분할 트리 순수 함수)
src/hooks/      useFleet.ts · useClaudeSessions.ts   (중앙 상태/액션, 세션 로딩)
src/features/
  projects/     ProjectRail (+css)
  terminals/    Terminal · ProjectView · SplitLayout · NewTerminalMenu (+css)
  blocks/       CommandPalette (+css)
  drawer/       Drawer · BlocksPanel · QueuePanel · SchedulePanel (+css)
src/styles/global.css · types.ts · App.tsx (조립만)
```

설정(프로젝트·블럭)은 OS 설정 폴더의 `fleet.json`에 저장됩니다.

## 실행

```bash
npm install
npm run tauri dev      # 개발
npm run tauri build    # 배포 번들 (.app / .dmg / .msi)
```

## 동작 원리

- 프로젝트 추가 -> 그 폴더에서 기본 셸을 PTY로 띄우고 `startup`(기본 `claude`)을 타이핑
- **공통 블럭** -> 저장된 프롬프트를 카드별/전체 세션에 텍스트+엔터로 주입
- 상태뱃지는 PTY 출력 흐름으로 판정 (출력 중=작업중, 1.5초 정지=대기)

## 기능

- [x] **폴더(프로젝트) 관리**: 좌측 레일에서 폴더 추가/선택/드래그 정렬
- [x] **프로젝트당 다중 터미널**: 탭으로 관리, 드래그로 순서 변경
- [x] **분할 보기**: 패널 좌우(⊞)/상하(⊟) 분할, 분할선 드래그로 크기 조절, 탭을 패널로 드래그해 배치
- [x] **쉬운 resume**: 좌측 사이드바에 그 폴더의 과거 claude 세션 목록 → 한 번 클릭으로 `claude --resume`
- [x] **스크롤백 유지**: 탭/패널을 옮겨도 터미널 내용 보존 (PTY 항상 마운트, 위치만 이동)

## 구현 메모

- 터미널은 절대좌표 오버레이로 패널 위에 띄움 → 재배치 시 xterm을 재생성하지 않아 스크롤백이 유지됨
- 분할 레이아웃은 재귀 트리(`src/layout.ts`), 프로젝트별로 `fleet.json`에 영속화
- resume 목록: `~/.claude/projects/<encoded-cwd>/*.jsonl`의 첫 유저 메시지를 요약으로 추출

- [x] **공통 블럭 + ⌘K 팔레트**: ⌘K로 블럭 검색 → Enter(현재 터미널) / Shift+Enter(전체 전송)
- [x] **작업 큐**: 포커스된 터미널별 큐 + idle 자동 진행(자동/수동), 우측 드로어
- [x] **예약(스케줄러)**: 주기/매일 블럭을 프로젝트로 즉시전송 또는 큐추가

- [x] **탭 이름 변경**: 탭 더블클릭 → 인라인 편집
- [x] **단축키**: ⌘K 팔레트 · ⌘T 새 터미널 · ⌘W 닫기 · ⌘1~9 프로젝트 전환

## 로드맵

- [ ] 완료/확인필요 시 OS 알림 (idle 감지 정교화 후 — 현재는 출력정지 2초라 오탐 가능)
- [ ] 터미널 상태 정교화: claude TUI 프롬프트 패턴 매칭
- [ ] 블럭 변수 치환(`{{branch}}` 등)
