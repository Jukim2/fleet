// Read/clear the AI preset generator's output file (<cwd>/.fleet/preset.json),
// plus the prompt we hand the generator Claude.
import { invoke } from "@tauri-apps/api/core";

export const readPreset = (cwd: string) => invoke<string | null>("read_preset", { cwd });
export const clearPreset = (cwd: string) => invoke<void>("clear_preset", { cwd });

/** Shape the generator writes to .fleet/preset.json. */
export type GeneratedPreset = { command?: string; prompt?: string };

/**
 * Prompt for the generator Claude: given a natural-language description, inspect
 * THIS project's repo and produce the concrete body — a shell `command` for code
 * presets, or a ready-to-send `prompt` for ai presets — tuned to this project.
 * It must only inspect + write the file, nothing else.
 */
export function presetGenPrompt(kind: "code" | "ai", name: string, description: string): string {
  const target =
    kind === "code"
      ? '이 프로젝트에서 그 동작을 수행하는 셸 명령 한 줄(또는 && 로 이은 한 줄)을 "command" 에 적으세요. 패키지 매니저/스크립트/실행 방식은 레포를 보고 이 프로젝트에 맞게 정하세요 (예: package.json scripts, Cargo.toml, Makefile 등).'
      : '이 프로젝트에서 그 작업을 수행할 Claude Code 세션에게 줄 구체적 지시문을 "prompt" 에 적으세요. 이 프로젝트의 구조/관례에 맞춘 실행 가능한 지시여야 합니다.';
  return [
    "당신은 '프리셋 생성기'입니다. 실제로 작업을 수행하지 말고, 아래 요청에 맞는 내용을 만들어 파일로만 저장하세요.",
    "먼저 이 프로젝트의 레포(설정/스크립트/구조)를 살펴보세요.",
    `프리셋 이름: ${name}`,
    `프리셋 종류: ${kind === "code" ? "코드(셸 명령)" : "AI(프롬프트)"}`,
    `요청: ${description}`,
    target,
    "결과를 아래 JSON 스키마로 ./.fleet/preset.json 파일에만 저장하세요 (폴더 없으면 생성). 해당 종류의 필드만 채우고, 그 외 출력/구현/설명 금지.",
    "",
    "{",
    kind === "code" ? '  "command": "<셸 명령>"' : '  "prompt": "<지시문>"',
    "}",
  ].join("\n");
}
