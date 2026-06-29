# 개발 셋업 스크립트

이 repo를 클론해서 **직접 빌드/실행하려는 개발자용** 스크립트입니다.
필요한 도구(Node·Rust)를 감지해, 없으면 **설치 전에 물어본 뒤** 설치하고,
`npm install` 후 앱을 실행합니다.

> ⚠️ 최종 사용자(앱만 쓰는 사람)는 이 스크립트가 필요 없습니다. `build`로 만든
> `.msi`/`.dmg`만 설치하면 됩니다 — 앱은 이미 컴파일된 네이티브 실행파일이라
> Rust·Node가 전혀 필요 없어요.

## 폴더

```
scripts/
  macos/setup.sh      # macOS / Linux
  windows/setup.ps1   # Windows
```

두 스크립트 모두 어디서 실행하든 **프로젝트 루트로 이동**한 뒤 동작합니다.

## 사용법

### macOS / Linux

```bash
./scripts/macos/setup.sh          # 의존성 설치 후 dev 실행 (기본)
./scripts/macos/setup.sh build    # 배포 번들(.dmg/.app) 생성
./scripts/macos/setup.sh install  # 의존성만 설치, 실행 안 함
./scripts/macos/setup.sh build -y # 확인 프롬프트 없이(assume yes)
```

처음이면 실행 권한을 한 번 부여하세요: `chmod +x scripts/macos/setup.sh`

### Windows (PowerShell)

```powershell
.\scripts\windows\setup.ps1            # 의존성 설치 후 dev 실행 (기본)
.\scripts\windows\setup.ps1 build      # 배포 번들(.msi/.exe) 생성
.\scripts\windows\setup.ps1 install    # 의존성만 설치, 실행 안 함
.\scripts\windows\setup.ps1 -Yes       # 확인 프롬프트 없이(assume yes)

# 실행정책에 막히면:
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
```

## 인자

| 인자 | 동작 |
|---|---|
| (없음) / `dev` | 의존성 설치 후 `npm run tauri dev` — 앱 창이 뜨고 핫리로드 |
| `build` | 의존성 설치 후 `npm run tauri build` — 배포용 설치파일 생성 |
| `install` | 의존성만 설치하고 실행하지 않음 |
| `-y` (sh) / `-Yes` (ps1) | 설치 확인 프롬프트를 건너뜀 (자동화/CI용) |

## 동작 순서

1. **도구 확인** — Node, Rust 유무 검사 (이미 있으면 버전만 출력하고 통과)
2. **설치 확인** — 없는 도구마다 `Install it now? [Y/n]` 질문. Enter/`y`=설치, `n`=중단 후 종료
3. **플랫폼 의존성**
   - macOS: Xcode Command Line Tools, (Node 설치가 필요하면) Homebrew
   - Windows: winget으로 Node·Rust 설치, **MSVC C++ 빌드툴** 확인(없으면 설치 명령 안내 후 종료)
4. **`npm install`** — `node_modules`가 없을 때만
5. **실행** — 인자에 따라 dev / build / (없음)

## 알아둘 점

- **Windows에서 Rust 설치 직후**: winget이 깐 `cargo`가 현재 세션 PATH에 안 잡힐 수
  있습니다. 그 경우 "새 터미널에서 다시 실행하라"는 안내가 뜨니, 터미널을 새로 열고
  스크립트를 한 번 더 실행하세요.
- **MSVC C++ 빌드툴**은 Windows에서 Rust가 링크할 때 필요합니다. 없으면 스크립트가
  설치용 winget 명령을 출력합니다.
- **첫 빌드는 5~15분** 정도 걸립니다 (Rust 크레이트 전체 컴파일). 이후로는 캐시되어
  빨라집니다.
- 스크립트는 ASCII만 사용합니다 — Windows PowerShell 5.1이 BOM 없는 파일을
  비ASCII 문자에서 잘못 디코딩해 깨지는 문제를 피하기 위함입니다.
