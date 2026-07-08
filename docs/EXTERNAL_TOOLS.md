# 외부 툴 연결 정책 (fleet-tool.json)

Fleet은 CLI가 있는 외부 툴을 GUI로 감싸 커맨드센터(라이브 캔버스)에서 구동한다.
툴이 아래 계약만 지키면 **코드 수정 없이** 폴더 연결만으로 붙는다:
라이브 캔버스 왼쪽 하단 **`＋ 툴 연결`** → 툴 루트 폴더 선택 → 루트의
`fleet-tool.json`을 읽어 검증·저장한다.

## 툴이 지켜야 하는 것 (정책)

1. **비대화형 CLI 하나.** `프로그램 [고정 인자…] <입력 폴더> --tool <모드> [--옵션 값…]`
   형태로 실행 가능해야 하고, 도중에 사용자 입력을 기다리면 안 된다.
2. **옵션은 유한 열거형.** 모든 옵션이 플래그로 표현되고, 선택지는 매니페스트에
   나열할 수 있어야 한다 (자유 문자열·숫자·불리언·색상도 가능).
3. **원본 불변, 결과는 예측 가능한 위치.** 입력 폴더를 수정하지 않고, 결과물을
   `<입력 폴더>/<outDirName>` (기본 `_out`) 아래에 쓴다. Fleet은 잡 시작 시각
   이후 생성된 이미지(png/webp/gif/svg/jpg)를 그 폴더에서 스캔해 결과 그리드로 보여준다.
4. **종료 코드.** 성공 0, 실패 비-0. 중단은 프로세스 kill로 처리된다.
5. **(권장) 진행 로그 컨벤션.** 지키면 진행률 바가 정확해지고, 안 지켜도
   동작은 한다(인디케이터만 표시):
   - 시작 시 총 개수: `… — 12 file(s)` (`— N ` 패턴)
   - 항목 성공: `[3/12] name.png ... done …` (`[i/N]` + `done`)
   - 항목 실패: `[4/12] bad.png ... FAILED — reason`

## fleet-tool.json 스키마

툴 루트에 커밋한다. 참조 구현: SpriteForge의 `fleet-tool.json`.

```jsonc
{
  "id": "spriteforge",          // 소문자·숫자·하이픈. 전역 고유
  "name": "SpriteForge",        // UI 표시명
  "program": "node",            // 실행 파일 (PATH에서 해석)
  "scriptArgs": ["scripts/sf-headless.mjs"],  // 입력 폴더 앞에 붙는 고정 인자 (툴 루트 기준 상대경로)
  "detect": "sf-headless\\.mjs|sprite-batch", // (선택) claude 세션의 Bash 명령에서 이 툴을 감지할 정규식
  "outDirName": "_out",         // (선택, 기본 _out) 결과물 하위 폴더명
  "modes": [                    // 1개 이상. --tool <id>로 전달됨
    {
      "id": "upscale",
      "label": "업스케일",       // UI 라벨 (한국어)
      "desc": "AI로 확대",
      "icon": "⤢",
      "options": [
        {
          "key": "scale",       // 폼 필드 키
          "flag": "--scale",    // CLI 플래그
          "kind": "value",      // value = "--flag 값" | flag = true일 때 플래그만 | negFlag = false일 때 플래그만
          "type": "select",     // select | number | text | bool | color
          "label": "배율",
          "choices": ["2", "3", "4"],   // select 필수
          "default": "4",
          "optional": true      // (선택) 값이 비어있으면 플래그 자체를 생략
          // number엔 min/max/step, 설명은 hint
        }
      ]
    }
  ]
}
```

최종 argv는 `program scriptArgs… <입력폴더> --tool <모드id> <옵션들…> --out <outDirName>`,
작업 디렉토리는 **툴 루트**다.

## 동작 방식 (Fleet 쪽)

- 검증·파싱: `src/lib/tools.ts`의 `parseToolManifest` (문제가 있으면 한국어 메시지로 거부)
- 저장: `FleetConfig.customTools[id]`(원본 JSON) + `toolRoots[id]`(폴더 경로)
- 실행: `src-tauri/src/tools.rs`가 프로세스를 spawn하고 stdout/stderr를
  `tool-job-output` 이벤트로 스트리밍, 종료 시 `tool-job-exit`
- 감지: claude 세션의 PreToolUse(Bash) 명령이 `detect`에 걸리면 라이브 캔버스의
  해당 세션 노드에 툴 노드가 매달림
- 같은 `id`의 내장 매니페스트가 있으면 연결한 fleet-tool.json이 우선한다

내장 툴(코드로 추가하는 경우)은 `src/lib/tools.ts`의 `TOOL_MANIFESTS`에
TypeScript 매니페스트를 등록한다 — 스키마는 위와 동일.
