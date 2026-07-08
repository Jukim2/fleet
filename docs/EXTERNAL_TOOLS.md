# 외부 툴 연결 정책 (fleet-tool.json)

Fleet은 CLI가 있는 외부 툴을 **감지**해서 라이브 캔버스에 시각화한다. Fleet이 띄운
claude 세션이 그 툴의 CLI를 실행하면, Fleet이 PreToolUse hook으로 그 명령을 보고
`detect`에 걸리면 세션 노드에 **툴 노드**를 매단다. 결과물을 예측 가능한 폴더에 쓰면
입력→결과 썸네일까지 보여준다.

**Fleet은 툴을 직접 실행하지 않는다.** 클로드가 실행하고 Fleet은 관찰만 한다(클로드는
Fleet의 존재를 모른다). 그래서 명령 형태에 제약이 없고, 한 툴에 여러 CLI도 담을 수 있다.

연결·관리는 **설정 패널의 "외부 툴" 탭**에서 한다 (AI 등록 / 직접 연결 / 자동 발견).

## 요건

- **필수**: `id`, `name`, `detect`. 실행 폼·옵션 같은 건 필요 없다.
- **결과 썸네일(선택)**: 그 CLI가 결과물을 `<입력 폴더>/<outDirName>`(기본 `_out`) 아래에
  쓰면, Fleet이 잡 이후 생성된 이미지(png/webp/gif/svg/jpg)를 찾아 노드에 대표 입력→결과
  1쌍 + 나머지 썸네일로 보여준다. (없어도 노드는 뜬다)

## fleet-tool.json 스키마

툴 루트(또는 아무 폴더)에 둔다. 참조 구현: SpriteForge.

```jsonc
{
  "id": "spriteforge",          // 소문자·숫자·하이픈. 전역 고유
  "name": "SpriteForge",        // UI 표시명
  "desc": "스프라이트/이미지 배치 처리 CLI",  // (선택) 한 줄 소개

  // detect: 문자열 하나 또는 배열. 이 툴을 실행하는 claude 명령을 알아볼 정규식.
  // 배열이면 여러 CLI/명령을 한 툴로 묶는다.
  "detect": ["sf-headless\\.mjs", "sprite-batch"],

  "outDirName": "_out",         // (선택, 기본 _out) 결과물 하위 폴더명 — 썸네일 스캔에 사용

  // modes: (선택) 이 툴이 뭘 하는지 설명(카드에 "기능"으로 표시). 실행에는 쓰이지 않음.
  "modes": [
    { "id": "upscale", "label": "업스케일", "desc": "AI로 확대", "icon": "⤢" },
    { "id": "bgremove", "label": "배경 제거", "desc": "투명 PNG로", "icon": "✂" }
  ]
}
```

## 동작 방식 (Fleet 쪽)

- 검증·파싱: `src/lib/tools.ts`의 `parseToolManifest` (문제가 있으면 한국어 메시지로 거부)
- 감지: `detectToolUse`가 claude의 Bash/Skill 명령을 `detect`(단일/배열)와 대조 → 라이브 노드
- 노드 유지: 세션 턴이 끝나도 노드는 남고(✕로 수동 삭제, 터미널 종료 시 자동 정리),
  세션이 idle이 되면 입력 폴더/`outDirName`을 best-effort 스캔해 before→after 썸네일 표시
  (입력 폴더는 명령에서 `--tool` 앞 토큰 등으로 추정 — hook detail이 140자로 잘리면 실패 가능)
- 저장: `FleetConfig.customTools[id]`(원본 JSON) + `toolRoots[id]`(폴더 경로)
- 같은 `id`의 내장 매니페스트가 있으면 연결한 fleet-tool.json이 우선한다

내장 툴(코드로 추가)은 `src/lib/tools.ts`의 `TOOL_MANIFESTS`에 등록한다.
